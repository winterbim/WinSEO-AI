export {
  configurePool,
  getPool,
  closePool,
  query,
  withTransaction,
  withTenant,
  withAdmin,
  currentConfig,
  healthCheck,
} from "./client.ts";
export type { DbConfig } from "./client.ts";

export { setTenant, clearTenant } from "./tenant.ts";

export {
  createUser,
  findUserByEmail,
  findUserById,
  createOrganization,
  getOrganizationForMember,
  getMembershipRole,
  listOrganizationsForUser,
  createProject,
  createProjectWithIdempotencyKey,
  getProject,
  listProjects,
  createPublicScan,
  getPublicScan,
  updatePublicScanResult,
  createCrawlRun,
  finishCrawlRun,
  addFinding,
  addEvidence,
  listFindings,
  getFinding,
  getFindingEvidence,
  linkFindingEvidence,
  listEvidence,
  listCrawlRuns,
  createDetectedAction,
  createMeasuredGscWorkflow,
  GscMeasurementSnapshotChangedError,
  GscMeasurementWorkflowAdvancedError,
} from "./repositories.ts";
export type {
  UserRow,
  OrganizationRow,
  ProjectRow,
  IdempotentProjectCreation,
  PublicScanRow,
  FindingInsert,
  FindingRow,
  EvidenceInsert,
  EvidenceRow,
  CrawlRunRow,
} from "./repositories.ts";

export { listActions, getAction, transitionAction, ActionMutationError } from "./actions.ts";
export type {
  ActionActor,
  ActionEvidenceRow,
  ActionHistoryRow,
  ActionRecord,
  ActionTransitionInput,
} from "./actions.ts";

// ─── GSC (live Google Search Console) ───
export {
  createOauthState,
  consumeOauthState,
  upsertCredential,
  getCredential,
  updateCredentialTokens,
  deleteCredential,
  createConnection,
  listConnections,
  getConnection,
  disconnectConnection,
  markConnectionSynced,
  createOrReuseJob,
  getJob,
  listJobs,
  claimJob,
  updateJob,
  persistMetricWindow,
  loadMetricRows,
  metricSeries,
  metricFreshness,
  GscTenantScopeError,
  GscAlreadyConnectedError,
  GscMeasurementWindowTooLargeError,
  GscSyncAttemptLostError,
  GSC_SYNC_JOB_LEASE_MS,
} from "./gsc.ts";
export type {
  GscCredentialRow,
  GscConnectionRow,
  GscSyncJobRow,
  GscMetricInput,
  GscMetricFilters,
  GscWindow,
  GscDailyPoint,
  GscFreshness,
  GscJobPatch,
  GscOauthStateInput,
} from "./gsc.ts";

export { consumeRateLimitWindow, releaseRateLimitWindow } from "./rate-limit.ts";
export type { RateLimitWindowHit } from "./rate-limit.ts";

export { createPatch, getPatch, listPatches, updatePatch } from "./patches.ts";
export type { PersistedPatch, PatchEventInput } from "./patches.ts";
export {
  getMfa,
  beginMfaEnrollment,
  confirmMfaEnrollment,
  consumeMfaCounter,
  disableMfa,
} from "./mfa.ts";
export type { MfaRow } from "./mfa.ts";

export {
  createAiVisibilityImport,
  getAiVisibilityImport,
  listAiVisibilityCaptures,
  listAiVisibilityImports,
  listAiVisibilityStats,
  AiVisibilityDuplicateImportError,
  AiVisibilityPermissionError,
  AiVisibilityProjectScopeError,
} from "./ai-visibility.ts";
export type { AiVisibilityCaptureRow, AiVisibilityImportRow } from "./ai-visibility.ts";
