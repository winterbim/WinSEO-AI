// ─── PostgreSQL-backed API stores ───
// PRODUCTION store. Delegates to @serpvera/db, where PostgreSQL RLS enforces
// tenant isolation at the database boundary (not application WHERE clauses).
// Configured via DbConfig: local dev uses peer socket + runtimeRole=serpvera_app;
// production connects as serpvera_app with a vault-provided password.

import { createHmac } from "node:crypto";
import { parseStoredTemplateGroups } from "./template-groups.ts";
import {
  configurePool,
  closePool,
  createUser,
  findUserByEmail,
  findUserById,
  createOrganization,
  getOrganizationForMember,
  getMembershipRole,
  createProject,
  createProjectWithIdempotencyKey,
  getProject,
  createPublicScan,
  getPublicScan,
  updatePublicScanResult,
  createCrawlRun as createCrawlRunRow,
  finishCrawlRun as finishCrawlRunRow,
  addFinding as insertFindingRow,
  addEvidence as insertEvidenceRow,
  createMeasuredGscWorkflow as insertMeasuredGscWorkflow,
  listFindings as selectFindingRows,
  getFinding as selectFindingRow,
  getFindingEvidence as selectFindingEvidence,
  linkFindingEvidence as insertFindingEvidence,
  listEvidence as selectEvidenceRows,
  listCrawlRuns as selectCrawlRunRows,
  createDetectedAction as insertDetectedAction,
  listActions as selectActions,
  getAction as selectAction,
  transitionAction as updateActionState,
  listProjects as selectProjectRows,
  listOrganizationsForUser as selectOrganizationsForUser,
  createOauthState as insertOauthState,
  consumeOauthState as claimOauthState,
  upsertCredential as saveCredential,
  getCredential as selectCredential,
  updateCredentialTokens as refreshCredentialTokens,
  deleteCredential as removeCredential,
  createConnection as insertConnection,
  listConnections as selectConnections,
  getConnection as selectConnection,
  disconnectConnection as markConnectionDisconnected,
  markConnectionSynced as touchConnectionSync,
  createOrReuseJob as insertOrReuseJob,
  claimJob as claimGscJob,
  getJob as selectJob,
  listJobs as selectJobs,
  updateJob as updateJobRow,
  persistMetricWindow as replaceMetricWindow,
  loadMetricRows as selectMetricRows,
  metricSeries as selectMetricSeries,
  metricFreshness as selectMetricFreshness,
  createPatch as insertPatchRow,
  getPatch as selectPatchRow,
  listPatches as selectPatchRows,
  updatePatch as updatePatchRow,
  getMfa as selectMfaRow,
  beginMfaEnrollment as insertMfaEnrollment,
  confirmMfaEnrollment as enableMfaRow,
  consumeMfaCounter as consumeMfaRowCounter,
  disableMfa as disableMfaRow,
  query,
  consumeRateLimitWindow,
  releaseRateLimitWindow,
  healthCheck,
  createAiVisibilityImport as insertAiVisibilityImport,
  getAiVisibilityImport as selectAiVisibilityImport,
  listAiVisibilityCaptures as selectAiVisibilityCaptures,
  listAiVisibilityImports as selectAiVisibilityImports,
  listAiVisibilityStats as selectAiVisibilityStats,
  type AiVisibilityCaptureRow,
  type AiVisibilityImportRow,
  type DbConfig,
  publicEvidenceMetadata,
} from "@serpvera/db";
import type {
  ApiStores,
  StoredAiVisibilityCapture,
  StoredAiVisibilityImport,
  StoredGscConnection,
  StoredGscCredential,
  StoredGscJob,
  StoredProject,
  StoredPublicScan,
  StoredSession,
  StoredUser,
} from "./types.ts";
import type { PatchProposal } from "../autofix/workflow.ts";
import { DuplicateEmailError, DuplicateSlugError } from "./types.ts";
import { isLoopback } from "../rate-limit.ts";

export const REQUIRED_SCHEMA_MARKERS = [
  "proven_patch_lifecycle",
  "tenant_safe_finding_evidence",
] as const;

export const REQUIRED_PATCH_STATUSES = [
  "detected",
  "proposed",
  "previewed",
  "approved",
  "deploying",
  "deployed",
  "deployed_manually",
  "live_verified",
  "google_observed",
  "measuring",
  "measured",
  "rolled_back",
  "superseded",
  "drifted",
  "failed",
  "rejected",
] as const;

export const REQUIRED_LATEST_MIGRATION = "0032_gsc_trust_reset";

export type RequiredSchemaMarker = (typeof REQUIRED_SCHEMA_MARKERS)[number];

