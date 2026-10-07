import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCrawlDelay, isUrlAllowed, parseRobotsTxt, parseSitemapXml } from "./sitemap-parser.ts";

void describe("sitemap-parser", () => {
  void describe("parseRobotsTxt", () => {
    void it("parses basic robots.txt", () => {
      const content = `User-agent: *
Disallow: /admin/
Allow: /admin/public
Sitemap: https://example.com/sitemap.xml`;
      const rules = parseRobotsTxt(content);
      assert.ok(rules.userAgents.has("*"));
      assert.deepEqual(rules.userAgents.get("*")?.disallowed, ["/admin/"]);
      assert.deepEqual(rules.userAgents.get("*")?.allowed, ["/admin/public"]);
      assert.deepEqual(rules.sitemaps, ["https://example.com/sitemap.xml"]);
    });

    void it("parses multiple user agents", () => {
      const content = `User-agent: googlebot
Disallow: /secret/

User-agent: *
Disallow: /`;
      const rules = parseRobotsTxt(content);
      assert.ok(rules.userAgents.has("googlebot"));
      assert.ok(rules.userAgents.has("*"));
    });

    void it("applies one rule block to consecutive user-agent lines", () => {
      const rules = parseRobotsTxt(
        `User-agent: SERPVERA-Crawler\nUser-agent: Googlebot\nDisallow: /shared/`,
      );
      assert.deepEqual(rules.userAgents.get("serpvera-crawler")?.disallowed, ["/shared/"]);
      assert.deepEqual(rules.userAgents.get("googlebot")?.disallowed, ["/shared/"]);
    });

    void it("treats an empty disallow value as no restriction", () => {
      const rules = parseRobotsTxt("User-agent: *\nDisallow:");
      assert.ok(isUrlAllowed("/private", "mybot", rules));
    });

    void it("keeps crawl-delay scoped to the matching user-agent group", () => {
      const rules = parseRobotsTxt(
        "User-agent: SERPVERA-Crawler\nCrawl-delay: 4\n\nUser-agent: *\nCrawl-delay: 30",
      );
      assert.equal(getCrawlDelay("SERPVERA-Crawler/0.1", rules), 4);
      assert.equal(getCrawlDelay("another-bot", rules), 30);
    });
  });

  void describe("isUrlAllowed", () => {
    const rules = parseRobotsTxt(`User-agent: *
Disallow: /admin/
Allow: /admin/public
Disallow: /secret`);

    void it("allows public path", () => {
      assert.ok(isUrlAllowed("/page", "mybot", rules));
    });

    void it("blocks disallowed path", () => {
      assert.ok(!isUrlAllowed("/admin/dashboard", "mybot", rules));
    });

    void it("allow overrides disallow", () => {
      assert.ok(isUrlAllowed("/admin/public", "mybot", rules));
    });

    void it("matches versioned crawler user agents to versioned and product-token groups", () => {
      const versionedRules = parseRobotsTxt(
        "User-agent: SERPVERA-Crawler/0.1\nDisallow: /versioned",
      );
      const productRules = parseRobotsTxt("User-agent: SERPVERA-Crawler\nDisallow: /product");
      assert.equal(isUrlAllowed("/versioned/page", "SERPVERA-Crawler/0.1", versionedRules), false);
      assert.equal(isUrlAllowed("/product/page", "SERPVERA-Crawler/0.1", productRules), false);
    });

    void it("honors the robots end-of-path anchor", () => {
      const rules = parseRobotsTxt("User-agent: *\nDisallow: /private$");
      assert.equal(isUrlAllowed("/private", "mybot", rules), false);
      assert.equal(isUrlAllowed("/private/page", "mybot", rules), true);
    });

    void it("treats Disallow: / as blocking the complete site", () => {
      const denyAll = parseRobotsTxt("User-agent: *\nDisallow: /");
      assert.equal(isUrlAllowed("/", "mybot", denyAll), false);
      assert.equal(isUrlAllowed("/page", "mybot", denyAll), false);
      assert.equal(isUrlAllowed("/nested/page?x=1", "mybot", denyAll), false);
    });
  });

  void describe("parseSitemapXml", () => {
    void it("parses URL sitemap", () => {
      const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
    <lastmod>2026-10-01</lastmod>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://example.com/page2</loc>
  </url>
</urlset>`;
      const result = parseSitemapXml(xml);
      assert.equal(result.urls.length, 2);
      assert.equal(result.urls[0]?.url, "https://example.com/page1");
      assert.equal(result.urls[0].priority, 0.8);
    });

    void it("parses sitemap index", () => {
      const xml = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap-posts.xml</loc>
  </sitemap>
</sitemapindex>`;
      const result = parseSitemapXml(xml);
      assert.equal(result.sitemaps.length, 1);
      assert.equal(result.urls.length, 0);
    });
  });
});
