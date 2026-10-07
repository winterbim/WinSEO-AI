// GSC-006 — deterministic opportunity engine.
//
// CLAIM: every intelligence module is a pure function over measured rows —
// same rows in, byte-identical recommendations out; nothing is emitted below
// the impression floor; empty input yields empty output; and every
// recommendation carries its exact dataset window, filters, comparison window,
// observed values, evidenceClass MEASURED and a computable verification gate.
// No LLM decides any number here, and none is used in these tests either.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  emergingQueries,
  highImpressionsLowCtr,
  pageQueryDecay,
  pageQueryIntersections,
  prePostComparison,
  queryCannibalization,
  rankingOpportunityWindows,
  recommendationRuleId,
  summarizeByDimension,
  winnersLosers,
  type MeasuredRecommendation,
  type MetricRow,
  type MetricWindow,
} from "./intelligence.ts";
import { metricRow } from "./test-doubles.ts";

const CURRENT: MetricWindow = { startDate: "2026-09-01", endDate: "2026-09-30" };
const BASELINE: MetricWindow = { startDate: "2026-08-01", endDate: "2026-08-31" };

const row = (partial: Partial<MetricRow>): MetricRow => metricRow(partial);

/** Cross-cutting contract every module must satisfy on every emission. */
function assertMeasuredContract(rec: MeasuredRecommendation, window: MetricWindow): void {
  assert.equal(rec.evidenceClass, "MEASURED");
  assert.deepEqual(rec.datasetWindow, window, "the exact dataset window travels with the claim");
  assert.ok(Object.keys(rec.filters).length > 0, "the selecting filters are reproducible");
  assert.ok(Object.keys(rec.observed).length > 0, "observed values are carried, not paraphrased");
  assert.equal(rec.verificationGate.type, "gsc_window");
  assert.ok(rec.verificationGate.spec.windowDays >= 1);
  assert.ok(rec.verificationGate.spec.minImpressions >= 0);
  assert.ok(rec.title.length > 0 && rec.rationale.length > 0);
  // The gate targets the same subject the claim is about.
  assert.equal(rec.verificationGate.spec.query, rec.subject.query);
  assert.equal(rec.verificationGate.spec.page, rec.subject.page);
}

void describe("GSC-006 1 — high impressions / low CTR", () => {
  void it("claims only visibility that is not being chosen, with a CTR gate", () => {
    const rows = [
      row({
        date: "2026-09-10",
        query: "visible",
        page: "https://example.com/a",
        clicks: 6,
        impressions: 600,
        ctr: 0.01,
        position: 4,
      }),
      row({
        date: "2026-09-10",
        query: "hidden",
        page: "https://example.com/b",
        clicks: 5,
        impressions: 400,
        ctr: 0.0125,
        position: 9,
      }), // below the impression floor
      row({
        date: "2026-09-10",
        query: "chosen",
        page: "https://example.com/c",
        clicks: 60,
        impressions: 600,
        ctr: 0.1,
        position: 3,
      }), // CTR is fine
    ];
    const recs = highImpressionsLowCtr(rows, CURRENT);
    assert.equal(recs.length, 1);
    const rec = recs[0];
    assert.ok(rec);
    assert.equal(rec.subject.query, "visible");
    assert.deepEqual(rec.observed, {
      impressions: 600,
      clicks: 6,
      ctr: 0.01,
      position: 4,
      days: 1,
    });
    assert.deepEqual(rec.verificationGate.spec, {
      metric: "ctr",
      operator: "gte",
      threshold: 0.02,
      query: "visible",
      page: "https://example.com/a",
      minImpressions: 500,
      windowDays: 30,
    });
    assertMeasuredContract(rec, CURRENT);
  });
});

void describe("GSC-006 2 — ranking opportunity windows", () => {
  void it("claims positions inside 6–15 and gates them to the target position", () => {
    const rows = [
      row({ query: "striking", page: "https://example.com/a", impressions: 300, position: 7.2 }),
      row({ query: "already", page: "https://example.com/b", impressions: 300, position: 3 }), // top-3: not this module
      row({ query: "nowhere", page: "https://example.com/c", impressions: 300, position: 40 }), // too deep
    ];
    const recs = rankingOpportunityWindows(rows, CURRENT);
    assert.equal(recs.length, 1);
    const rec = recs[0];
    assert.ok(rec);
    assert.equal(rec.subject.query, "striking");
    assert.equal(rec.observed.position, 7.2);
    assert.equal(rec.verificationGate.spec.metric, "position");
    assert.equal(rec.verificationGate.spec.operator, "lte");
    assert.equal(rec.verificationGate.spec.threshold, 5);
    assertMeasuredContract(rec, CURRENT);
  });
});

