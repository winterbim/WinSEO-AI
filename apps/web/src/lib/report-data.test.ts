import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aiVisibilityReportState,
  gscReportState,
  type AiVisibilityReportResponse,
} from "./report-data.ts";
import type { GscSummary } from "./types.ts";

const emptyAiHistory: AiVisibilityReportResponse = {
  imports: [],
  dataAvailability: {
    source: "USER_SUPPLIED",
    epistemicClass: "DOCUMENTED",
    unverified_by_provider: true,
    promptPanelCompleteness: "UNKNOWN",
    basis: "persisted imported captures only",
  },
};

const emptyGscSummary: GscSummary = {
  window: { startDate: "2026-09-01", endDate: "2026-09-30" },
  syncCoverage: "SYNCED",
  property: "sc-domain:example.com",
  filters: {},
  totals: { clicks: 0, impressions: 0, ctr: 0, position: 0, days: 0 },
  series: [],
  freshness: { latestMetricDate: null, lastSyncAt: "2026-10-01T00:00:00.000Z", totalRows: 0 },
};

void describe("report data states", () => {
  void it("distinguishes a successful empty AI import history from an API failure", () => {
    assert.equal(aiVisibilityReportState(emptyAiHistory, false), "empty");
    assert.equal(aiVisibilityReportState(null, true), "unavailable");
    assert.equal(aiVisibilityReportState(emptyAiHistory, true), "unavailable");
  });

  void it("requires locally synchronized GSC windows and returned rows before showing metrics", () => {
    assert.equal(gscReportState(null, true), "unavailable");
    assert.equal(
      gscReportState(
        { ...emptyGscSummary, syncCoverage: "NO_UNIQUE_PROPERTY", property: null },
        false,
      ),
      "not-connected",
    );
    assert.equal(
      gscReportState(
        {
          ...emptyGscSummary,
          syncCoverage: "INCOMPLETE",
          series: [
            {
              date: "2026-09-01",
              clicks: 0,
              impressions: 0,
              ctr: 0,
              position: 0,
            },
          ],
        },
        false,
      ),
      "incomplete",
    );
    assert.equal(
      gscReportState({ ...emptyGscSummary, totals: null }, false),
      "incomplete",
      "a missing aggregate cannot be rendered as a complete measurement",
    );
    assert.equal(gscReportState(emptyGscSummary, false), "no-rows");
    assert.equal(
      gscReportState(
        {
          ...emptyGscSummary,
          totals: { clicks: 1, impressions: 12, ctr: 1 / 12, position: 3, days: 1 },
          series: [{ date: "2026-09-01", clicks: 1, impressions: 12, ctr: 1 / 12, position: 3 }],
        },
        false,
      ),
      "measured",
    );
  });
});