export interface RequiredSchemaCatalogRow {
  patchLifecycle: boolean;
  evidenceTableExists: boolean;
  evidenceOrganizationId: boolean;
  evidenceOrganizationIdNotNull: boolean;
  evidenceRlsEnabled: boolean;
  evidenceRlsForced: boolean;
  evidenceFindingTenantForeignKey: boolean;
  evidenceItemTenantForeignKey: boolean;
  evidenceTenantPolicy: boolean;
}

export interface DatabaseReadiness {
  database: "ready" | "unavailable";
  migrationState: "ready" | "pending" | "unavailable" | "not_checked";
  latestMigration: string | null;
  requiredMigration: string;
  requiredSchemaChecks: "ready" | "pending" | "unavailable" | "not_checked";
  verifiedSchemaMarkers: RequiredSchemaMarker[];
  requiredSchemaMarkers: readonly RequiredSchemaMarker[];
}

export interface MigrationReadinessCatalogRow {
  patchLifecycleApplied: boolean;
  findingEvidenceRlsApplied: boolean;
  readinessViewMigrationApplied: boolean;
  projectCreateIdempotencyApplied: boolean;
  currentReadinessViewApplied: boolean;
  gscPropertyScopingApplied: boolean;
  latestVersion: string | null;
}

interface SchemaCatalogQueryRow extends Omit<RequiredSchemaCatalogRow, "patchLifecycle"> {
  patchLifecycleDefinition: string | null;
}

export function hasCompletePatchLifecycleConstraint(definition: string | null): boolean {
  return (
    definition !== null &&
    REQUIRED_PATCH_STATUSES.every((status) => definition.includes(`'${status}'`))
  );
}

export function verifiedSchemaMarkers(row: RequiredSchemaCatalogRow): RequiredSchemaMarker[] {
  const markers: RequiredSchemaMarker[] = [];
  if (row.patchLifecycle) markers.push("proven_patch_lifecycle");
  if (
    row.evidenceTableExists &&
    row.evidenceOrganizationId &&
    row.evidenceOrganizationIdNotNull &&
    row.evidenceRlsEnabled &&
    row.evidenceRlsForced &&
    row.evidenceFindingTenantForeignKey &&
    row.evidenceItemTenantForeignKey &&
    row.evidenceTenantPolicy
  ) {
    markers.push("tenant_safe_finding_evidence");
  }
  return markers;
}

export function readinessFromSchemaCatalog(row: RequiredSchemaCatalogRow): DatabaseReadiness {
  const markers = verifiedSchemaMarkers(row);
  const complete = REQUIRED_SCHEMA_MARKERS.every((marker) => markers.includes(marker));
  return {
    database: "ready",
    migrationState: "not_checked",
    latestMigration: null,
    requiredMigration: REQUIRED_LATEST_MIGRATION,
    requiredSchemaChecks: complete ? "ready" : "pending",
    verifiedSchemaMarkers: markers,
    requiredSchemaMarkers: REQUIRED_SCHEMA_MARKERS,
  };
}

export function migrationReadinessFromCatalog(
  row: MigrationReadinessCatalogRow,
): Pick<DatabaseReadiness, "migrationState" | "latestMigration" | "requiredMigration"> {
  const versionNumber = (version: string | null): number | null => {
    const match = version?.match(/^(\d+)_/);
    return match ? Number(match[1]) : null;
  };
  const latestNumber = versionNumber(row.latestVersion);
  const requiredNumber = versionNumber(REQUIRED_LATEST_MIGRATION);
  const ready =
    row.patchLifecycleApplied &&
    row.findingEvidenceRlsApplied &&
    row.readinessViewMigrationApplied &&
    row.projectCreateIdempotencyApplied &&
    row.currentReadinessViewApplied &&
    row.gscPropertyScopingApplied &&
    latestNumber !== null &&
    requiredNumber !== null &&
    latestNumber >= requiredNumber;
  return {
    migrationState: ready ? "ready" : "pending",
    latestMigration: row.latestVersion,
    requiredMigration: REQUIRED_LATEST_MIGRATION,
  };
}

