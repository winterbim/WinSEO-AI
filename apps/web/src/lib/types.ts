// ─── Dashboard data shapes (mirrors the control-plane responses) ───

export interface Project {
  id: string;
  name: string;
  primaryDomain: string;
}

export type SeverityCounts = Record<string, number>;

export interface Overview {
  project: Project;
  findings: {
    total: number;
    bySeverity: SeverityCounts;
    byStatus: Record<string, number>;
    latest: {
      id: string;
      title: string;
      severity: string;
      ruleId: string;
      firstSeenAt: string;
    } | null;
  };
  evidence: { total: number };
  crawls: {
    total: number;
    latest: CrawlRun | null;
  };
  interventions: { verified: number; pending: number; note: string };
  dataFreshness: string;
  methodVersion: string;
}

export interface FindingSummary {
  id: string;
  ruleId: string;
  ruleVersion: string;
  title: string;
  epistemicClass: string;
  severity: string;
  status: string;
  confidence: number;
  explanation?: string;
  recommendation?: string;
  firstSeenAt: string;
  affectedUrls: string[];
  verificationGate: string;
  actionState?: string | null;
}

export interface EvidenceItem {
  id: string;
  kind: string;
  sourceRef: string;
  contentHash: string;
  objectKey: string;
  capturedAt: string;
  metadata: Record<string, unknown>;
}

export interface FindingDetail extends FindingSummary {
  projectId: string;
  evidence: EvidenceItem[];
}

export interface CrawlRun {
  id: string;
  status: string;
  mode: string;
  startedAt: string;
  completedAt: string | null;
  pagesCrawled: number;
  pagesFailed: number;
  pageLimit: number | null;
  stopReason: string | null;
  templateGroups: CrawlTemplateGroup[] | null;
}

export interface CrawlTemplateGroup {
  id: string;
  routePattern: string;
  domSignatureHash: string | null;
  pageCount: number;
  sampleUrls: string[];
  groupingMethod:
    | "URL_PATTERN_AND_SEMANTIC_DOM_V2"
    | "URL_PATTERN_ONLY_PRIVACY_SINGLETON_V2"
    | "SEMANTIC_DOM_PRIVACY_SINGLETON_V1";
}

export type ActionState =
  | "DETECTED"
  | "EVIDENCED"
  | "PROPOSED"
  | "APPROVED"
  | "REPORTED_MANUALLY"
  | "MEASURING"
  | "VERIFIED"
  | "REJECTED"
  | "INCONCLUSIVE"
  | "CLOSED";

export interface ActionHistory {
  id: string;
  fromState: ActionState;
  toState: ActionState;
  actorUserId: string | null;
  actorEmail: string | null;
  payload: Record<string, unknown>;
  actionVersion: number;
  createdAt: string;
}

export interface ActionItem {
  id: string;
  projectId: string;
  findingId: string;
  findingTitle: string;
  severity: string;
  ruleId: string;
  affectedUrls: string[];
  state: ActionState;
  version: number;
  recommendationVersion: string;
  recommendation: Record<string, unknown> | null;
  verificationGate: string;
  implementation: Record<string, unknown> | null;
  rollback: Record<string, unknown> | null;
  baseline: Record<string, unknown> | null;
  comparisonWindow: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  priorityIndex: number;
  createdAt: string;
  updatedAt: string | null;
  evidence: EvidenceItem[];
  history: ActionHistory[];
}

export const ACTION_STATES: ActionState[] = [
  "DETECTED",
  "EVIDENCED",
  "PROPOSED",
  "APPROVED",
  "REPORTED_MANUALLY",
  "MEASURING",
  "VERIFIED",
  "REJECTED",
  "INCONCLUSIVE",
  "CLOSED",
];