void describe("GSC-006 3 — page/query decay", () => {
  void it("claims relative impression collapse and gates recovery to the baseline level", () => {
    const before = [
      row({
        query: "q",
        page: "https://example.com/p",
        impressions: 400,
        clicks: 40,
        ctr: 0.1,
        position: 5,
      }),
    ];
    const now = [
      row({
        query: "q",
        page: "https://example.com/p",
        impressions: 200,
        clicks: 15,
        ctr: 0.075,
        position: 8,
      }),
    ];
    const recs = pageQueryDecay(now, before, CURRENT, BASELINE);
    assert.equal(recs.length, 1);
    const rec = recs[0];
    assert.ok(rec);
    assert.equal(rec.delta?.impressions, -0.5, "400 → 200 is exactly −50%");
    assert.deepEqual(rec.baseline, { impressions: 400, clicks: 40, ctr: 0.1, position: 5 });
    assert.deepEqual(rec.comparisonWindow, BASELINE);
    assert.equal(rec.verificationGate.spec.metric, "impressions");
    assert.equal(rec.verificationGate.spec.operator, "gte");
    assert.equal(
      rec.verificationGate.spec.threshold,
      400,
      "recovery targets the measured baseline",
    );
    assertMeasuredContract(rec, CURRENT);
  });

  void it("stays silent on drift below the decay threshold and on unmeasured baselines", () => {
    const before = [
      row({ query: "drift", page: "https://example.com/p", impressions: 400 }),
      row({ query: "thin", page: "https://example.com/t", impressions: 20 }),
    ];
    const now = [
      row({ query: "drift", page: "https://example.com/p", impressions: 350 }), // −12.5%: not decay
      row({ query: "thin", page: "https://example.com/t", impressions: 2 }), // baseline below floor
      row({ query: "novel", page: "https://example.com/n", impressions: 500 }), // no baseline at all
    ];
    assert.deepEqual(pageQueryDecay(now, before, CURRENT, BASELINE), []);
  });
});

void describe("GSC-006 4 — query cannibalization evidence", () => {
  void it("claims one query split across qualifying pages and gates consolidated clicks", () => {
    const rows = [
      row({
        query: "shared",
        page: "https://example.com/x",
        impressions: 120,
        clicks: 6,
        position: 7,
      }),
      row({
        query: "shared",
        page: "https://example.com/y",
        impressions: 80,
        clicks: 3,
        position: 9,
      }),
      row({
        query: "lonely",
        page: "https://example.com/z",
        impressions: 300,
        clicks: 30,
        position: 3,
      }),
    ];
    const recs = queryCannibalization(rows, CURRENT);
    assert.equal(recs.length, 1);
    const rec = recs[0];
    assert.ok(rec);
    assert.deepEqual(rec.subject, { query: "shared" });
    assert.equal(rec.observed.competingPages, 2);
    assert.equal(rec.observed.totalImpressions, 200);
    assert.equal(rec.observed.totalClicks, 9);
    assert.equal(rec.verificationGate.spec.metric, "clicks");
    assert.equal(rec.verificationGate.spec.operator, "gte");
    assert.equal(
      rec.verificationGate.spec.threshold,
      10,
      "ceil(9 × 1.1) — the consolidation target",
    );
    assertMeasuredContract(rec, CURRENT);
  });
});

