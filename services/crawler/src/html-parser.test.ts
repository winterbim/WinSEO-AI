import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHtmlPage, stripTags } from "./html-parser.ts";

void describe("html-parser", () => {
  void describe("parseHtmlPage", () => {
    const baseUrl = "https://example.com/page";

    void it("extracts title", () => {
      const html = "<html><head><title>Test Page</title></head><body></body></html>";
      const result = parseHtmlPage(html, baseUrl);
      assert.equal(result.title, "Test Page");
    });

    void it("extracts meta description", () => {
      const html = `<html><head><meta name="description" content="A test page description"></head><body></body></html>`;
      const result = parseHtmlPage(html, baseUrl);
      assert.equal(result.metaDescription, "A test page description");
    });

    void it("extracts meta description (reversed attrs)", () => {
      const html = `<html><head><meta content="Reversed test" name="description"></head><body></body></html>`;
      const result = parseHtmlPage(html, baseUrl);
      assert.equal(result.metaDescription, "Reversed test");
    });

    void it("returns null for missing description", () => {
      const html = "<html><head><title>No Desc</title></head><body></body></html>";
      const result = parseHtmlPage(html, baseUrl);
      assert.equal(result.metaDescription, null);
    });

    void it("extracts H1 tags", () => {
      const html = `<html><body><h1>Main Title</h1><p>text</p><h1>Second Title</h1></body></html>`;
      const result = parseHtmlPage(html, baseUrl);
      assert.deepEqual(result.h1, ["Main Title", "Second Title"]);
    });

    void it("extracts canonical", () => {
      const html = `<html><head><link rel="canonical" href="https://example.com/canonical-page"></head><body></body></html>`;
      const result = parseHtmlPage(html, baseUrl);
      assert.equal(result.canonical, "https://example.com/canonical-page");
    });

    void it("resolves relative canonical", () => {
      const html = `<html><head><link rel="canonical" href="/canonical-page"></head><body></body></html>`;
      const result = parseHtmlPage(html, baseUrl);
      assert.equal(result.canonical, "https://example.com/canonical-page");
    });

    void it("extracts robots meta", () => {
      const html = `<html><head><meta name="robots" content="noindex, nofollow"></head><body></body></html>`;
      const result = parseHtmlPage(html, baseUrl);
      assert.equal(result.robotsMeta, "noindex, nofollow");
    });

    void it("parses valid JSON-LD structured data", () => {
      const html = `<html><head><script type="application/ld+json">{"@type": "Article", "name": "Test"}</script></head><body></body></html>`;
      const result = parseHtmlPage(html, baseUrl);
      const [entry] = result.structuredData;
      assert.equal(result.structuredData.length, 1);
      assert.ok(entry, "structured data entry must exist");
      assert.equal(entry.type, "Article");
      assert.ok(entry.isValid);
    });

    void it("handles invalid JSON-LD", () => {
      const html = `<html><head><script type="application/ld+json">{broken json</script></head><body></body></html>`;
      const result = parseHtmlPage(html, baseUrl);
      const [entry] = result.structuredData;
      assert.equal(result.structuredData.length, 1);
      assert.ok(entry, "structured data entry must exist");
      assert.ok(!entry.isValid);
    });

    void it("extracts internal links only", () => {
      const html = `<html><body>
        <a href="/internal">Internal</a>
        <a href="https://example.com/also-internal">Also Internal</a>
        <a href="https://other.com/external">External</a>
        <a href="#section">Anchor</a>
        <a href="javascript:void(0)">JS Link</a>
      </body></html>`;
      const result = parseHtmlPage(html, baseUrl);
      // Should have 2 internal links (skipping anchors, JS links, external)
      assert.equal(result.internalLinks.length, 2);
      assert.ok(result.internalLinks.some((l) => l.includes("/internal")));
      assert.ok(result.internalLinks.some((l) => l.includes("/also-internal")));
    });

    void it("extracts html lang", () => {
      const html = `<html lang="fr"><head></head><body></body></html>`;
      const result = parseHtmlPage(html, baseUrl);
      assert.equal(result.lang, "fr");
    });

    void it("detects viewport meta", () => {
      const html = `<html><head><meta name="viewport" content="width=device-width"></head><body></body></html>`;
      const result = parseHtmlPage(html, baseUrl);
      assert.ok(result.hasViewport);
    });
  });

  void describe("stripTags", () => {
    void it("strips HTML tags", () => {
      const result = stripTags("<p>Hello <b>World</b></p>");
      assert.equal(result, "Hello World");
    });

    void it("normalizes whitespace", () => {
      const result = stripTags("<div>  Multiple    spaces  </div>");
      assert.equal(result, "Multiple spaces");
    });
  });
});