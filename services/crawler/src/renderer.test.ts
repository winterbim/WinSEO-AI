// ─── Renderer tests — REAL browser (system Chrome, channel: "chrome") ───
// Network is fully intercepted (routeFulfillHtml, TEST-ONLY hook), so these
// tests exercise the real Playwright pipeline — launch, context isolation,
// route guard, JS execution, DOM capture — without depending on any site.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { renderUrl, closeRenderer, concurrencyState } from "./renderer.ts";

const FIXTURE = `<!DOCTYPE html><html><head><title>Static Source Title</title></head>
<body><div id="app"></div>
<script>
  // Simulates an SPA hydrating its content client-side.
  document.title = "Runtime Rendered Title";
  var link = document.createElement("link");
  link.setAttribute("rel", "canonical");
  link.setAttribute("href", "https://render-fixture.test/page");
  document.head.appendChild(link);
  var h1 = document.createElement("h1");
  h1.textContent = "Client Injected Heading";
  document.body.appendChild(h1);
</script></body></html>`;

void describe("renderer (real Chromium)", () => {
  after(async () => {
    await closeRenderer();
  });

  void it("captures a rendered DOM with client-side mutations applied", async () => {
    const result = await renderUrl("https://render-fixture.test/page", {
      routeFulfillHtml: FIXTURE,
      settleMs: 300,
    });
    assert.ok(result.ok, `render failed: ${result.ok ? "" : result.error}`);
    // node:assert's `asserts` narrowing above makes the union `ok: true` here,
    // so no extra guard is needed (nor legal) before touching result.dom.

    // JS executed for real: title/canonical/H1 are the RUNTIME values.
    assert.match(result.dom, /Runtime Rendered Title/);
    assert.match(result.dom, /rel="canonical"/);
    assert.match(result.dom, /render-fixture\.test\/page/);
    assert.match(result.dom, /Client Injected Heading/);
    // Evidence-grade capture: verifiable hash + byte size.
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    assert.ok(result.bytes > 0);
    assert.ok(result.durationMs >= 0);
  });

  void it("rejects private targets BEFORE any browser work (SSRF)", async () => {
    const result = await renderUrl("http://127.0.0.1:8080/admin", {
      routeFulfillHtml: FIXTURE,
    });
    assert.equal(result.ok, false, "loopback render must be refused");
    // Narrowed to the failure variant by the assertion above.
    assert.match(result.error, /SSRF/);
  });

  void it("bounds concurrency to RENDER_MAX_CONCURRENCY (semaphore, no leak)", async () => {
    const limit = concurrencyState().limit;
    assert.ok(limit >= 1, "limit must be at least 1");

    const observed: number[] = [];
    const sampler = setInterval(() => {
      observed.push(concurrencyState().active);
    }, 15);

    const tasks = Array.from({ length: Math.max(4, limit + 2) }, () =>
      renderUrl("https://render-fixture.test/concurrency", {
        routeFulfillHtml: FIXTURE,
        settleMs: 250,
      }),
    );
    const results = await Promise.all(tasks);
    clearInterval(sampler);

    for (const r of results) {
      assert.ok(r.ok, `all renders should succeed: ${r.ok ? "" : r.error}`);
    }
    // The sampled concurrency must never exceed the configured limit...
    assert.ok(
      observed.every((n) => n <= limit),
      `observed active=${observed.join(",")} exceeds limit=${limit}`,
    );
    // ...and after all tasks the semaphore must be fully released.
    assert.equal(concurrencyState().active, 0, "semaphore must return to 0 after all renders");
  });
});
