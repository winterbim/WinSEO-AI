import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAuditTarget, normalizeUrl, UrlNormalizationError } from "./url-normalizer.ts";

void describe("url-normalizer", () => {
  void describe("normalizeUrl", () => {
    void it("normalizes a basic HTTPS URL", () => {
      const result = normalizeUrl("https://example.com/page");
      assert.equal(result.protocol, "https:");
      assert.equal(result.hostname, "example.com");
      assert.equal(result.pathname, "/page");
      assert.equal(result.port, null);
    });

    void it("strips fragments", () => {
      const result = normalizeUrl("https://example.com/page#section");
      assert.equal(result.normalized, "https://example.com/page");
    });

    void it("lowercases hostname", () => {
      const result = normalizeUrl("https://EXAMPLE.COM/Page");
      assert.equal(result.hostname, "example.com");
    });

    void it("removes default HTTPS port", () => {
      const result = normalizeUrl("https://example.com:443/page");
      assert.equal(result.port, null);
      assert.ok(!result.normalized.includes(":443"));
    });

    void it("removes default HTTP port", () => {
      const result = normalizeUrl("http://example.com:80/page");
      assert.equal(result.port, null);
      assert.ok(!result.normalized.includes(":80"));
    });

    void it("preserves non-default ports", () => {
      const result = normalizeUrl("https://example.com:8080/page");
      assert.equal(result.port, 8080);
    });

    void it("preserves query parameters", () => {
      const result = normalizeUrl("https://example.com/page?q=test&lang=en");
      assert.equal(result.search, "?q=test&lang=en");
    });

    void it("rejects file:// protocol", () => {
      assert.throws(() => normalizeUrl("file:///etc/passwd"), UrlNormalizationError);
    });

    void it("rejects ftp:// protocol", () => {
      assert.throws(() => normalizeUrl("ftp://example.com/file"), UrlNormalizationError);
    });

    void it("rejects URLs with embedded credentials", () => {
      assert.throws(() => normalizeUrl("http://admin:password@example.com"), UrlNormalizationError);
    });

    void it("rejects URLs exceeding max length", () => {
      const longPath = "/" + "a".repeat(2048);
      const longUrl = `https://example.com${longPath}`;
      assert.throws(() => normalizeUrl(longUrl), UrlNormalizationError);
    });

    void it("rejects malformed URLs", () => {
      assert.throws(() => normalizeUrl("not a url at all"), UrlNormalizationError);
    });

    void it("handles URLs with path and complex query string", () => {
      const result = normalizeUrl("https://www.example.com/path/to/page?param1=val1&param2=val2");
      assert.equal(result.hostname, "www.example.com");
      assert.equal(result.pathname, "/path/to/page");
      assert.equal(result.search, "?param1=val1&param2=val2");
    });
  });

  void describe("normalizeAuditTarget", () => {
    void it("defaults a bare domain to HTTPS", () => {
      assert.equal(normalizeAuditTarget("  example.com  ").normalized, "https://example.com/");
    });

    void it("preserves an entered page path and query", () => {
      const result = normalizeAuditTarget("https://example.com/products/seo?q=images#details");
      assert.equal(result.normalized, "https://example.com/products/seo?q=images");
    });

    void it("preserves explicit HTTP", () => {
      assert.equal(
        normalizeAuditTarget("http://example.com/page").normalized,
        "http://example.com/page",
      );
    });

    void it("rejects non-HTTP schemes", () => {
      assert.throws(() => normalizeAuditTarget("ftp://example.com/file"), UrlNormalizationError);
    });

    void it("rejects blank targets", () => {
      assert.throws(() => normalizeAuditTarget("  "), UrlNormalizationError);
    });
  });
});
