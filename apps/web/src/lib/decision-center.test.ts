import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDecisionCenter } from "./decision-center.ts";
import type { FindingSummary, GscMeasuredRecommendation } from "./types.ts";

const finding = (overrides: Partial<FindingSummary> = {}): FindingSummary => ({
  id: "f-1",
  ruleId: "CRAWL.ROBOTS_NOINDEX",
  ruleVersion: "1",
  title: "Noindex",
  epistemicClass: "OBSERVED",
  severity: "high",
  status: "open",
  confidence: 1,
  firstSeenAt: "2026-10-06T00:00:00Z",
  affectedUrls: ["https://example.com/a"],
  verificationGate: "recrawl_rule_absent",
  ...overrides,
});

const rec = (
  module: string,
  overrides: Partial<GscMeasuredRecommendation> = {},
): GscMeasuredRecommendation => ({
  module,
  subject: { page: "https://example.com/a" },
  title: module,
  rationale: "Measured in Search Console.",
  datasetWindow: { startDate: "2026-09-01", endDate: "2026-09-30" },
  filters: {},
  observed: { impressions: 1000, clicks: 20 },
  evidenceClass: "MEASURED",
  verificationGate: {
    type: "gsc_window",
    spec: {
      metric: "clicks",
      operator: "gte",
      threshold: 25,
      minImpressions: 100,
      windowDays: 30,
    },
  },
  severity: "medium",
  ...overrides,
});

describe("buildDecisionCenter", () => {
  it("puts severe observed crawl defects in FIX_NOW", () => {
    const result = buildDecisionCenter("p1", [finding()], []);
    assert.equal(result.items[0]?.lane, "FIX_NOW");
    assert.equal(result.items[0]?.evidenceClass, "OBSERVED");
  });

  it("routes measured decay to REFRESH and cannibalization to review", () => {
    const result = buildDecisionCenter("p1", [], [
      rec("page_query_decay"),
      rec("query_cannibalization"),
    ]);
    assert.equal(result.counts.REFRESH, 1);
    assert.equal(result.counts.CONSOLIDATE_REVIEW, 1);
    assert.ok(result.items.every((item) => item.evidenceClass === "MEASURED"));
  });

  it("never upgrades a positive winner into a refresh task", () => {
    const result = buildDecisionCenter("p1", [], [
      rec("winners_losers", { delta: { clicks: 0.25 } }),
    ]);
    assert.equal(result.items[0]?.lane, "GROW");
  });

  it("ignores resolved findings", () => {
    const result = buildDecisionCenter("p1", [finding({ status: "resolved" })], []);
    assert.equal(result.items.length, 0);
  });
});
