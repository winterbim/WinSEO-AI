import type { FindingSummary, GscMeasuredRecommendation } from "./types";

export type DecisionLane =
  | "FIX_NOW"
  | "GROW"
  | "REFRESH"
  | "CONSOLIDATE_REVIEW"
  | "WATCH";

export interface DecisionItem {
  id: string;
  lane: DecisionLane;
  title: string;
  reason: string;
  evidenceClass: "OBSERVED" | "MEASURED";
  source: "crawl" | "gsc";
  severity: string;
  affectedUrls: string[];
  href: string;
  priority: number;
}

export interface DecisionCenter {
  items: DecisionItem[];
  counts: Record<DecisionLane, number>;
}

const severityWeight: Record<string, number> = {
  critical: 100,
  high: 80,
  medium: 60,
  low: 35,
  info: 20,
};

function crawlLane(finding: FindingSummary): DecisionLane {
  if (finding.severity === "critical" || finding.severity === "high") return "FIX_NOW";
  if (
    finding.ruleId.startsWith("CRAWL.") ||
    finding.ruleId.startsWith("TECH.") ||
    finding.ruleId.startsWith("STRUCTURED_DATA.")
  ) {
    return finding.severity === "medium" ? "FIX_NOW" : "WATCH";
  }
  return "WATCH";
}

function gscLane(rec: GscMeasuredRecommendation): DecisionLane {
  switch (rec.module) {
    case "query_cannibalization":
      return "CONSOLIDATE_REVIEW";
    case "page_query_decay":
      return "REFRESH";
    case "winners_losers":
      return typeof rec.delta?.clicks === "number" && rec.delta.clicks < 0 ? "REFRESH" : "GROW";
    case "high_impressions_low_ctr":
    case "ranking_opportunity":
    case "emerging_queries":
    case "page_query_intersections":
      return "GROW";
    default:
      return "WATCH";
  }
}

function gscPriority(rec: GscMeasuredRecommendation, lane: DecisionLane): number {
  const base = severityWeight[rec.severity] ?? 40;
  const laneBoost: Record<DecisionLane, number> = {
    FIX_NOW: 30,
    REFRESH: 20,
    CONSOLIDATE_REVIEW: 15,
    GROW: 10,
    WATCH: 0,
  };
  const impressions =
    typeof rec.observed.impressions === "number" ? rec.observed.impressions : 0;
  return base + laneBoost[lane] + Math.min(20, Math.log10(Math.max(1, impressions)) * 4);
}

export function buildDecisionCenter(
  projectId: string,
  findings: readonly FindingSummary[],
  recommendations: readonly GscMeasuredRecommendation[],
): DecisionCenter {
  const crawlItems: DecisionItem[] = findings
    .filter((finding) => finding.status === "open")
    .map((finding) => {
      const lane = crawlLane(finding);
      return {
        id: `crawl:${finding.id}`,
        lane,
        title: finding.title,
        reason:
          finding.recommendation ??
          finding.explanation ??
          "Observed crawl finding. Inspect the evidence before changing the page.",
        evidenceClass: "OBSERVED",
        source: "crawl",
        severity: finding.severity,
        affectedUrls: finding.affectedUrls,
        href: `/dashboard/${projectId}/findings/${finding.id}`,
        priority: (severityWeight[finding.severity] ?? 40) + (lane === "FIX_NOW" ? 30 : 0),
      };
    });

  const gscItems: DecisionItem[] = recommendations.map((rec, index) => {
    const lane = gscLane(rec);
    const scope = [rec.subject.query, rec.subject.page].filter(Boolean).join(" · ");
    return {
      id: `gsc:${rec.module}:${scope || index}`,
      lane,
      title: rec.title,
      reason: rec.rationale,
      evidenceClass: "MEASURED",
      source: "gsc",
      severity: rec.severity,
      affectedUrls: rec.subject.page ? [rec.subject.page] : [],
      href: `/dashboard/${projectId}/search-performance/opportunities`,
      priority: gscPriority(rec, lane),
    };
  });

  const seen = new Set<string>();
  const items = [...crawlItems, ...gscItems]
    .filter((item) => {
      const key = `${item.lane}|${item.title}|${item.affectedUrls.join("|")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title));

  const counts: Record<DecisionLane, number> = {
    FIX_NOW: 0,
    GROW: 0,
    REFRESH: 0,
    CONSOLIDATE_REVIEW: 0,
    WATCH: 0,
  };
  for (const item of items) counts[item.lane]++;

  return { items, counts };
}