async function readRequiredSchemaCatalog(): Promise<RequiredSchemaCatalogRow> {
  // The restricted runtime role cannot read schema_migrations. Check the
  // required application schema directly through catalogs. This deliberately
  // reports schema markers, not the migration ledger.
  const { rows } = await query<SchemaCatalogQueryRow>(
    `SELECT
       (
         SELECT pg_get_constraintdef(oid) FROM pg_constraint
          WHERE conrelid = to_regclass('public.patch_proposals')
            AND conname = 'patch_proposals_status_check'
            AND convalidated
       ) AS "patchLifecycleDefinition",
       c.oid IS NOT NULL AS "evidenceTableExists",
       EXISTS (
         SELECT 1 FROM pg_attribute
          WHERE attrelid = c.oid AND attname = 'organization_id'
            AND attnum > 0 AND NOT attisdropped
       ) AS "evidenceOrganizationId",
       EXISTS (
         SELECT 1 FROM pg_attribute
          WHERE attrelid = c.oid AND attname = 'organization_id'
            AND attnum > 0 AND NOT attisdropped AND attnotnull
       ) AS "evidenceOrganizationIdNotNull",
       COALESCE(c.relrowsecurity, false) AS "evidenceRlsEnabled",
       COALESCE(c.relforcerowsecurity, false) AS "evidenceRlsForced",
       EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = c.oid AND contype = 'f'
            AND convalidated
            AND regexp_replace(lower(pg_get_constraintdef(oid)), '[[:space:]]|::(text|uuid)', '', 'g')
                LIKE '%foreignkey(organization_id,finding_id)referencesfindings(organization_id,id)%'
       ) AS "evidenceFindingTenantForeignKey",
       EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = c.oid AND contype = 'f'
            AND convalidated
            AND regexp_replace(lower(pg_get_constraintdef(oid)), '[[:space:]]|::(text|uuid)', '', 'g')
                LIKE '%foreignkey(organization_id,evidence_id)referencesevidence_items(organization_id,id)%'
       ) AS "evidenceItemTenantForeignKey",
       EXISTS (
         SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public'
            AND p.tablename = 'finding_evidence'
            AND p.policyname = 'tenant_isolation'
            AND p.cmd = 'ALL'
            AND regexp_replace(lower(coalesce(p.qual, '')), '[[:space:]()]|::(text|uuid)', '', 'g')
                = 'organization_id=nullifcurrent_setting' || chr(39) || 'app.current_organization_id' || chr(39) || ',true,' || chr(39) || chr(39)
            AND regexp_replace(lower(coalesce(p.with_check, '')), '[[:space:]()]|::(text|uuid)', '', 'g')
                = 'organization_id=nullifcurrent_setting' || chr(39) || 'app.current_organization_id' || chr(39) || ',true,' || chr(39) || chr(39)
       ) AS "evidenceTenantPolicy"
     FROM (SELECT to_regclass('public.finding_evidence') AS oid) rel
     LEFT JOIN pg_class c ON c.oid = rel.oid`,
  );
  if (!rows[0]) throw new Error("Required schema catalog query returned no row.");
  const { patchLifecycleDefinition, ...schema } = rows[0];
  return {
    ...schema,
    patchLifecycle: hasCompletePatchLifecycleConstraint(patchLifecycleDefinition),
  };
}

async function readMigrationReadinessCatalog(): Promise<MigrationReadinessCatalogRow> {
  const { rows } = await query<MigrationReadinessCatalogRow>(
    `SELECT patch_lifecycle_applied AS "patchLifecycleApplied",
            finding_evidence_rls_applied AS "findingEvidenceRlsApplied",
            readiness_view_migration_applied AS "readinessViewMigrationApplied",
            project_create_idempotency_applied AS "projectCreateIdempotencyApplied",
            current_readiness_view_applied AS "currentReadinessViewApplied",
            gsc_property_scoping_applied AS "gscPropertyScopingApplied",
            latest_version AS "latestVersion"
       FROM public.runtime_schema_migration_state`,
  );
  if (!rows[0]) throw new Error("Runtime migration readiness view returned no row.");
  return rows[0];
}

export interface DatabaseReadinessDependencies {
  healthCheck: () => Promise<boolean>;
  readSchemaCatalog: () => Promise<RequiredSchemaCatalogRow>;
  readMigrationCatalog: () => Promise<MigrationReadinessCatalogRow>;
}

export async function inspectDatabaseReadiness(
  dependencies: DatabaseReadinessDependencies = {
    healthCheck,
    readSchemaCatalog: readRequiredSchemaCatalog,
    readMigrationCatalog: readMigrationReadinessCatalog,
  },
): Promise<DatabaseReadiness> {
  let available = false;
  try {
    available = await dependencies.healthCheck();
  } catch {
    // A failed ping is an unavailable database, not an endpoint exception.
  }
  if (!available) {
    return {
      database: "unavailable",
      migrationState: "not_checked",
      latestMigration: null,
      requiredMigration: REQUIRED_LATEST_MIGRATION,
      requiredSchemaChecks: "not_checked",
      verifiedSchemaMarkers: [],
      requiredSchemaMarkers: REQUIRED_SCHEMA_MARKERS,
    };
  }

  const [schemaResult, migrationResult] = await Promise.allSettled([
    dependencies.readSchemaCatalog(),
    dependencies.readMigrationCatalog(),
  ]);
  const schema =
    schemaResult.status === "fulfilled"
      ? readinessFromSchemaCatalog(schemaResult.value)
      : {
          requiredSchemaChecks: "unavailable" as const,
          verifiedSchemaMarkers: [] as RequiredSchemaMarker[],
          requiredSchemaMarkers: REQUIRED_SCHEMA_MARKERS,
        };
  const migration =
    migrationResult.status === "fulfilled"
      ? migrationReadinessFromCatalog(migrationResult.value)
      : {
          migrationState:
            (migrationResult.reason as { code?: string } | null)?.code === "42P01"
              ? ("pending" as const)
              : ("unavailable" as const),
          latestMigration: null,
          requiredMigration: REQUIRED_LATEST_MIGRATION,
        };
  return {
    database: "ready",
    ...schema,
    ...migration,
  };
}

