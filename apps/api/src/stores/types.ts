// ─── API store contracts ───
// The API depends on these interfaces, never on a concrete store.
// Production uses the PostgreSQL-backed store (stores/db.ts) which delegates to
// @serpvera/db where RLS enforces tenant isolation at the database boundary.
// stores/memory.ts exists ONLY for unit tests and local smoke runs and is
// explicitly labeled as such.

import type { OrgRole } from "@serpvera/contracts";
import type { ActionActor, ActionRecord, ActionTransitionInput } from "@serpvera/db";
import type { RateLimitDecision } from "../rate-limit.ts";
import type { PatchActor, PatchProposal } from "../autofix/workflow.ts";

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  name: string | null;
}

export interface StoredOrganization {
  id: string;
  name: string;
  slug: string;
}

export interface StoredProject {
  id: string;
  organizationId: string;
  name: string;
  primaryDomain: string;
}

export interface StoredPublicScan {
  id: string;
  domain: string;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: string;
  completedAt: string | null;
  findings: unknown[];
  evidence: unknown[];
  error: string | null;
}

export class DuplicateEmailError extends Error {
  constructor() {
    super("An account with this email already exists.");
    this.name = "DuplicateEmailError";
  }
}

export class DuplicateSlugError extends Error {
  constructor() {
    super("An organization with this slug already exists.");
    this.name = "DuplicateSlugError";
  }
}

export interface UserStore {
  createUser(email: string, passwordHash: string, name?: string): Promise<StoredUser>;
  findByEmail(email: string): Promise<StoredUser | null>;
  findById(id: string): Promise<StoredUser | null>;
}

export interface OrgStore {
  /** Creates the org AND grants requester OWNER membership atomically. */
  createOrganization(ownerUserId: string, name: string, slug: string): Promise<StoredOrganization>;
  /** Returns the org only if userId is an active member — else null. */
  getForRequester(userId: string, organizationId: string): Promise<StoredOrganization | null>;
  /** Returns the caller's role within the org, or null when not an active member. */
  getRoleForUser(userId: string, organizationId: string): Promise<OrgRole | null>;
  /** Orgs the user is an active member of (workspace switcher / first select). */
  listForUser(userId: string): Promise<StoredOrganization[]>;
}

export interface ProjectStore {
  createProject(
    organizationId: string,
    name: string,
    primaryDomain: string,
  ): Promise<StoredProject>;
  /** RLS/tenant-scoped: returns null when the project belongs to another org. */
  getProject(organizationId: string, projectId: string): Promise<StoredProject | null>;
  /** All projects of the active org (RLS-filtered). */
  listProjects(organizationId: string): Promise<StoredProject[]>;
}

export interface ScanStore {
  createPublicScan(domain: string): Promise<StoredPublicScan>;
  getPublicScan(id: string): Promise<StoredPublicScan | null>;
  markRunning(id: string): Promise<void>;
  updateResult(
    id: string,
    status: "completed" | "failed",
    findings: unknown[],
    evidence: unknown[],
    error?: string,
  ): Promise<void>;
}

export interface RateLimitStore {
  /** Atomically consume one IP quota unit in the shared backing store. */
  hit(ip: string, limitPerWindow: number): Promise<RateLimitDecision>;
}

// ─── Server-side sessions (P-GAP-05) ───
// The cookie holds ONLY an opaque random token; all session state lives here.
// get() returns null for unknown, revoked, AND expired tokens — one semantics.
export interface StoredSession {
  userId: string;
  email: string;
  organizationId?: string;
  role?: OrgRole;
  expiresAt: Date;
  stepUpVerifiedAt?: string;
  stepUpMfaCounter?: number;
}

export interface SessionStore {
  create(
    tokenHash: string,
    userId: string,
    email: string,
    expiresAt: Date,
    organizationId?: string,
    role?: OrgRole,
  ): Promise<void>;
  /** Null when unknown, revoked or expired. */
  get(tokenHash: string): Promise<StoredSession | null>;
  /** Store a server-verified TOTP step-up proof on this opaque session only. */
  setStepUp(tokenHash: string, verifiedAt: string, counter: number): Promise<void>;
  /** Rotate tenant context onto an existing session (still server-authoritative). */
  setOrg(tokenHash: string, organizationId: string, role: OrgRole): Promise<void>;
  /** Server-side revocation: the presented cookie becomes invalid immediately. */
  revoke(tokenHash: string): Promise<void>;
  /** Revoke every session of a user (logout-all / account compromise). */
  revokeAllForUser(userId: string): Promise<number>;
}

export interface MfaRecord {
  encryptedSecret: string;
  enabledAt: string | null;
  enrollmentExpiresAt: string | null;
  lastCounter: number;
}

