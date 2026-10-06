import { createHash } from "node:crypto";
import type { WordPressFetch, WordPressPatchTarget } from "./wordpress-adapter.ts";
import { WordPressRestAdapter } from "./wordpress-adapter.ts";
import type { FixturePageAdapter } from "./workflow.ts";

export const WORDPRESS_FIXTURE_URL = "https://wp.fixture.test/guide";
export const WORDPRESS_FIXTURE_MEDIA_TARGET: WordPressPatchTarget = {
  kind: "media",
  id: 7,
  field: "alt_text",
};
export const WORDPRESS_FIXTURE_TITLE_TARGET: WordPressPatchTarget = {
  kind: "post_meta",
  postType: "pages",
  id: 12,
  metaKey: "seo_title",
};
export const WORDPRESS_FIXTURE_TARGETS = [
  WORDPRESS_FIXTURE_MEDIA_TARGET,
  WORDPRESS_FIXTURE_TITLE_TARGET,
] satisfies WordPressPatchTarget[];

const WORDPRESS_SITE_TEMPLATE =
  '<!doctype html><html lang="en"><head><title>{{seo_title}}</title><link rel="canonical" href="https://wp.fixture.test/guide"></head><body><main><h1>Ceramic dripper brewing guide</h1><p>Ceramic dripper brewing guide for home kitchens.</p><img id="hero" src="/dripper.jpg" alt="{{image_alt}}"></main></body></html>';

export interface WordPressSimulatorState {
  mediaAlt: string;
  seoTitle: string;
  readonly requests: { method: string; path: string; authorized: boolean }[];
}

/** In-process WordPress REST simulator. It never opens a socket or contacts a site. */
export function createWordPressRestSimulator(
  initial: { mediaAlt?: string; seoTitle?: string } = {},
): { fetcher: WordPressFetch; state: WordPressSimulatorState } {
  const state: WordPressSimulatorState = {
    mediaAlt: initial.mediaAlt ?? "",
    seoTitle: initial.seoTitle ?? "Coffee brewing",
    requests: [],
  };

  const fetcher: WordPressFetch = (input, init) => {
    const url = new URL(input);
    const path = url.pathname;
    const authorized =
      init.headers.authorization ===
      `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`;
    state.requests.push({ method: init.method, path, authorized });
    if (!authorized) return Promise.resolve(jsonResponse({ code: "rest_not_logged_in" }, 401));

    if (path === "/wp-json/wp/v2/media/7") {
      if (init.method === "OPTIONS") return Promise.resolve(jsonResponse({ properties: {} }));
      if (init.method === "POST") {
        const body = parseBody(init.body);
        if (typeof body.alt_text !== "string")
          return Promise.resolve(jsonResponse({ code: "rest_invalid_param" }, 400));
        state.mediaAlt = body.alt_text;
      }
      return Promise.resolve(jsonResponse({ id: 7, alt_text: state.mediaAlt }));
    }

    if (path === "/wp-json/wp/v2/pages/12") {
      if (init.method === "OPTIONS") {
        return Promise.resolve(
          jsonResponse({
            properties: {
              meta: {
                properties: {
                  seo_title: { type: "string", context: ["view", "edit"] },
                },
              },
            },
          }),
        );
      }
      if (init.method === "POST") {
        const body = parseBody(init.body);
        const meta = body.meta;
        if (
          !meta ||
          typeof meta !== "object" ||
          typeof Reflect.get(meta, "seo_title") !== "string"
        ) {
          return Promise.resolve(jsonResponse({ code: "rest_invalid_param" }, 400));
        }
        state.seoTitle = Reflect.get(meta, "seo_title") as string;
      }
      return Promise.resolve(jsonResponse({ id: 12, meta: { seo_title: state.seoTitle } }));
    }

    return Promise.resolve(jsonResponse({ code: "rest_no_route" }, 404));
  };

  return { fetcher, state };
}

/** Page view backed by WordPress REST fields; user-agent and render-mode never change output. */
export class WordPressFixturePageAdapter implements FixturePageAdapter {
  readonly kind = "fixture" as const;
  readonly #wordpress: WordPressRestAdapter;
  readonly #url: string;
  readonly #clock: () => Date;
  readonly #idempotency = new Map<string, string>();

  constructor(
    wordpress: WordPressRestAdapter,
    url = WORDPRESS_FIXTURE_URL,
    clock: () => Date = () => new Date(),
  ) {
    this.#wordpress = wordpress;
    this.#url = url;
    this.#clock = clock;
  }