/**
 * Translate a PostgreSQL unique violation (SQLSTATE 23505) into a typed domain
 * error. Maps on the CONSTRAINT NAME (stable, explicitly declared in the
 * migration) rather than on human-readable detail text, which varies by
 * PostgreSQL version and locale.
 */
function mapUniqueViolation(err: unknown): never {
  const pgErr = err as { code?: string; constraint?: string };
  if (pgErr.code === "23505") {
    switch (pgErr.constraint) {
      case "users_email_key":
        throw new DuplicateEmailError();
      case "organizations_slug_key":
        throw new DuplicateSlugError();
      default:
        // Unknown unique violation: surface as a generic conflict rather than
        // leaking the constraint name to the client.
        throw Object.assign(new Error("Resource already exists."), {
          statusCode: 409,
          code: "CONFLICT",
        });
    }
  }
  throw err;
}

export function initDbStores(cfg: DbConfig): void {
  configurePool(cfg);
}

export async function closeDbStores(): Promise<void> {
  await closePool();
}

export function createDbStores(): ApiStores {
  return {
    users: {
      async createUser(email, passwordHash, name) {
        try {
          const row = await createUser(email, passwordHash, name);
          return toStoredUser(row, passwordHash);
        } catch (err) {
          mapUniqueViolation(err);
        }
      },
      async findByEmail(email) {
        const row = await findUserByEmail(email);
        return row ? toStoredUser(row, row.password_hash ?? "") : null;
      },
      async findById(id) {
        const row = await findUserById(id);
        return row ? toStoredUser(row, "") : null;
      },
    },

    orgs: {
      async createOrganization(ownerUserId, name, slug) {
        try {
          const row = await createOrganization(ownerUserId, name, slug);
          return { id: row.id, name: row.name, slug: row.slug };
        } catch (err) {
          mapUniqueViolation(err);
        }
      },
      async getForRequester(userId, organizationId) {
        const row = await getOrganizationForMember(userId, organizationId);
        return row ? { id: row.id, name: row.name, slug: row.slug } : null;
      },
      async getRoleForUser(userId, organizationId) {
        const role = await getMembershipRole(userId, organizationId);
        // Narrow the DB string to the OrgRole union; unknown roles fail closed.
        switch (role) {
          case "OWNER":
          case "ADMIN":
          case "ANALYST":
          case "EDITOR":
          case "VIEWER":
          case "BILLING":
            return role;
          default:
            return null;
        }
      },
      async listForUser(userId) {
        const rows = await selectOrganizationsForUser(userId);
        return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug }));
      },
    },

    projects: {
      async createProject(organizationId, name, primaryDomain) {
        const row = await createProject(organizationId, name, primaryDomain);
        return toStoredProject(row);
      },
      async createProjectWithIdempotencyKey(organizationId, name, primaryDomain, idempotencyKey) {
        const result = await createProjectWithIdempotencyKey(
          organizationId,
          name,
          primaryDomain,
          idempotencyKey,
        );
        return result.kind === "conflict"
          ? result
          : { kind: result.kind, project: toStoredProject(result.project) };
      },
      async getProject(organizationId, projectId) {
        // withTenant sets the GUC to organizationId; RLS filters foreign rows to
        // zero, so this returns null for another tenant's project.
        const row = await getProject(organizationId, projectId);
        return row ? toStoredProject(row) : null;
      },
      async listProjects(organizationId) {
        const rows = await selectProjectRows(organizationId);
        return rows.map(toStoredProject);
      },
    },

    scans: {
      async createPublicScan(domain) {
        const row = await createPublicScan(domain);
        return toStoredScan(row);
      },
      async getPublicScan(id) {
        const row = await getPublicScan(id);
        return row ? toStoredScan(row) : null;
      },
      async markRunning(id) {
        await query(`UPDATE public_scans SET status='running' WHERE id=$1`, [id]);
      },
      async updateResult(id, status, findings, evidence, error) {
        await updatePublicScanResult(id, status, findings, evidence, error);
      },
    },

    rateLimits: {
      async hit(ip, limitPerWindow, scope = "public-scan-ip") {
        if (isLoopback(ip)) {
          return { allowed: true, remaining: limitPerWindow, retryAfterSeconds: 0 };
        }
        const secret = process.env.AUTH_SECRET;
        if (!secret) {
          throw new Error("AUTH_SECRET is required for privacy-preserving rate-limit keys.");
        }
        const bucketKey = createHmac("sha256", secret)
          .update(`${scope}:v1:`)
          .update(ip)
          .digest("hex");
        const hit = await consumeRateLimitWindow(bucketKey, limitPerWindow);
        return {
          allowed: hit.count <= limitPerWindow,
          remaining: Math.max(0, limitPerWindow - hit.count),
          retryAfterSeconds: hit.count <= limitPerWindow ? 0 : hit.retryAfterSeconds,
        };
      },
      async release(ip, _limitPerWindow, scope = "public-scan-ip") {
        if (isLoopback(ip)) return;
        const secret = process.env.AUTH_SECRET;
        if (!secret) {
          throw new Error("AUTH_SECRET is required for privacy-preserving rate-limit keys.");
        }
        const bucketKey = createHmac("sha256", secret)
          .update(`${scope}:v1:`)
          .update(ip)
          .digest("hex");
        await releaseRateLimitWindow(bucketKey);
      },
    },

    sessions: {
      async create(tokenHash, userId, email, expiresAt, organizationId, role) {
        await query(
          `INSERT INTO sessions (token_hash, user_id, email, organization_id, role, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tokenHash, userId, email, organizationId ?? null, role ?? null, expiresAt],
        );
      },
      async get(tokenHash) {
        // Unknown / revoked / expired all collapse to null (single semantics).
        const { rows } = await query<{
          user_id: string;
          email: string;
          organization_id: string | null;
          role: string | null;
          expires_at: Date;
          step_up_verified_at: Date | null;
          step_up_mfa_counter: string | number | null;
        }>(
          `SELECT user_id, email, organization_id, role, expires_at,
                  step_up_verified_at, step_up_mfa_counter
             FROM sessions
            WHERE token_hash = $1
              AND revoked_at IS NULL
              AND expires_at > now()`,
          [tokenHash],
        );
        const r = rows[0];
        if (!r) return null;
        return {
          userId: r.user_id,
          email: r.email,
          organizationId: r.organization_id ?? undefined,
          role: (r.role as StoredSession["role"]) ?? undefined,
          expiresAt: r.expires_at,
          stepUpVerifiedAt: r.step_up_verified_at?.toISOString(),
          stepUpMfaCounter:
            r.step_up_mfa_counter === null ? undefined : Number(r.step_up_mfa_counter),
        };
      },
      async setOrg(tokenHash, organizationId, role) {
        await query(
          `UPDATE sessions SET organization_id = $2, role = $3, last_seen_at = now(),
                               step_up_verified_at = NULL, step_up_mfa_counter = NULL
            WHERE token_hash = $1 AND revoked_at IS NULL`,
          [tokenHash, organizationId, role],
        );
      },
      async setStepUp(tokenHash, verifiedAt, counter) {
        await query(
          `UPDATE sessions SET step_up_verified_at = $2, step_up_mfa_counter = $3
            WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
          [tokenHash, verifiedAt, counter],
        );
      },
      async revoke(tokenHash) {
        await query(
          `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
          [tokenHash],
        );
      },
      async revokeAllForUser(userId) {
        const { rowCount } = await query(
          `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId],
        );
        return rowCount ?? 0;
      },
    },

    mfa: {
      async get(userId) {
        const row = await selectMfaRow(userId);
        if (!row?.encrypted_secret) return null;
        return {
          encryptedSecret: row.encrypted_secret,
          enabledAt: row.enabled_at?.toISOString() ?? null,
          enrollmentExpiresAt: row.enrollment_expires_at?.toISOString() ?? null,
          lastCounter: Number(row.last_counter),
        };
      },
      beginEnrollment(userId, encryptedSecret, expiresAt) {
        return insertMfaEnrollment(userId, encryptedSecret, expiresAt);
      },
      confirmEnrollment(userId, counter) {
        return enableMfaRow(userId, counter);
      },
      consumeCounter(userId, counter) {
        return consumeMfaRowCounter(userId, counter);
      },
      disable(userId, counter) {
        return disableMfaRow(userId, counter);
      },
    },

    crawl: {
      // All methods run under withTenant() → SET ROLE serpvera_app + org GUC,
      // so PostgreSQL RLS WITH CHECK/USING is the enforcement layer (P-GAP-04).
      async createCrawlRun(organizationId, projectId, mode) {
        return createCrawlRunRow(organizationId, projectId, mode);
      },
      async finishCrawlRun(
        organizationId,
        runId,
        status,
        pagesCrawled,
        pagesFailed,
        pageLimit,
        stopReason,
        templateGroups,
      ) {
        await finishCrawlRunRow(
          organizationId,
          runId,
          status,
          pagesCrawled,
          pagesFailed,
          pageLimit,
          stopReason,
          templateGroups === undefined || templateGroups === null
            ? templateGroups
            : parseStoredTemplateGroups(templateGroups),
        );
      },
      async addFinding(organizationId, projectId, finding) {
        return insertFindingRow({
          organization_id: organizationId,
          project_id: projectId,
          rule_id: finding.ruleId,
          rule_version: finding.ruleVersion,
          title: finding.title,
          epistemic_class: finding.epistemicClass,
          severity: finding.severity,
          explanation: finding.explanation,
          recommendation: finding.recommendation,
          affected_urls: finding.affectedUrls,
          verification_gate: finding.verificationGate,
          crawl_run_id: finding.crawlRunId,
        });
      },
      async addEvidence(organizationId, projectId, evidence) {
        return insertEvidenceRow({
          organization_id: organizationId,
          project_id: projectId,
          kind: evidence.kind,
          source_ref: evidence.sourceRef,
          content_hash: evidence.contentHash,
          object_key: evidence.objectKey,
          metadata_json: evidence.metadata ?? {},
          crawl_run_id: evidence.crawlRunId,
        });
      },
      async createMeasuredGscWorkflow(organizationId, projectId, finding, evidence) {
        return insertMeasuredGscWorkflow(
          {
            organization_id: organizationId,
            project_id: projectId,
            rule_id: finding.ruleId,
            rule_version: finding.ruleVersion,
            title: finding.title,
            epistemic_class: finding.epistemicClass,
            severity: finding.severity,
            explanation: finding.explanation,
            recommendation: finding.recommendation,
            affected_urls: finding.affectedUrls,
            verification_gate: finding.verificationGate,
            crawl_run_id: finding.crawlRunId,
          },
          {
            organization_id: organizationId,
            project_id: projectId,
            kind: evidence.kind,
            source_ref: evidence.sourceRef,
            content_hash: evidence.contentHash,
            object_key: evidence.objectKey,
            metadata_json: evidence.metadata ?? {},
            crawl_run_id: evidence.crawlRunId,
          },
        );
      },
      async listFindings(organizationId, projectId) {
        const rows = await selectFindingRows(organizationId, projectId);
        return rows.map(toStoredFinding);
      },
      async getFinding(organizationId, findingId) {
        const row = await selectFindingRow(organizationId, findingId);
        if (!row) return null;
        const ev = await selectFindingEvidence(organizationId, findingId);
        return {
          ...toStoredFinding(row),
          projectId: row.project_id,
          evidence: ev.map(toStoredEvidence),
        };
      },
      async linkFindingEvidence(organizationId, findingId, evidenceId) {
        await insertFindingEvidence(organizationId, findingId, evidenceId);
      },
      async listEvidence(organizationId, projectId) {
        const rows = await selectEvidenceRows(organizationId, projectId);
        return rows.map(toStoredEvidence);
      },
      async listCrawlRuns(organizationId, projectId) {
        const rows = await selectCrawlRunRows(organizationId, projectId);
        return rows.map((r) => ({
          id: r.id,
          status: r.status,
          mode: r.mode,
          startedAt: (r.started_at ?? new Date(0)).toISOString(),
          completedAt: r.completed_at ? r.completed_at.toISOString() : null,
          pagesCrawled: r.pages_crawled,
          pagesFailed: r.pages_failed,
          pageLimit: r.page_limit,
          stopReason: r.stop_reason,
          templateGroups: parseStoredTemplateGroups(r.template_groups),
        }));
      },
      async createDetectedAction(organizationId, projectId, findingId) {
        return insertDetectedAction(organizationId, projectId, findingId);
      },
    },

    actions: {
      async listActions(organizationId, projectId, filters) {
        return selectActions(organizationId, projectId, filters);
      },
      async getAction(organizationId, actionId) {
        return selectAction(organizationId, actionId);
      },
      async transitionAction(organizationId, actionId, actor, input) {
        return updateActionState(organizationId, actionId, actor, input);
      },
    },

    patches: {
      async create(input) {
        await insertPatchRow({
          organizationId: input.organizationId,
          projectId: input.projectId,
          findingId: input.findingId,
          createdBy: input.actor.userId,
          proposal: input.proposal as unknown as Record<string, unknown>,
          fixtureHtml: input.fixtureHtml,
          events: input.proposal.events,
        });
      },
      async get(organizationId, patchId) {
        const row = await selectPatchRow(organizationId, patchId);
        if (!row) return null;
        return {
          proposal: row.proposal as unknown as PatchProposal,
          fixtureHtml: row.fixtureHtml,
          eventCount: row.eventCount,
        };
      },
      async list(organizationId, projectId) {
        const rows = await selectPatchRows(organizationId, projectId);
        return rows.map((row) => row.proposal as unknown as PatchProposal);
      },
      save(input) {
        return updatePatchRow({
          organizationId: input.organizationId,
          patchId: input.patchId,
          expectedVersion: input.expectedVersion,
          previousEventCount: input.previousEventCount,
          proposal: input.proposal as unknown as Record<string, unknown>,
          fixtureHtml: input.fixtureHtml,
          events: input.proposal.events.slice(input.previousEventCount),
        });
      },
    },

    aiVisibility: {
      async createImport(input) {
        const row = await insertAiVisibilityImport(input);
        return toStoredAiVisibilityImport(row);
      },
      async listImports(organizationId, projectId, limit, offset) {
        const rows = await selectAiVisibilityImports(organizationId, projectId, limit, offset);
        return rows.map(toStoredAiVisibilityImport);
      },
      async getImport(organizationId, projectId, importId) {
        const row = await selectAiVisibilityImport(organizationId, projectId, importId);
        return row ? toStoredAiVisibilityImport(row) : null;
      },
      async listCaptures(organizationId, projectId, importId) {
        const rows = await selectAiVisibilityCaptures(organizationId, projectId, importId);
        return rows.map(toStoredAiVisibilityCapture);
      },
      async listStats(organizationId, projectId, importId) {
        return selectAiVisibilityStats(organizationId, projectId, importId);
      },
    },

    // Present ONLY on the PostgreSQL driver: Google token material must exist
    // as encrypted rows, never in process memory of a throwaway driver.
    gsc: {
      async createOauthState(input) {
        await insertOauthState(input);
      },
      async consumeOauthState(organizationId, stateHash) {
        return claimOauthState(organizationId, stateHash);
      },
      async upsertCredential(input) {
        return saveCredential(input);
      },
      async getCredential(organizationId, projectId) {
        const row = await selectCredential(organizationId, projectId);
        return row ? toStoredCredential(row) : null;
      },
      async updateCredentialTokens(input) {
        return refreshCredentialTokens(input);
      },
      async deleteCredential(organizationId, projectId) {
        return removeCredential(organizationId, projectId);
      },
      async createConnection(input) {
        return toStoredConnection(await insertConnection(input));
      },
      async listConnections(organizationId, projectId) {
        const rows = await selectConnections(organizationId, projectId);
        return rows.map(toStoredConnection);
      },
      async getConnection(organizationId, connectionId) {
        const row = await selectConnection(organizationId, connectionId);
        return row ? toStoredConnection(row) : null;
      },
      async disconnectConnection(organizationId, connectionId) {
        return markConnectionDisconnected(organizationId, connectionId);
      },
      async markConnectionSynced(organizationId, connectionId, at) {
        await touchConnectionSync(organizationId, connectionId, at);
      },
      async createOrReuseJob(input) {
        return toStoredJob(await insertOrReuseJob(input));
      },
      async getJob(organizationId, jobId) {
        const row = await selectJob(organizationId, jobId);
        return row ? toStoredJob(row) : null;
      },
      async listJobs(organizationId, projectId) {
        const rows = await selectJobs(organizationId, projectId);
        return rows.map(toStoredJob);
      },
      async claimJob(organizationId, jobId, startedAt) {
        return claimGscJob(organizationId, jobId, startedAt);
      },
      async updateJob(organizationId, jobId, patch) {
        return updateJobRow(organizationId, jobId, patch);
      },
      async persistMetricWindow(input) {
        return replaceMetricWindow(input);
      },
      async loadMetricRows(organizationId, projectId, window, filters) {
        return selectMetricRows(organizationId, projectId, window, filters);
      },
      async metricSeries(organizationId, projectId, window, filters) {
        return selectMetricSeries(organizationId, projectId, window, filters);
      },
      async metricFreshness(organizationId, projectId, connectionId) {
        return selectMetricFreshness(organizationId, projectId, connectionId);
      },
    },
  };
}

