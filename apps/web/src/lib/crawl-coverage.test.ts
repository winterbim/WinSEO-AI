import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crawlCoverageLabel } from "./crawl-coverage.ts";

void describe("crawlCoverageLabel", () => {
  void it("does not invent coverage for historical runs without persisted metadata", () => {
    assert.equal(
      crawlCoverageLabel("completed", null, null),
      "Coverage details unavailable for this historical crawl",
    );
  });

  void it("shows the recorded page cap when a new crawl reaches it", () => {
    assert.equal(
      crawlCoverageLabel("completed", "page_limit", 50),
      "Partial coverage · 50-page limit reached",
    );
  });

  void it("does not guess the cap when the stop reason exists but the value is absent", () => {
    assert.equal(
      crawlCoverageLabel("completed", "page_limit", null),
      "Partial coverage · recorded page limit reached",
    );
  });
});