export const ACTION_STATE_STYLES: Record<ActionState, string> = {
  DETECTED: "bg-slate-700/10 text-slate-700",
  EVIDENCED: "bg-primary/10 text-primary",
  PROPOSED: "bg-geo/10 text-geo",
  APPROVED: "bg-primary/10 text-primary",
  REPORTED_MANUALLY: "bg-warning/10 text-warning",
  MEASURING: "bg-warning/10 text-warning",
  VERIFIED: "bg-verified/10 text-verified",
  REJECTED: "bg-critical/10 text-critical",
  INCONCLUSIVE: "bg-slate-700/10 text-slate-700",
  CLOSED: "bg-ink-950 text-white",
};

export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

export const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-critical/10 text-critical",
  high: "bg-critical/10 text-critical",
  medium: "bg-warning/10 text-warning",
  low: "bg-slate-700/10 text-slate-700",
  info: "bg-primary/10 text-primary",
};

/** NEXUS doctrine — never invented, never collapsed into a score. */
export const EPISTEMIC_STYLES: Record<string, string> = {
  OBSERVED: "bg-verified/10 text-verified",
  MEASURED: "bg-verified/10 text-verified",
  DOCUMENTED: "bg-primary/10 text-primary",
  INFERRED: "bg-geo/10 text-geo",
  HYPOTHESIS: "bg-warning/10 text-warning",
  UNKNOWN: "bg-slate-700/10 text-slate-700",
};

// ─── Google Search Console (first-party measurements only) ───
// Every shape mirrors the control plane's GSC responses. Nothing here is ever
// synthesized client-side: empty or blocked states render as exactly that.

export interface GscWindow {
  startDate: string;
  endDate: string;
}

export interface GscFreshness {
  latestMetricDate: string | null;
  lastSyncAt: string | null;
  totalRows: number;
}

export interface GscDailyPoint {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  days: number;
}

export interface GscSummary {
  window: GscWindow;
  property?: string | null;
  filters: Record<string, string>;
  totals: GscTotals;
  series: GscDailyPoint[];
  freshness: GscFreshness;
}

export interface GscDimensionRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  days: number;
}

export interface GscBreakdown {
  window: GscWindow;
  filters: Record<string, string>;
  dimension: "query" | "page";
  rows: GscDimensionRow[];
  totalGroups: number;
  sourceRows: number;
  freshness: GscFreshness;
}

export interface GscMeasuredRecommendation {
  module: string;
  subject: { query?: string; page?: string; device?: string; country?: string };
  title: string;
  rationale: string;
  datasetWindow: GscWindow;
  filters: Record<string, string | number | boolean>;
  comparisonWindow?: GscWindow;
  observed: Record<string, number | string>;
  baseline?: Record<string, number | string>;
  delta?: Record<string, number>;
  evidenceClass: "MEASURED";
  verificationGate: {
    type: string;
    spec: {
      metric: string;
      operator: string;
      threshold: number;
      query?: string;
      page?: string;
      minImpressions: number;
      windowDays: number;
    };
  };
  severity: string;
}

export interface GscIntelligence {
  module: string;
  window: GscWindow;
  comparisonWindow: GscWindow;
  filters: Record<string, string>;
  recommendations: GscMeasuredRecommendation[];
  counts: { total: number; measured: number };
  freshness: GscFreshness;
}

export interface GscConnection {
  id: string;
  externalProperty: string;
  scope: string;
  status: string;
  connectedAt: string | null;
  lastSyncAt: string | null;
}

export interface GscJob {
  id: string;
  connectionId: string;
  windowStart: string;
  windowEnd: string;
  status: string;
  rowCount: number;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  requestedAt: string;
  completedAt: string | null;
  nextRetryAt: string | null;
}

export interface GscBeforeAfter {
  actionId: string;
  state: string;
  gate: string;
  subject: Record<string, string>;
  baselineWindow: GscWindow;
  measurementWindow: GscWindow;
  comparison: GscMeasuredRecommendation | null;
  verification: Record<string, unknown> | null;
  freshness: GscFreshness;
}