/** User-scoped TOTP storage. The seed is always envelope-encrypted at rest. */
export interface MfaStore {
  get(userId: string): Promise<MfaRecord | null>;
  beginEnrollment(userId: string, encryptedSecret: string, expiresAt: string): Promise<boolean>;
  confirmEnrollment(userId: string, counter: number): Promise<boolean>;
  consumeCounter(userId: string, counter: number): Promise<boolean>;
  disable(userId: string, counter: number): Promise<boolean>;
}

export interface PatchStore {
  create(input: {
    organizationId: string;
    projectId: string;
    findingId: string;
    actor: PatchActor;
    proposal: PatchProposal;
    fixtureHtml: string;
  }): Promise<void>;
  get(
    organizationId: string,
    patchId: string,
  ): Promise<{
    proposal: PatchProposal;
    fixtureHtml: string;
    eventCount: number;
  } | null>;
  list(organizationId: string, projectId: string): Promise<PatchProposal[]>;
  save(input: {
    organizationId: string;
    patchId: string;
    expectedVersion: number;
    previousEventCount: number;
    proposal: PatchProposal;
    fixtureHtml: string;
  }): Promise<boolean>;
}

export interface ApiStores {
  users: UserStore;
  orgs: OrgStore;
  projects: ProjectStore;
  scans: ScanStore;
  rateLimits: RateLimitStore;
  sessions: SessionStore;
  mfa: MfaStore;
  crawl: CrawlStore;
  actions: ActionStore;
  patches: PatchStore;
  /**
   * Google Search Console access. Deliberately OPTIONAL: the in-memory driver
   * provides no GSC store, because Google token material must exist only as
   * envelope-encrypted rows in PostgreSQL. Routes answer 501 when absent rather
   * than degrading to an in-process placeholder that a restart would erase.
   */
  gsc?: GscStore;
}

// ─── Project crawl runs / findings / evidence (P-GAP-04, Evidence Ledger) ───
// Tenant-scoped: every method takes organizationId and the DB layer enforces it
// with RLS (withTenant: SET ROLE serpvera_app + org GUC per transaction).
export interface StoredFinding {
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
  /** URLs the rule fired on (Blueprint §1.2 scope). */
  affectedUrls: string[];
  /** Gate declared by the rule contract (Blueprint §13.2). */
  verificationGate: string;
  /** State of the linked action (state machine Blueprint §17.1), if any. */
  actionState?: string | null;
}

export interface FindingInput {
  ruleId: string;
  ruleVersion: string;
  title: string;
  epistemicClass: string;
  severity: string;
  explanation?: string;
  recommendation?: string;
  affectedUrls: string[];
  verificationGate: string;
  crawlRunId?: string;
}

export interface EvidenceInput {
  kind: string;
  sourceRef: string;
  contentHash: string;
  objectKey: string;
  metadata?: Record<string, unknown>;
  crawlRunId?: string;
}

export interface StoredEvidence {
  id: string;
  kind: string;
  sourceRef: string;
  contentHash: string;
  objectKey: string;
  capturedAt: string;
  metadata: Record<string, unknown>;
}

export interface StoredCrawlRun {
  id: string;
  status: string;
  mode: string;
  startedAt: string;
  completedAt: string | null;
  pagesCrawled: number;
  pagesFailed: number;
}

export interface StoredFindingDetail extends StoredFinding {
  projectId: string;
  /** Evidence rows linked to this finding (relation 'supports'). */
  evidence: StoredEvidence[];
}

export interface CrawlStore {
  createCrawlRun(organizationId: string, projectId: string, mode: string): Promise<{ id: string }>;
  finishCrawlRun(
    organizationId: string,
    runId: string,
    status: "completed" | "failed",
    pagesCrawled: number,
    pagesFailed: number,
  ): Promise<void>;
  listCrawlRuns(organizationId: string, projectId: string): Promise<StoredCrawlRun[]>;
  addFinding(
    organizationId: string,
    projectId: string,
    finding: FindingInput,
  ): Promise<{ id: string }>;
  addEvidence(
    organizationId: string,
    projectId: string,
    evidence: EvidenceInput,
  ): Promise<{ id: string }>;
  listFindings(organizationId: string, projectId: string): Promise<StoredFinding[]>;
  /** Finding detail incl. linked evidence (RLS-scoped; null when foreign). */
  getFinding(organizationId: string, findingId: string): Promise<StoredFindingDetail | null>;
  /** Record that `evidenceId` supports `findingId` (Blueprint §11.3). */
  linkFindingEvidence(organizationId: string, findingId: string, evidenceId: string): Promise<void>;
  /** Evidence items of a project (drawer listing). */
  listEvidence(organizationId: string, projectId: string): Promise<StoredEvidence[]>;
  /** Create the workflow entry for a finding in state DETECTED (§17.1). */
  createDetectedAction(
    organizationId: string,
    projectId: string,
    findingId: string,
  ): Promise<{ id: string }>;
}