function toStoredAiVisibilityImport(row: AiVisibilityImportRow): StoredAiVisibilityImport {
  return {
    id: row.id,
    projectId: row.project_id,
    uploadedBy: row.uploaded_by,
    csvSha256: row.csv_sha256,
    rowCount: row.row_count,
    provenance: row.provenance,
    epistemicClass: row.epistemic_class,
    unverifiedByProvider: row.unverified_by_provider,
    createdAt: row.created_at.toISOString(),
  };
}

function toStoredAiVisibilityCapture(row: AiVisibilityCaptureRow): StoredAiVisibilityCapture {
  return {
    id: row.id,
    importId: row.import_id,
    rowNumber: row.row_number,
    engine: row.engine,
    promptId: row.prompt_id,
    brandMentioned: row.brand_mentioned,
    clientCited: row.client_cited,
    citationDomains: row.citation_domains,
    sampledAt: row.sampled_at.toISOString(),
  };
}

// ─── GSC row → API shape mappers ───
function toStoredConnection(r: {
  id: string;
  project_id: string;
  external_property: string;
  scope: string;
  credential_ref: string | null;
  status: string;
  connected_at: Date | null;
  last_sync_at: Date | null;
}): StoredGscConnection {
  return {
    id: r.id,
    projectId: r.project_id,
    externalProperty: r.external_property,
    scope: r.scope,
    credentialRef: r.credential_ref,
    status: r.status,
    connectedAt: r.connected_at ? r.connected_at.toISOString() : null,
    lastSyncAt: r.last_sync_at ? r.last_sync_at.toISOString() : null,
  };
}

