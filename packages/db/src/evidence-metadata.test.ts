import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publicEvidenceMetadata } from "./evidence-metadata.ts";

void describe("public evidence metadata", () => {
  void it("does not expose legacy crawl-group fingerprints or route identifiers", () => {
    const result = publicEvidenceMetadata({
      pageUrl: "https://fixture.example/about",
      templateId: "deadbeef01234567",
      templateRoutePattern: "/users/jane-doe-:id",
      templateDomSignatureHash: "a".repeat(64),
      templateGroupingMethod: "URL_PATTERN_ONLY_FINGERPRINT_UNAVAILABLE_V1",
      ruleId: "ONPAGE.MISSING_TITLE",
    });

    assert.deepEqual(result, {
      pageUrl: "https://fixture.example/about",
      ruleId: "ONPAGE.MISSING_TITLE",
    });
  });

  void it("returns an empty object for non-object metadata", () => {
    assert.deepEqual(publicEvidenceMetadata(null), {});
    assert.deepEqual(publicEvidenceMetadata(["not metadata"]), {});
  });
});