export type StoredAction = ActionRecord;

export interface ActionStore {
  listActions(
    organizationId: string,
    projectId: string,
    filters?: { state?: ActionRecord["state"]; severity?: string },
  ): Promise<ActionRecord[]>;
  getAction(organizationId: string, actionId: string): Promise<ActionRecord | null>;
  transitionAction(
    organizationId: string,
    actionId: string,
    actor: ActionActor,
    input: ActionTransitionInput,
  ): Promise<ActionRecord>;
}

// ─── GSC (live Google Search Console) ───
// Every method is organization-scoped. Token material appears here ONLY as
// envelope ciphertext: decryption happens in memory inside the integration
// layer, and no route serialises these fields.

export interface StoredGscConnection {
  id: string;
  projectId: string;
  externalProperty: string;
  scope: string;
  credentialRef: string | null;
  status: string;
  connectedAt: string | null;
  lastSyncAt: string | null;
}

export interface StoredGscJob {
  id: string;
  projectId: string;
  connectionId: string;
  windowStart: string;
  windowEnd: string;
  status: string;
  rowCount: number;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  nextRetryAt: string | null;
}

export interface StoredGscCredential {
  id: string;
  projectId: string;
  encryptedRefreshToken: string;
  encryptedAccessToken: string;
  accessTokenExpiresAt: string;
  scope: string;
  googleSubject: string | null;
}

export interface GscMetricPoint {
  date: string;
  query: string;
  page: string;
  country: string;
  device: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscDailyPoint {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscFreshness {
  latestMetricDate: string | null;
  lastSyncAt: string | null;
  totalRows: number;
}

export interface GscWindowRange {
  startDate: string;
  endDate: string;
}

export interface GscMetricFilter {
  query?: string;
  page?: string;
  device?: string;
  country?: string;
}

export interface GscCredentialInput {
  organizationId: string;
  projectId: string;
  encryptedRefreshToken: string;
  encryptedAccessToken: string;
  accessTokenExpiresAt: string;
  scope: string;
  googleSubject: string | null;
}

export interface GscStore {
  createOauthState(input: {
    organizationId: string;
    projectId: string;
    stateHash: string;
    codeVerifier: string;
    expiresAt: string;
  }): Promise<void>;
  /** Atomic single-use claim: null for unknown, replayed or expired states. */
  consumeOauthState(
    organizationId: string,
    stateHash: string,
  ): Promise<{ projectId: string; codeVerifier: string } | null>;

  upsertCredential(input: GscCredentialInput): Promise<string>;
  getCredential(organizationId: string, projectId: string): Promise<StoredGscCredential | null>;
  updateCredentialTokens(input: {
    organizationId: string;
    projectId: string;
    encryptedAccessToken: string;
    accessTokenExpiresAt: string;
    encryptedRefreshToken?: string;
  }): Promise<boolean>;
  deleteCredential(organizationId: string, projectId: string): Promise<boolean>;

  createConnection(input: {
    organizationId: string;
    projectId: string;
    externalProperty: string;
    scope?: string;
    credentialRef: string;
  }): Promise<StoredGscConnection>;
  listConnections(organizationId: string, projectId: string): Promise<StoredGscConnection[]>;
  getConnection(organizationId: string, connectionId: string): Promise<StoredGscConnection | null>;
  disconnectConnection(organizationId: string, connectionId: string): Promise<boolean>;
  markConnectionSynced(organizationId: string, connectionId: string, at: string): Promise<void>;

  createOrReuseJob(input: {
    organizationId: string;
    projectId: string;
    connectionId: string;
    windowStart: string;
    windowEnd: string;
    idempotencyKey: string;
  }): Promise<StoredGscJob>;
  getJob(organizationId: string, jobId: string): Promise<StoredGscJob | null>;
  listJobs(organizationId: string, projectId: string): Promise<StoredGscJob[]>;
  updateJob(
    organizationId: string,
    jobId: string,
    patch: {
      status?: string;
      startedAt?: string;
      completedAt?: string;
      rowCount?: number;
      errorCode?: string | null;
      errorMessage?: string | null;
      attempt?: number;
      nextRetryAt?: string | null;
    },
  ): Promise<boolean>;

  persistMetricWindow(input: {
    organizationId: string;
    projectId: string;
    syncJobId: string;
    window: GscWindowRange;
    rows: readonly GscMetricPoint[];
  }): Promise<number>;
  loadMetricRows(
    organizationId: string,
    projectId: string,
    window: GscWindowRange,
    filters?: GscMetricFilter,
  ): Promise<GscMetricPoint[]>;
  metricSeries(
    organizationId: string,
    projectId: string,
    window: GscWindowRange,
    filters?: GscMetricFilter,
  ): Promise<GscDailyPoint[]>;
  metricFreshness(organizationId: string, projectId: string): Promise<GscFreshness>;
}