function toStoredJob(r: {
  id: string;
  project_id: string;
  connection_id: string;
  window_start: string | Date;
  window_end: string | Date;
  ingestion_version: number;
  window_start_iso?: string;
  window_end_iso?: string;
  status: string;
  row_count: number;
  attempt: number;
  error_code: string | null;
  error_message: string | null;
  requested_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  next_retry_at: Date | null;
}): StoredGscJob {
  return {
    id: r.id,
    projectId: r.project_id,
    connectionId: r.connection_id,
    windowStart: r.window_start_iso ?? toIsoDate(r.window_start),
    windowEnd: r.window_end_iso ?? toIsoDate(r.window_end),
    status: r.status,
    ingestionVersion: r.ingestion_version,
    rowCount: r.row_count,
    attempt: r.attempt,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    requestedAt: r.requested_at.toISOString(),
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    nextRetryAt: r.next_retry_at ? r.next_retry_at.toISOString() : null,
  };
}

function toStoredCredential(r: {
  id: string;
  project_id: string;
  encrypted_refresh_token: string;
  encrypted_access_token: string;
  access_token_expires_at: Date;
  scope: string;
  google_subject: string | null;
}): StoredGscCredential {
  return {
    id: r.id,
    projectId: r.project_id,
    encryptedRefreshToken: r.encrypted_refresh_token,
    encryptedAccessToken: r.encrypted_access_token,
    accessTokenExpiresAt: r.access_token_expires_at.toISOString(),
    scope: r.scope,
    googleSubject: r.google_subject,
  };
}

