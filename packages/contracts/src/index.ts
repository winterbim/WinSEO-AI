// ─── Epistemic classification ───
export type EpistemicClass =
  "OBSERVED" | "MEASURED" | "DOCUMENTED" | "INFERRED" | "HYPOTHESIS" | "UNKNOWN";

// ─── Severity ───
export type Severity = "critical" | "high" | "medium" | "low" | "info";

// ─── Finding ───
export interface FindingScope {
  urlIds?: string[];
  entityIds?: string[];
  queryClusterIds?: string[];
}

export interface Finding {
  findingId: string;
  projectId: string;
  ruleId: string;
  ruleVersion: string;
  title: string;
  epistemicClass: EpistemicClass;
  severity: Severity;
  status: "open" | "acknowledged" | "in_progress" | "resolved" | "wont_fix";
  confidence: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
  scope: FindingScope;
  explanation: string;
  recommendation?: string;
  affectedUrlsCount: number;
  verificationGate: Gate;
}

// ─── Evidence ───
export interface Evidence {
  evidenceId: string;
  projectId: string;
  kind: EvidenceKind;
  sourceRef: string;
  capturedAt: string;
  contentHash: string;
  objectKey: string;
  contentUrl?: string;
  metadata: Record<string, unknown>;
}

export type EvidenceKind =
  | "html_snapshot"
  | "dom_snapshot"
  | "http_headers"
  | "ai_answer"
  | "gsc_data"
  | "screenshot"
  | "structured_data";

export {
  AI_VISIBILITY_MAX_CSV_BYTES,
  AI_VISIBILITY_MAX_ROWS,
  computeAiVisibilityStats,
  parseAiVisibilityCsv,
  wilsonInterval95,
} from "./ai-visibility.ts";
export type { AiVisibilityCapture, AiVisibilityStat } from "./ai-visibility.ts";

// ─── Gate ───
export interface Gate {
  gateType: GateType;
  spec: Record<string, unknown>;
  lastVerdict?: GateVerdict;
}

export type GateType =
  "recrawl_rule_absent" | "gsc_window" | "ai_search_rerun" | "indexation_check" | "custom";

export type GateVerdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "BLOCKED";

// ─── Action ───
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

export interface Action {
  actionId: string;
  projectId: string;
  findingId: string;
  recommendationVersion: string;
  priorityIndex: number;
  state: ActionState;
  ownerUserId?: string;
  businessValue: number;
  evidenceStrength: number;
  impactHypothesis: number;
  confidence: number;
  effort: number;
  riskFactor: number;
  expectedGate: Gate;
}

// ─── API Envelope ───
export interface ApiResponse<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: ApiMeta;
}

export interface ApiMeta {
  dataFreshness: string;
  methodVersion: string;
  limitations: string[];
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: ApiMeta & { nextCursor?: string; hasMore: boolean };
}

// ─── Organization & Project ───
export interface Organization {
  id: string;
  name: string;
  slug: string;
  planId: string;
  region: string;
  createdAt: string;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  primaryDomain: string;
  timezone: string;
  defaultLocale: string;
  status: string;
  createdAt: string;
}

// ─── Crawl ───
export type CrawlMode = "HTTP_FAST" | "FULL";
export type SeedStrategy = "SITEMAP" | "LINK_DISCOVERY";

export interface CrawlRun {
  id: string;
  projectId: string;
  mode: CrawlMode;
  seedStrategy: SeedStrategy;
  engineVersion: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  pagesCrawled: number;
  pagesFailed: number;
  pageLimit?: number | null;
  stopReason?: string | null;
}

// ─── GSC ───
export interface GscProperty {
  id: string;
  projectId: string;
  externalProperty: string;
  scope: string;
  connectedAt: string;
  lastSyncAt?: string;
}

export interface GscDailyRow {
  date: string;
  queryHash?: string;
  pageUrlId?: string;
  country?: string;
  device?: string;
  searchType: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  dataState: "FINAL" | "PRELIMINARY";
}

// ─── AI Search / GEO ───
export interface PromptSet {
  id: string;
  projectId: string;
  name: string;
  version: number;
  frozenAt?: string;
}

export interface AiRun {
  id: string;
  promptVariantId: string;
  engine: string;
  surface: string;
  locale: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
}

export interface Citation {
  id: string;
  aiAnswerId: string;
  citedUrl: string;
  domain: string;
  orderIndex: number;
  sourceClass: SourceClass;
  isClientOwned: boolean;
}

export type SourceClass =
  "owned" | "competitor" | "earned_media" | "forum" | "institution" | "other";

// ─── Organization roles ───
export type OrgRole = "OWNER" | "ADMIN" | "ANALYST" | "EDITOR" | "VIEWER" | "BILLING";

export type Permission =
  | "project.read"
  | "evidence.read"
  | "evidence.write"
  | "integration.manage"
  | "action.approve"
  | "production.write"
  | "billing.manage"
  | "member.manage";

// ─── Plans ───
export type PlanId = "free" | "solo" | "growth" | "studio" | "agency";

export interface Plan {
  id: string;
  name: PlanId;
  priceMonthlyCents: number;
  sitesLimit: number;
  crawlUrlsLimit: number;
  gscEnabled: boolean;
  aiChecksLimit: number;
  historyDays: number;
  exportsEnabled: boolean;
  teamMembersLimit: number;
  competitorLimit: number;
  apiAccess: boolean;
  whiteLabel: boolean;
}
