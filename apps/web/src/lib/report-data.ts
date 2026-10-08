import type { AiVisibilityStat } from "@serpvera/contracts";
import type { GscSummary } from "./types.ts";

export interface AiVisibilityReportImport {
  id: string;
  csvSha256: string;
  rowCount: number;
  createdAt: string;
  provenance: "USER_SUPPLIED";
  epistemicClass: "DOCUMENTED";
  unverified_by_provider: true;
  stats: AiVisibilityStat[];
}

export interface AiVisibilityReportResponse {
  imports: AiVisibilityReportImport[];
  dataAvailability: {
    source: "USER_SUPPLIED";
    epistemicClass: "DOCUMENTED";
    unverified_by_provider: true;
    promptPanelCompleteness: "UNKNOWN";
    basis: string;
  };
}

export type AiVisibilityReportState = "unavailable" | "empty" | "available";

export function aiVisibilityReportState(
  response: AiVisibilityReportResponse | null,
  unavailable: boolean,
): AiVisibilityReportState {
  if (unavailable || response === null) return "unavailable";
  return response.imports.length === 0 ? "empty" : "available";
}

export type GscReportState =
  "unavailable" | "not-connected" | "incomplete" | "no-rows" | "measured";

export function gscReportState(summary: GscSummary | null, unavailable: boolean): GscReportState {
  if (unavailable || summary === null) return "unavailable";
  if (summary.syncCoverage === "NO_UNIQUE_PROPERTY" || !summary.property) return "not-connected";
  if (summary.syncCoverage !== "SYNCED" || summary.totals === null) return "incomplete";
  return summary.series.length === 0 ? "no-rows" : "measured";
}
