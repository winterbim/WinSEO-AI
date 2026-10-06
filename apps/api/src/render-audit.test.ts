// Audit wiring tests use controlled HTML and an injected renderer. No external
// HTTP request or third-party browser navigation is part of this suite.
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FetchResult, NormalizedUrl, RenderResult } from "@serpvera/crawler";
import { auditDomain } from "./audit/domain-audit.ts";

const DOMAIN = "audit-fixture.test";
const URL = `https://${DOMAIN}/`;
const SHELL_HTML = `<!doctype html><html lang="en"><head><title></title></head>
  <body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>`;
const RENDERED_HTML = `<!doctype html><html lang="en"><head>
  <title>Rendered fixture title</title><link rel="canonical" href="${URL}">
  </head><body><h1>Rendered fixture heading</h1><p>${"rendered fixture content ".repeat(30)}</p></body></html>`;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureFetch(html: string) {
  return (url: NormalizedUrl): Promise<FetchResult> =>
    Promise.resolve({
      url,
      finalUrl: url.normalized,
      httpStatus: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: html,
      contentHash: hash(html),
      redirectChain: [],
      fetchDurationMs: 1,
    });
}

function successfulRender(): Promise<RenderResult> {
  return Promise.resolve({
    ok: true,
    dom: RENDERED_HTML,
    sha256: hash(RENDERED_HTML),
    bytes: Buffer.byteLength(RENDERED_HTML),
    durationMs: 42,
  });
}

void describe("audit two-pass pipeline (deterministic fixtures)", () => {
  void it("records an escalated rendered capture with a verifiable hash", async () => {
    const result = await auditDomain(DOMAIN, "test-render-audit", {
      fetchPage: fixtureFetch(SHELL_HTML),
      render: successfulRender,
    });

    assert.equal(result.status, "completed", result.errorMessage ?? "");
    assert.ok(result.render, "escalation metadata must be recorded");
    assert.ok(result.render.escalated);
    assert.ok(result.render.reasons.some((reason) => reason.startsWith("SHELL_ONLY_BODY")));
    assert.equal(result.render.renderedSha256, hash(RENDERED_HTML));
    const evidence = result.evidence.find((item) => item.kind === "dom_snapshot");
    assert.ok(evidence, "rendered capture must produce dom_snapshot evidence");
    assert.equal(evidence.contentHash, result.render.renderedSha256);
    assert.ok(Array.isArray(evidence.metadata?.escalationReasons));
    assert.ok(String(evidence.metadata.domExcerpt).includes("Rendered fixture title"));
  });

  void it("emits JS.SOURCE_RENDER_DIVERGENCE + evidence when rendered differs", async () => {
    const result = await auditDomain(DOMAIN, "test-divergence", {
      fetchPage: fixtureFetch(SHELL_HTML),
      render: successfulRender,
    });

    assert.equal(result.status, "completed");
    const finding = result.findings.find((item) => item.ruleId === "JS.SOURCE_RENDER_DIVERGENCE");
    assert.ok(finding, "divergence must produce a finding");
    assert.equal(finding.epistemicClass, "OBSERVED");
    assert.ok(finding.explanation.includes("Rendering was triggered because"));
    assert.ok(finding.recommendation);
    const evidence = result.evidence.find((item) => item.kind === "dom_snapshot");
    assert.ok(evidence);
    assert.equal(evidence.contentHash, hash(RENDERED_HTML));
    assert.ok(Array.isArray(evidence.metadata?.escalationReasons));
    assert.ok(Array.isArray(evidence.metadata.sourceRenderedDivergences));
  });

  void it("invokes the renderer for escalated fixtures and records failed capture honestly", async () => {
    let called = false;
    const result = await auditDomain(DOMAIN, "test-render-failure", {
      fetchPage: fixtureFetch(SHELL_HTML),
      render: () => {
        called = true;
        return Promise.resolve({
          ok: false,
          error: "fixture render failure",
          durationMs: 0,
        });
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(called, result.render?.escalated);
    assert.ok(result.render?.escalated);
    assert.equal(result.render.error, "fixture render failure");
    assert.equal(result.render.renderedSha256, undefined);
  });

  void it("audits the exact submitted URL path rather than replacing it with the homepage", async () => {
    let capturedUrl = "";
    const result = await auditDomain(
      "https://audit-fixture.test/products/widget?ref=search",
      "test-page-url",
      {
        fetchPage: (url) => {
          capturedUrl = url.normalized;
          return fixtureFetch(RENDERED_HTML)(url);
        },
        render: false,
      },
    );

    assert.equal(result.status, "completed");
    assert.equal(capturedUrl, "https://audit-fixture.test/products/widget?ref=search");
    assert.equal(result.finalUrl, capturedUrl);
  });

  void it("marks rendered evidence unavailable instead of claiming a rendered check", async () => {
    const result = await auditDomain(DOMAIN, "test-render-unavailable", {
      fetchPage: fixtureFetch(SHELL_HTML),
      render: false,
    });

    assert.equal(result.status, "completed");
    assert.ok(result.render?.escalated);
    assert.equal(result.render.renderedSha256, undefined);
    assert.match(result.render.error ?? "", /unavailable in this runtime/);
  });

  void it("refuses injected HTTP fixtures under NODE_ENV=production", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await assert.rejects(
        auditDomain(DOMAIN, "test-production-fetch-guard", {
          fetchPage: fixtureFetch(SHELL_HTML),
        }),
        /Injected audit fetchers are disabled in production/,
      );
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