  async read(url: string, _userAgent: "browser" | "googlebot", _mode: "raw" | "rendered") {
    if (url !== this.#url) return notFound(this.#clock());
    const [alt, title] = await Promise.all([
      this.#wordpress.read(WORDPRESS_FIXTURE_MEDIA_TARGET),
      this.#wordpress.read(WORDPRESS_FIXTURE_TITLE_TARGET),
    ]);
    const html = WORDPRESS_SITE_TEMPLATE.replace("{{image_alt}}", escapeHtml(alt.value)).replace(
      "{{seo_title}}",
      escapeHtml(title.value),
    );
    return {
      status: 200,
      contentType: "text/html; charset=utf-8",
      html,
      observedAt: this.#clock().toISOString(),
    };
  }

  async write(url: string, html: string, expectedHash: string, idempotencyKey: string) {
    if (url !== this.#url) throw new Error("WordPress fixture URL is out of scope.");
    const requestedHash = sha256(html);
    const prior = this.#idempotency.get(idempotencyKey);
    if (prior) {
      if (prior !== requestedHash)
        throw new Error("Idempotency key was reused with different content.");
      return { contentHash: prior, idempotentReplay: true };
    }

    const current = await this.read(url, "browser", "raw");
    const currentHash = sha256(current.html);
    if (currentHash === requestedHash) {
      this.#idempotency.set(idempotencyKey, requestedHash);
      return { contentHash: requestedHash, idempotentReplay: true };
    }
    if (currentHash !== expectedHash)
      throw new Error("WordPress fixture source changed before write.");

    const currentAlt = await this.#wordpress.read(WORDPRESS_FIXTURE_MEDIA_TARGET);
    const currentTitle = await this.#wordpress.read(WORDPRESS_FIXTURE_TITLE_TARGET);
    const nextAlt = readImageAlt(html);
    const nextTitle = readTitle(html);
    const altChanged = nextAlt !== currentAlt.value;
    const titleChanged = nextTitle !== currentTitle.value;
    if (altChanged === titleChanged)
      throw new Error("A fixture write must change exactly one mapped SEO field.");

    const expectedHtml = WORDPRESS_SITE_TEMPLATE.replace(
      "{{image_alt}}",
      escapeHtml(altChanged ? nextAlt : currentAlt.value),
    ).replace("{{seo_title}}", escapeHtml(titleChanged ? nextTitle : currentTitle.value));
    if (expectedHtml !== html)
      throw new Error("WordPress fixture write contains an unmapped page change.");

    if (altChanged)
      await this.#wordpress.apply(WORDPRESS_FIXTURE_MEDIA_TARGET, currentAlt.hash, nextAlt);
    else await this.#wordpress.apply(WORDPRESS_FIXTURE_TITLE_TARGET, currentTitle.hash, nextTitle);

    const observed = await this.read(url, "browser", "raw");
    if (sha256(observed.html) !== requestedHash)
      throw new Error("WordPress fixture write was not observed in the page view.");
    this.#idempotency.set(idempotencyKey, requestedHash);
    return { contentHash: requestedHash, idempotentReplay: false };
  }

  pageUrls(): string[] {
    return [this.#url];
  }
}

export function createWordPressFixture(
  clock: () => Date = () => new Date(),
  initial: { mediaAlt?: string; seoTitle?: string } = {},
) {
  const simulator = createWordPressRestSimulator(initial);
  const wordpress = new WordPressRestAdapter(
    {
      siteUrl: "https://wp.fixture.test",
      username: "fixture-user",
      applicationPassword: "fixture-password",
    },
    simulator.fetcher,
    clock,
  );
  const page = new WordPressFixturePageAdapter(wordpress, WORDPRESS_FIXTURE_URL, clock);
  return { page, wordpress, simulator: simulator.state };
}

function parseBody(body: string | undefined): Record<string, unknown> {
  if (!body) return {};
  const value: unknown = JSON.parse(body);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonResponse(value: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(value),
  };
}

function notFound(at: Date) {
  return {
    status: 404,
    contentType: "text/html; charset=utf-8",
    html: "",
    observedAt: at.toISOString(),
  };
}

function readImageAlt(html: string): string {
  const tags = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  const targeted = tags.filter((tag) => /\bid\s*=\s*(?:"hero"|'hero'|hero(?:\s|>|\/))/i.test(tag));
  if (targeted.length !== 1) throw new Error("Expected exactly one fixture hero image.");
  const hero = targeted[0];
  if (!hero) throw new Error("Expected exactly one fixture hero image.");
  const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(hero);
  return decodeHtml(alt?.[1] ?? alt?.[2] ?? alt?.[3] ?? "");
}

function readTitle(html: string): string {
  const matches = [...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)];
  if (matches.length !== 1) throw new Error("Expected exactly one fixture page title.");
  const title = matches[0];
  if (!title) throw new Error("Expected exactly one fixture page title.");
  return decodeHtml(title[1] ?? "");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