/** DATE columns are read as ISO calendar days — never a local-midnight Date. */
function toIsoDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

// ─── Row → API shape mappers (PHASE-3-UI) ───
function toStoredFinding(r: {
  id: string;
  rule_id: string;
  rule_version: string;
  title: string;
  epistemic_class: string;
  severity: string;
  status: string;
  confidence: number;
  explanation: string | null;
  recommendation: string | null;
  first_seen_at: Date;
  affected_urls: string[] | null;
  verification_gate: string | null;
  action_state?: string | null;
}) {
  return {
    id: r.id,
    ruleId: r.rule_id,
    ruleVersion: r.rule_version,
    title: r.title,
    epistemicClass: r.epistemic_class,
    severity: r.severity,
    status: r.status,
    confidence: r.confidence,
    explanation: r.explanation ?? undefined,
    recommendation: r.recommendation ?? undefined,
    firstSeenAt: r.first_seen_at.toISOString(),
    affectedUrls: r.affected_urls ?? [],
    verificationGate: r.verification_gate ?? "recrawl_rule_absent",
    actionState: r.action_state ?? null,
  };
}

function toStoredEvidence(r: {
  id: string;
  kind: string;
  source_ref: string;
  content_hash: string;
  object_key: string;
  captured_at: Date;
  metadata_json: unknown;
}) {
  return {
    id: r.id,
    kind: r.kind,
    sourceRef: r.source_ref,
    contentHash: r.content_hash,
    objectKey: r.object_key,
    capturedAt: r.captured_at.toISOString(),
    metadata: publicEvidenceMetadata(r.metadata_json),
  };
}

// ─── Row → API shape mappers ───
function toStoredUser(
  row: { id: string; email: string; name: string | null },
  passwordHash: string,
): StoredUser {
  return {
    id: row.id,
    email: row.email,
    passwordHash,
    name: row.name,
  };
}

function toStoredProject(row: {
  id: string;
  organization_id: string;
  name: string;
  primary_domain: string;
}): StoredProject {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    primaryDomain: row.primary_domain,
  };
}

function toStoredScan(row: {
  id: string;
  domain: string;
  status: string;
  created_at: Date;
  completed_at: Date | null;
  findings: unknown;
  evidence: unknown;
  error: string | null;
}): StoredPublicScan {
  return {
    id: row.id,
    domain: row.domain,
    status: row.status as StoredPublicScan["status"],
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    // public_scans.findings/evidence are nullable JSONB columns (legacy rows
    // predate the NOT-GUARANTEED backfill) — keep the null fallback honest.
    findings: (row.findings as unknown[] | null) ?? [],
    evidence: (row.evidence as unknown[] | null) ?? [],
    error: row.error,
  };
}
