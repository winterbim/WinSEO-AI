import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DomainAuditResult } from "@serpvera/api/audit";
import { executeInlinePreviewAudit } from "./preview-audit.ts";

function emptyAudit(url: string): DomainAuditResult {
  return {
    status: "completed",
    findings: [],
    evidence: [],
    httpStatus: 200,
    finalUrl: url,
    contentHash: "fixture-hash",
  };
}

void describe("inline preview audit", () => {
  void it("passes the normalized full page URL to the shared audit engine", async () => {
    let capturedUrl = "";
    const result = await executeInlinePreviewAudit(
      "https://example.com/collections/images?sort=recent",
      "preview-test",
      (url) => {
        capturedUrl = url;
        return Promise.resolve(emptyAudit(url));
      },
    );

    assert.equal(capturedUrl, "https://example.com/collections/images?sort=recent");
    assert.equal(result.targetUrl, capturedUrl);
    assert.equal(result.audit.finalUrl, capturedUrl);
  });

  void it("rejects a private target before the audit engine can run", async () => {
    let called = false;
    await assert.rejects(
      executeInlinePreviewAudit("http://127.0.0.1/admin", "preview-test", () => {
        called = true;
        return Promise.resolve(emptyAudit("http://127.0.0.1/admin"));
      }),
      /SSRF blocked/,
    );
    assert.equal(called, false);
  });
});
