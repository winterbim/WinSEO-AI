import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createHttpFetcher,
  normalizeUrl,
  parseRobotsTxt,
  type FetchResult,
  type NormalizedUrl,
} from "@serpvera/crawler/audit-core";
import {
  auditSite,
  boundedRequestDelayMs,
  createSiteAuditRedirectPolicy,
  siteAuditRedirectBlockReason,
} from "./site-audit.ts";

const ORIGIN = "https://site-fixture.example";
const SITEMAP = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${ORIGIN}/catalog/a</loc></url>
  <url><loc>${ORIGIN}/private/secret</loc></url>
  <url><loc>https://outside-fixture.example/steal</loc></url>
</urlset>`;

function response(
  url: NormalizedUrl,
  body: string,
  status = 200,
  contentType = "text/html; charset=utf-8",
): FetchResult {
  return {
    url,
    finalUrl: url.normalized,
    httpStatus: status,
    headers: { "content-type": contentType },
    body,
    contentHash: createHash("sha256").update(body).digest("hex"),
    redirectChain: [],
    fetchDurationMs: 1,
  };
}

function fixtureFetcher(requested: string[]) {
  const pages = new Map<string, { body: string; type?: string; status?: number }>([
    [
      "/robots.txt",
      {
        body: "User-agent: *\nDisallow: /private\nSitemap: https://site-fixture.example/sitemap.xml\nCrawl-delay: 2",
        type: "text/plain",
      },
    ],
    ["/sitemap.xml", { body: SITEMAP, type: "application/xml" }],
    [
      "/",
      {
        body: '<html lang="en"><head></head><body><a href="/about">About</a><a href="https://outside-fixture.example/">Outside</a></body></html>',
      },
    ],
    ["/catalog/a", { body: '<html lang="en"><body><h1>Catalog item</h1></body></html>' }],
    ["/about", { body: '<html lang="en"><body><h1>About</h1></body></html>' }],
  ]);
  return (url: NormalizedUrl): Promise<FetchResult> => {
    requested.push(url.normalized);
    const parsed = new URL(url.normalized);
    const fixture = pages.get(parsed.pathname);
    if (!fixture) return Promise.resolve(response(url, "", 404, "text/plain"));
    return Promise.resolve(
      response(
        url,
        fixture.body,
        fixture.status ?? 200,
        fixture.type ?? "text/html; charset=utf-8",
      ),
    );
  };
}

void describe("bounded project site audit", () => {
  void it("uses sitemap and internal links while refusing disallowed and external URLs", async () => {
    const requested: string[] = [];
    const delays: number[] = [];
    const result = await auditSite(ORIGIN, "site-audit-fixture", {
      fetchPage: fixtureFetcher(requested),
      sleep: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.pagesCrawled, 3);
    assert.equal(result.pagesFailed, 0);
    assert.deepEqual(
      requested.map((url) => new URL(url).pathname),
      ["/robots.txt", "/sitemap.xml", "/", "/catalog/a", "/about"],
    );
    assert.ok(requested.every((url) => new URL(url).origin === ORIGIN));
    assert.ok(!requested.some((url) => url.includes("/private/")));
    assert.equal(result.evidence.length, 3);
    assert.deepEqual(
      result.evidence.map((item) => item.sourceRef),
      [`${ORIGIN}/`, `${ORIGIN}/catalog/a`, `${ORIGIN}/about`],
    );
    assert.ok(result.findings.some((finding) => finding.affectedUrls[0] === `${ORIGIN}/catalog/a`));
    assert.equal(delays.length, 4);
    assert.ok(delays.every((delay) => delay > 0));
  });

  void it("stops before pages when robots.txt is unavailable instead of guessing access", async () => {
    const requested: string[] = [];
    const fetchPage = (url: NormalizedUrl): Promise<FetchResult> => {
      requested.push(url.normalized);
      return Promise.resolve(response(url, "upstream unavailable", 503, "text/plain"));
    };

    const result = await auditSite(ORIGIN, "robots-fail-closed", { fetchPage });

    assert.equal(result.status, "failed");
    assert.equal(result.stopReason, "robots_unavailable");
    assert.equal(requested.length, 1);
    assert.equal(new URL(requested[0] ?? "https://invalid").pathname, "/robots.txt");
  });

  void it("obeys the page cap even when links and sitemap advertise more URLs", async () => {
    const requested: string[] = [];
    const result = await auditSite(ORIGIN, "site-audit-page-cap", {
      maxPages: 2,
      fetchPage: fixtureFetcher(requested),
      sleep: () => Promise.resolve(),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.pageLimit, 2);
    assert.equal(result.pagesCrawled, 2);
    assert.equal(result.stopReason, "page_limit");
    assert.ok(!requested.some((url) => new URL(url).pathname === "/about"));
  });

  void it("refuses same-origin redirects into robots-disallowed paths", () => {
    const rules = parseRobotsTxt("User-agent: SERPVERA-Crawler/0.1\nDisallow: /private");
    assert.equal(
      siteAuditRedirectBlockReason(ORIGIN, `${ORIGIN}/private/page`, rules, true),
      "destination is disallowed by robots.txt",
    );
    assert.equal(siteAuditRedirectBlockReason(ORIGIN, `${ORIGIN}/public`, rules, true), null);
    assert.equal(
      siteAuditRedirectBlockReason(ORIGIN, "https://outside.example/", rules, true),
      "destination leaves audited origin",
    );
  });

  void it("does not request a robots-disallowed redirect destination", async () => {
    const requested: string[] = [];
    const robotsRules = parseRobotsTxt("User-agent: SERPVERA-Crawler/0.1\nDisallow: /private");
    const fetcher = createHttpFetcher({
      traceId: "site-audit-robots-redirect",
      timeoutMs: 3_000,
      maxResponseSizeBytes: 1024,
      userAgent: "SERPVERA-Crawler/0.1",
      acceptLanguage: "en",
      resolve: () => Promise.resolve(["93.184.216.34"]),
      allowRedirect: createSiteAuditRedirectPolicy(
        ORIGIN,
        () => robotsRules,
        () => true,
      ),
      fetchImpl: (input) => {
        const requestedUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requested.push(requestedUrl);
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: `${ORIGIN}/private/page` },
          }),
        );
      },
    });

    const result = await fetcher.fetchPage(normalizeUrl(`${ORIGIN}/public`));

    assert.match(result.error ?? "", /disallowed by robots\.txt/i);
    assert.equal(result.httpStatus, 302);
    assert.deepEqual(requested, [`${ORIGIN}/public`]);
  });

  void it("allows same-origin canonical redirects for robots.txt but rejects external ones", () => {
    const policy = createSiteAuditRedirectPolicy(
      ORIGIN,
      () => parseRobotsTxt(""),
      () => false,
    );
    assert.equal(policy(`${ORIGIN}/robots.txt`, `${ORIGIN}/new-robots.txt`), true);
    assert.match(
      String(policy(`${ORIGIN}/robots.txt`, "https://outside.example/robots.txt")),
      /origin/i,
    );
  });

  void it("caps crawl-delay waiting at the remaining wall-clock budget", () => {
    assert.equal(boundedRequestDelayMs(0, 300_000, 250_000, 60_000, 290_000), 10_000);
    assert.equal(boundedRequestDelayMs(0, 300_000, 50_000, 60_000, 300_000), null);
  });

  void it("deduplicates the root URL against sitemap seeds before applying the page cap", async () => {
    const requested: string[] = [];
    const fetchPage = (url: NormalizedUrl): Promise<FetchResult> => {
      requested.push(url.normalized);
      const path = new URL(url.normalized).pathname;
      if (path === "/robots.txt") {
        return Promise.resolve(response(url, "User-agent: *", 200, "text/plain"));
      }
      if (path === "/sitemap.xml") {
        return Promise.resolve(
          response(
            url,
            `<urlset><url><loc>${ORIGIN}/</loc></url></urlset>`,
            200,
            "application/xml",
          ),
        );
      }
      return Promise.resolve(response(url, "<html><body><h1>Home</h1></body></html>"));
    };

    const result = await auditSite(ORIGIN, "site-audit-root-sitemap-dedupe", {
      maxPages: 1,
      fetchPage,
      sleep: () => Promise.resolve(),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.pagesCrawled, 1);
    assert.equal(result.stopReason, undefined);
    assert.equal(requested.filter((url) => new URL(url).pathname === "/").length, 1);
  });

  void it("fails closed when the submitted page is disallowed", async () => {
    const requested: string[] = [];
    const result = await auditSite(`${ORIGIN}/private/secret`, "site-audit-robots-block", {
      fetchPage: fixtureFetcher(requested),
      sleep: () => Promise.resolve(),
    });

    assert.equal(result.status, "failed");
    assert.equal(result.stopReason, "robots_blocked");
    assert.equal(result.pagesCrawled, 0);
    assert.ok(!requested.some((url) => new URL(url).pathname === "/private/secret"));
  });
});