void describe("GSC-006 5 — emerging queries", () => {
  void it("claims pairs absent from the baseline and gates the growth target", () => {
    const before = [row({ query: "old", page: "https://example.com/o", impressions: 500 })];
    const now = [
      row({
        query: "fresh",
        page: "https://example.com/f",
        impressions: 300,
        clicks: 12,
        ctr: 0.04,
        position: 6,
      }),
      row({ query: "old", page: "https://example.com/o", impressions: 600 }), // established: excluded
    ];
    const recs = emergingQueries(now, before, CURRENT, BASELINE);
    assert.equal(recs.length, 1);
    const rec = recs[0];
    assert.ok(rec);
    assert.equal(rec.subject.query, "fresh");
    assert.deepEqual(rec.comparisonWindow, BASELINE);
    assert.deepEqual(rec.baseline, { impressions: 0, present: 0 });
    assert.equal(rec.verificationGate.spec.metric, "impressions");
    assert.equal(rec.verificationGate.spec.threshold, 450, "growth target = 1.5× the observation");
    assertMeasuredContract(rec, CURRENT);
  });
});

void describe("GSC-006 6 — winners / losers", () => {
  void it("labels both directions from click deltas and gates each appropriately", () => {
    const before = [
      row({ query: "rising", page: "https://example.com/r", impressions: 200, clicks: 10 }),
      row({ query: "falling", page: "https://example.com/f", impressions: 200, clicks: 30 }),
      row({ query: "flat", page: "https://example.com/s", impressions: 200, clicks: 25 }),
    ];
    const now = [
      row({ query: "rising", page: "https://example.com/r", impressions: 300, clicks: 20 }),
      row({ query: "falling", page: "https://example.com/f", impressions: 150, clicks: 10 }),
      row({ query: "flat", page: "https://example.com/s", impressions: 210, clicks: 26 }), // +4%: noise
    ];
    const recs = winnersLosers(now, before, CURRENT, BASELINE);
    assert.equal(recs.length, 2);
    const winner = recs.find((r) => r.subject.query === "rising");
    const loser = recs.find((r) => r.subject.query === "falling");
    assert.ok(winner && loser);
    assert.match(winner.title, /^Winner/);
    assert.equal(winner.delta?.clicks, 1, "+100%");
    assert.equal(
      winner.verificationGate.spec.threshold,
      20,
      "a winner must at least hold its gain",
    );
    assert.match(loser.title, /^Loser/);
    assert.equal(loser.delta?.clicks, Number((-2 / 3).toFixed(6)), "30 → 10 clicks is −66.67%");
    assert.equal(loser.verificationGate.spec.threshold, 30, "a loser must recover the lost clicks");
    assertMeasuredContract(winner, CURRENT);
    assertMeasuredContract(loser, CURRENT);
  });
});

void describe("GSC-006 7 — page/query intersections", () => {
  void it("claims pages with multiple measured queries and gates aggregate clicks", () => {
    const rows = [
      row({
        query: "q1",
        page: "https://example.com/p",
        impressions: 150,
        clicks: 10,
        position: 4,
      }),
      row({ query: "q2", page: "https://example.com/p", impressions: 50, clicks: 2, position: 8 }), // below floor
      row({ query: "q3", page: "https://example.com/p", impressions: 100, clicks: 5, position: 6 }),
    ];
    const recs = pageQueryIntersections(rows, CURRENT);
    assert.equal(recs.length, 1);
    const rec = recs[0];
    assert.ok(rec);
    assert.deepEqual(rec.subject, { page: "https://example.com/p" });
    assert.equal(rec.observed.queryCount, 2);
    assert.equal(rec.observed.impressions, 250);
    assert.equal(rec.observed.clicks, 15);
    assert.equal(rec.observed.topQueries, "q1 | q3");
    assert.equal(rec.verificationGate.spec.threshold, 18, "ceil(15 × 1.15)");
    assertMeasuredContract(rec, CURRENT);
  });
});

void describe("GSC-006 8 — pre/post intervention comparison", () => {
  void it("measures one subject across both windows and stays silent without data", () => {
    const before = [
      row({
        query: "q",
        page: "https://example.com/p",
        impressions: 1000,
        clicks: 10,
        ctr: 0.01,
        position: 9,
      }),
    ];
    const after = [
      row({
        query: "q",
        page: "https://example.com/p",
        impressions: 1200,
        clicks: 18,
        ctr: 0.015,
        position: 6,
      }),
    ];
    const rec = prePostComparison(before, after, BASELINE, CURRENT, {
      query: "q",
      page: "https://example.com/p",
    });
    assert.ok(rec);
    const delta = rec.delta;
    assert.ok(delta);
    assert.equal(delta.clicks, 0.8);
    assert.equal(delta.impressions, 0.2);
    assert.equal(delta.position, -3);
    assert.deepEqual(rec.comparisonWindow, BASELINE);
    assert.deepEqual(rec.datasetWindow, CURRENT);
    assertMeasuredContract(rec, CURRENT);

    // Neither window carries the minimum measurement → no claim at all.
    assert.equal(
      prePostComparison(
        [row({ impressions: 1 })],
        [row({ impressions: 1 })],
        BASELINE,
        CURRENT,
        {},
      ),
      null,
    );
  });
});

