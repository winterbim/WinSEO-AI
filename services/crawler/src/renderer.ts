// ─── Rendered escalation worker (PHASE-3-RENDER) ───
// Playwright/Chromium isolation per Blueprint §12.4 pass 2:
//   - per-page timeout (hard cap on navigation + settle)
//   - bounded concurrency (module-level semaphore; env RENDER_MAX_CONCURRENCY)
//   - fresh browser context per render (no cookies, no storage, no credentials)
//   - SSRF revalidation BEFORE launch AND for EVERY in-page request (route
//     interception covers redirects, subresources and XHR alike)
//   - resource budget: images/media/fonts are aborted (DOM fidelity does not
//     need them; they are the main cost driver)
//   - captured DOM returned as text + SHA-256 for evidence persistence
//
// Browser strategy: system Chrome (`channel: chrome`) by default because the
// Playwright headless-shell download is not available in every environment;
// override with RENDERER_CHANNEL or RENDERER_EXECUTABLE_PATH.

import { createHash } from "node:crypto";
import { guardUrl } from "./ssrf-guard.ts";

export interface RenderOptions {
  /** Hard navigation timeout (ms). Default 20000. */
  timeoutMs?: number;
  /** Settle time after domcontentloaded so late JS can run. Default 750ms. */
  settleMs?: number;
  /** TEST-ONLY: fulfil all requests with this HTML instead of hitting the
   *  network (route interception). Never set in production code paths. */
  routeFulfillHtml?: string;
}

export type RenderResult =
  | {
      ok: true;
      dom: string;
      sha256: string;
      bytes: number;
      durationMs: number;
    }
  | { ok: false; error: string; durationMs: number };

// ─── Concurrency semaphore (bounded browser workload) ───
const MAX_CONCURRENT = Math.max(
  1,
  parseInt(process.env.RENDER_MAX_CONCURRENCY ?? "2", 10) || 2,
);
let active = 0;
const queue: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  // Wait for a slot TRANSFER (release hands its slot to the next waiter
  // without decrementing first) — otherwise a new arrival could grab the
  // freed slot before the waiter resumes and active would overshoot.
  await new Promise<void>((resolve) => queue.push(resolve));
}

function release(): void {
  const next = queue.shift();
  if (next) {
    next(); // slot transfers to the waiter; active unchanged
  } else {
    active--;
  }
}

/** TEST HOOK: current/limit concurrency (unit tests assert the bound). */
export function concurrencyState(): { active: number; limit: number } {
  return { active, limit: MAX_CONCURRENT };
}

// ─── Browser lifecycle: ONE isolated browser per render ───
// Deliberately NOT a singleton: fire-and-forget scan workers can still be
// rendering after their suite/teardown finished — a shared browser would then
// keep the process alive forever (observed as hung test runs). Launch+close
// per render costs a few hundred ms (renders are escalation-only, quota'd) and
// is strictly stronger isolation for a worker that must hold no state.
type Browser = Awaited<ReturnType<typeof import("playwright").chromium.launch>>;
const liveBrowsers = new Set<Browser>();

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  const executablePath = process.env.RENDERER_EXECUTABLE_PATH;
  const channel = process.env.RENDERER_CHANNEL ?? "chrome";
  const browser = await chromium.launch(
    executablePath
      ? { executablePath, headless: true }
      : { channel, headless: true },
  );
  liveBrowsers.add(browser);
  return browser;
}

async function destroyBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) return;
  liveBrowsers.delete(browser);
  await browser.close().catch(() => undefined);
}

/** Force-close any browser left behind (test teardown / graceful shutdown). */
export async function closeRenderer(): Promise<void> {
  for (const b of [...liveBrowsers]) {
    await destroyBrowser(b);
  }
}

/**
 * Render a URL and return the resulting DOM.
 * Security: guardUrl runs before launch AND on every routed request.
 * NOTE (documented limitation): the browser resolves DNS itself, so the
 * pre-navigation IP check cannot pin the socket (same TOCTOU as L-024) —
 * egress isolation remains the production control. The route guard still
 * blocks every request whose URL names a private target (incl. redirect hops).
 */
export async function renderUrl(url: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const settleMs = opts.settleMs ?? 750;

  // ── SSRF revalidation BEFORE any browser work ──
  try {
    guardUrl(url);
  } catch (err) {
    return { ok: false, error: `pre-navigation SSRF: ${(err as Error).message}`, durationMs: Date.now() - started };
  }

  await acquire();
  let browser: Browser | undefined;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      javaScriptEnabled: true,
      // Isolation: fresh context = no cookies/storage/credentials carried in.
    });

    // ── SSRF + resource budget for EVERY request the page makes ──
    await context.route("**/*", async (route) => {
      const reqUrl = route.request().url();
      // data:/blob: never touch the network — no SSRF surface, pass through.
      if (reqUrl.startsWith("data:") || reqUrl.startsWith("blob:")) {
        await route.continue().catch(() => undefined);
        return;
      }
      try {
        guardUrl(reqUrl);
      } catch {
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      const kind = route.request().resourceType();
      if (kind === "image" || kind === "media" || kind === "font") {
        // Resource budget: DOM capture does not need these.
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      if (opts.routeFulfillHtml !== undefined) {
        // TEST-ONLY fixture: never touches the network.
        await route
          .fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: opts.routeFulfillHtml })
          .catch(() => undefined);
        return;
      }
      await route.continue().catch(() => undefined);
    });

    try {
      const page = await context.newPage();
      await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      // Settle: allow late synchronous JS to mutate the DOM before capture.
      await page.waitForTimeout(settleMs);
      const dom = await page.content();
      return {
        ok: true,
        dom,
        sha256: createHash("sha256").update(dom).digest("hex"),
        bytes: Buffer.byteLength(dom, "utf-8"),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message.split("\n")[0] ?? "render failed",
        durationMs: Date.now() - started,
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  } catch (err) {
    return {
      ok: false,
      error: `browser unavailable: ${(err as Error).message.split("\n")[0]}`,
      durationMs: Date.now() - started,
    };
  } finally {
    await destroyBrowser(browser);
    release();
  }
}