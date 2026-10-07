import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { parseStoredTemplateGroups } from "./template-groups.ts";

void describe("persisted crawl template group privacy", () => {
  void it("keeps safe route summaries and redacts legacy summaries before returning them", () => {
    const safeGroup = {
      id: "0123456789abcdef",
      routePattern: "/articles/story-:id",
      domSignatureHash: "a".repeat(64),
      pageCount: 3,
      sampleUrls: ["https://fixture.example/articles/story-:id"],
      groupingMethod: "URL_PATTERN_AND_SEMANTIC_DOM_V2",
    };
    const unsafeLegacyGroup = {
      ...safeGroup,
      routePattern: "/users/jane-doe-:id",
      sampleUrls: ["https://fixture.example/users/jane-doe-123"],
    };

    assert.deepEqual(parseStoredTemplateGroups([safeGroup]), [safeGroup]);
    assert.equal(parseStoredTemplateGroups([unsafeLegacyGroup]), null);
    assert.equal(
      parseStoredTemplateGroups([
        {
          ...safeGroup,
          routePattern: "/guide/:id",
          pageCount: 2,
          sampleUrls: ["https://fixture.example/guide/:id"],
        },
      ]),
      null,
    );
    assert.equal(
      parseStoredTemplateGroups([
        {
          ...safeGroup,
          routePattern: "/users/:private",
          pageCount: 3,
          sampleUrls: ["https://fixture.example/users/:private"],
        },
      ]),
      null,
    );
  });

  void it("accepts privacy-singleton metadata only when it is truly a singleton", () => {
    const singleton = {
      id: "fedcba9876543210",
      routePattern: "/orders/:id",
      domSignatureHash: "b".repeat(64),
      pageCount: 1,
      sampleUrls: ["https://fixture.example/orders/:id"],
      groupingMethod: "SEMANTIC_DOM_PRIVACY_SINGLETON_V1",
    };

    assert.deepEqual(parseStoredTemplateGroups([singleton]), [singleton]);
    assert.equal(parseStoredTemplateGroups([{ ...singleton, pageCount: 2 }]), null);
  });

  void it("rejects legacy URL-only IDs and accepts only versioned redacted singletons", () => {
    const legacyUrl = "https://fixture.example/articles/oversized?token=guess-me";
    const legacyRawUrlId = {
      id: createHash("sha256").update(`budgeted\n${legacyUrl}`).digest("hex").slice(0, 16),
      routePattern: "/articles/:private",
      domSignatureHash: null,
      pageCount: 1,
      sampleUrls: ["https://fixture.example/articles/:private"],
      groupingMethod: "URL_PATTERN_ONLY_FINGERPRINT_UNAVAILABLE_V1",
    };
    const safeSingleton = {
      ...legacyRawUrlId,
      id: "0123456789abcdef",
      routePattern: "/articles/:private",
      groupingMethod: "URL_PATTERN_ONLY_PRIVACY_SINGLETON_V2",
    };

    assert.equal(parseStoredTemplateGroups([legacyRawUrlId]), null);
    assert.deepEqual(parseStoredTemplateGroups([safeSingleton]), [safeSingleton]);
  });
});