void describe("GSC-006 cross-cutting determinism and helpers", () => {
  void it("returns byte-identical output for identical input (no clock, no model)", () => {
    const before = [
      row({ query: "q", page: "https://example.com/p", impressions: 400, clicks: 40 }),
    ];
    const now = [row({ query: "q", page: "https://example.com/p", impressions: 100, clicks: 5 })];
    const run = (): string =>
      JSON.stringify([
        highImpressionsLowCtr(now, CURRENT),
        rankingOpportunityWindows(now, CURRENT),
        pageQueryDecay(now, before, CURRENT, BASELINE),
        queryCannibalization(now, CURRENT),
        emergingQueries(now, before, CURRENT, BASELINE),
        winnersLosers(now, before, CURRENT, BASELINE),
        pageQueryIntersections(now, CURRENT),
        prePostComparison(before, now, BASELINE, CURRENT, {}),
      ]);
    assert.equal(run(), run());
  });

  void it("is input-order independent (metamorphic: shuffling rows changes nothing)", () => {
    const before = [
      row({ query: "q", page: "https://example.com/p", impressions: 400, clicks: 40 }),
      row({
        date: "2026-08-03",
        query: "z",
        page: "https://example.com/z",
        impressions: 300,
        clicks: 30,
      }),
      // Tie-valued subjects: sort tie-breaks must be deterministic too.
      row({
        date: "2026-08-04",
        query: "tie-b",
        page: "https://example.com/t",
        impressions: 300,
        clicks: 30,
      }),
      row({
        date: "2026-08-05",
        query: "tie-a",
        page: "https://example.com/t",
        impressions: 300,
        clicks: 30,
      }),
    ];
    const now = [
      row({ query: "q", page: "https://example.com/p", impressions: 100, clicks: 5 }),
      row({
        date: "2026-09-03",
        query: "z",
        page: "https://example.com/z",
        impressions: 250,
        clicks: 25,
      }),
      row({
        date: "2026-09-04",
        query: "tie-b",
        page: "https://example.com/t",
        impressions: 260,
        clicks: 26,
      }),
      row({
        date: "2026-09-05",
        query: "tie-a",
        page: "https://example.com/t",
        impressions: 260,
        clicks: 26,
      }),
    ];
    const all = (b: MetricRow[], n: MetricRow[]): string =>
      JSON.stringify([
        highImpressionsLowCtr(n, CURRENT),
        rankingOpportunityWindows(n, CURRENT),
        pageQueryDecay(n, b, CURRENT, BASELINE),
        queryCannibalization(n, CURRENT),
        emergingQueries(n, b, CURRENT, BASELINE),
        winnersLosers(n, b, CURRENT, BASELINE),
        pageQueryIntersections(n, CURRENT),
        prePostComparison(b, n, BASELINE, CURRENT, {}),
      ]);
    // Map iteration order must not leak into any output.
    assert.equal(all(before, now), all([...before].reverse(), [...now].reverse()));
  });

  void it("is clock-free: runs at different wall-clock instants are identical", async () => {
    const before = [
      row({ query: "q", page: "https://example.com/p", impressions: 400, clicks: 40 }),
    ];
    const now = [row({ query: "q", page: "https://example.com/p", impressions: 100, clicks: 5 })];
    const run = (): string =>
      JSON.stringify([
        highImpressionsLowCtr(now, CURRENT),
        rankingOpportunityWindows(now, CURRENT),
        pageQueryDecay(now, before, CURRENT, BASELINE),
        queryCannibalization(now, CURRENT),
        emergingQueries(now, before, CURRENT, BASELINE),
        winnersLosers(now, before, CURRENT, BASELINE),
        pageQueryIntersections(now, CURRENT),
        prePostComparison(before, now, BASELINE, CURRENT, {}),
      ]);
    const first = run();
    // Force Date.now() to advance between the runs: if any output embedded a
    // clock read (even sub-millisecond), this comparison fails.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(run(), first, "identical rows must yield identical bytes at any instant");
  });

  void it("declares the comparison-window contract per module honestly", () => {
    const before = [
      row({ query: "q", page: "https://example.com/p", impressions: 400, clicks: 40 }),
    ];
    const now = [row({ query: "q", page: "https://example.com/p", impressions: 100, clicks: 5 })];
    // Modules that compare two windows MUST name the comparison window…
    for (const rec of [
      ...pageQueryDecay(now, before, CURRENT, BASELINE),
      ...emergingQueries(now, before, CURRENT, BASELINE),
      ...winnersLosers(now, before, CURRENT, BASELINE),
    ]) {
      assert.deepEqual(
        rec.comparisonWindow,
        BASELINE,
        `${rec.module} must name its baseline window`,
      );
    }
    const prePost = prePostComparison(before, now, BASELINE, CURRENT, {});
    assert.ok(prePost);
    assert.deepEqual(prePost.comparisonWindow, BASELINE);
    // …and single-window modules must NOT invent one.
    for (const rec of [
      ...highImpressionsLowCtr(now, CURRENT),
      ...rankingOpportunityWindows(now, CURRENT),
      ...queryCannibalization(now, CURRENT),
      ...pageQueryIntersections(now, CURRENT),
    ]) {
      assert.equal(rec.comparisonWindow, undefined, `${rec.module} has no baseline to name`);
    }
  });

  void it("yields nothing from nothing — every module, both directions", () => {
    assert.deepEqual(highImpressionsLowCtr([], CURRENT), []);
    assert.deepEqual(rankingOpportunityWindows([], CURRENT), []);
    assert.deepEqual(pageQueryDecay([], [], CURRENT, BASELINE), []);
    assert.deepEqual(queryCannibalization([], CURRENT), []);
    assert.deepEqual(emergingQueries([], [], CURRENT, BASELINE), []);
    assert.deepEqual(winnersLosers([], [], CURRENT, BASELINE), []);
    assert.deepEqual(pageQueryIntersections([], CURRENT), []);
    assert.equal(prePostComparison([], [], BASELINE, CURRENT, {}), null);
  });

  void it("derives stable rule ids that separate subjects", () => {
    const [base] = highImpressionsLowCtr(
      [row({ query: "q", page: "https://example.com/p", impressions: 600, clicks: 3, ctr: 0.005 })],
      CURRENT,
    );
    assert.ok(base);
    const rec: MeasuredRecommendation = { ...base };
    assert.equal(
      recommendationRuleId(rec),
      "GSC.high_impressions_low_ctr::page=https%3A%2F%2Fexample.com%2Fp::query=q",
    );
    assert.equal(recommendationRuleId(rec), recommendationRuleId({ ...rec }));
    assert.notEqual(
      recommendationRuleId(rec),
      recommendationRuleId({ ...rec, subject: { query: "other" } }),
    );
    assert.notEqual(
      recommendationRuleId(rec),
      recommendationRuleId({ ...rec, subject: { ...rec.subject, device: "MOBILE" } }),
    );
  });

  void it("summarizes tables with the same arithmetic as the gates (weighted, derived)", () => {
    const rows = [
      row({ query: "q", date: "2026-09-10", clicks: 2, impressions: 10, position: 8 }),
      row({ query: "q", date: "2026-09-11", clicks: 6, impressions: 90, position: 2 }),
      row({ query: "z", date: "2026-09-11", clicks: 0, impressions: 0, position: 0 }),
    ];
    const summary = summarizeByDimension(rows, "query");
    const q = summary[0];
    assert.ok(q);
    assert.equal(q.key, "q");
    assert.equal(q.clicks, 8);
    assert.equal(q.impressions, 100);
    assert.equal(q.ctr, 0.08, "CTR is derived from sums, never averaged");
    assert.equal(q.position, (8 * 10 + 2 * 90) / 100, "position is impression-weighted");
    assert.equal(q.days, 2);
    const z = summary.at(-1);
    assert.ok(z);
    assert.equal(z.ctr, 0, "zero impressions never produce NaN");
    assert.equal(z.position, 0);
  });
});
