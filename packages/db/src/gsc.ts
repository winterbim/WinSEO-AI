// ─── GSC repository layer ───
// Live Google Search Console data access. Three rules hold for everything here:
//
//  1. Tenant scope is a SQL predicate AND the RLS GUC (withTenant) — never one
//     or the other. Token material is therefore unreachable across tenants even
//     if a caller forgets its WHERE clause.
//  2. Token values never leave this layer in a shape that could be logged: rows
//     carry envelope ciphertext only, and callers receive them as opaque
//     strings they must decrypt in memory.
//  3. Metric windows are replaced, not appended: Google revises recent data
//     (PRELIMINARY), so a re-synced window overwrites rather than double-counts.

import { withTenant } from "./client.ts";
import { randomUUID } from "node:crypto";

/** A project's Google authorization. Ciphertext fields are envelope-encoded. */
export interface GscCredentialRow {
  id: string;
  organization_id: string;
  project_id: string;
  encrypted_refresh_token: string;
  encrypted_access_token: string;
  access_token_expires_at: Date;
  token_type: string;
  scope: string;
  google_subject: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface GscOauthStateInput {
  organizationId: string;
  projectId: string;
  stateHash: string;
  codeVerifier: string;
  /** ISO timestamp accepted verbatim so tests can control expiry. */
  expiresAt: string;
}

export interface GscConnectionRow {
  id: string;
  organization_id: string;
  project_id: string;
  external_property: string;
  scope: string;
  credential_ref: string | null;
  status: string;
  connected_at: Date | null;
  last_sync_at: Date | null;
  created_at: Date;
}

export interface GscSyncJobRow {
  id: string;
  organization_id: string;
  project_id: string;
  connection_id: string;
  window_start: string;
  window_end: string;
  status: string;
  requested_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  row_count: number;
  error_code: string | null;
  error_message: string | null;
  attempt: number;
  idempotency_key: string | null;
  next_retry_at: Date | null;
}

export interface GscMetricInput {
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

export interface GscMetricFilters {
  query?: string;
  page?: string;
  device?: string;
  country?: string;
  /** Selects rows written by sync jobs for one authorized property. */
  connectionId?: string;
}

export class GscMeasurementWindowTooLargeError extends Error {
  readonly statusCode = 413;
  readonly code = "GSC_MEASUREMENT_WINDOW_TOO_LARGE";

  constructor(limit: number) {
    super(
      `This Search Console window exceeds the ${limit.toLocaleString("en-US")} row analysis limit. Narrow the date range or filters and retry.`,
    );
    this.name = "GscMeasurementWindowTooLargeError";
  }
}

export interface GscWindow {
  startDate: string;
  endDate: string;
}

/** Raised when a project/connection is missing OR belongs to another tenant. */
export class GscTenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GscTenantScopeError";
  }
}

export class GscAlreadyConnectedError extends Error {
  constructor() {
    super("This Google property is already connected to the project.");
    this.name = "GscAlreadyConnectedError";
  }
}

/** A stale sync worker lost its claim and may no longer publish or finish. */
export class GscSyncAttemptLostError extends Error {
  constructor() {
    super("This Search Console sync attempt is no longer current.");
    this.name = "GscSyncAttemptLostError";
  }
}

/** Stale RUNNING claims may be retried after workers exceed this lease. */
export const GSC_SYNC_JOB_LEASE_MS = 30 * 60 * 1_000;

// ═══════════ OAuth state (single-use, server-held) ═══════════

/**
 * Record an issued `state` + PKCE verifier.
 *
 * The project is validated inside the INSERT (projects.organization_id match),
 * so a caller cannot park state against another tenant's project.
 * Opportunistically prunes expired states — they are useless after their TTL.
 */
export async function createOauthState(input: GscOauthStateInput): Promise<void> {
  await withTenant(input.organizationId, async (client) => {
    await client.query(`DELETE FROM gsc_oauth_states WHERE expires_at < now() - interval '1 day'`);
    const res = await client.query(
      `INSERT INTO gsc_oauth_states
         (organization_id, project_id, state_hash, code_verifier, expires_at)
       SELECT $1, p.id, $3, $4, $5::timestamptz
         FROM projects p
        WHERE p.id = $2 AND p.organization_id = $1`,
      [input.organizationId, input.projectId, input.stateHash, input.codeVerifier, input.expiresAt],
    );
    if (res.rowCount === 0) {
      throw new GscTenantScopeError("Project not found in this organization.");
    }
  });
}

/**
 * Atomically claim a state: marks it used in the same statement that reads it,
 * so a replayed callback sees no row (single-use enforced by data, not code).
 *
 * Returns null for unknown, already-used and expired states alike — a caller
 * must not be able to distinguish them.
 */
export async function consumeOauthState(
  organizationId: string,
  stateHash: string,
): Promise<{ projectId: string; codeVerifier: string } | null> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<{ project_id: string; code_verifier: string }>(
      `UPDATE gsc_oauth_states
          SET used_at = now()
        WHERE organization_id = $1
          AND state_hash = $2
          AND used_at IS NULL
          AND expires_at > now()
        RETURNING project_id, code_verifier`,
      [organizationId, stateHash],
    );
    const row = res.rows[0];
    return row ? { projectId: row.project_id, codeVerifier: row.code_verifier } : null;
  });
}

// ═══════════ Project credentials (encrypted at rest) ═══════════

/**
 * Create or rotate a project's Google authorization.
 *
 * Conflict handling is scoped by organization: if the target project_id already
 * carries another tenant's credential, the ON CONFLICT WHERE clause rejects it
 * and we surface a scope error instead of silently overwriting a foreign row.
 */
export async function upsertCredential(input: {
  organizationId: string;
  projectId: string;
  encryptedRefreshToken: string;
  encryptedAccessToken: string;
  accessTokenExpiresAt: string;
  scope: string;
  googleSubject: string | null;
}): Promise<string> {
  return withTenant(input.organizationId, async (client) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO gsc_project_credentials
         (organization_id, project_id, encrypted_refresh_token, encrypted_access_token,
          access_token_expires_at, scope, google_subject)
       SELECT $1, p.id, $3, $4, $5::timestamptz, $6, $7
         FROM projects p
        WHERE p.id = $2 AND p.organization_id = $1
       ON CONFLICT (project_id) DO UPDATE
          SET encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
              encrypted_access_token  = EXCLUDED.encrypted_access_token,
              access_token_expires_at = EXCLUDED.access_token_expires_at,
              scope                   = EXCLUDED.scope,
              google_subject          = EXCLUDED.google_subject,
              updated_at              = now()
        WHERE gsc_project_credentials.organization_id = EXCLUDED.organization_id
       RETURNING id`,
      [
        input.organizationId,
        input.projectId,
        input.encryptedRefreshToken,
        input.encryptedAccessToken,
        input.accessTokenExpiresAt,
        input.scope,
        input.googleSubject,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new GscTenantScopeError("Project not found in this organization.");
    return row.id;
  });
}

export async function getCredential(
  organizationId: string,
  projectId: string,
): Promise<GscCredentialRow | null> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<GscCredentialRow>(
      `SELECT * FROM gsc_project_credentials
        WHERE organization_id = $1 AND project_id = $2`,
      [organizationId, projectId],
    );
    return res.rows[0] ?? null;
  });
}

/** Persist a refreshed access token (and the refresh token if it rotated). */
export async function updateCredentialTokens(input: {
  organizationId: string;
  projectId: string;
  encryptedAccessToken: string;
  accessTokenExpiresAt: string;
  encryptedRefreshToken?: string;
}): Promise<boolean> {
  return withTenant(input.organizationId, async (client) => {
    const res = await client.query(
      `UPDATE gsc_project_credentials
          SET encrypted_access_token = $3,
              access_token_expires_at = $4::timestamptz,
              encrypted_refresh_token = COALESCE($5, encrypted_refresh_token),
              updated_at = now()
        WHERE organization_id = $1 AND project_id = $2`,
      [
        input.organizationId,
        input.projectId,
        input.encryptedAccessToken,
        input.accessTokenExpiresAt,
        input.encryptedRefreshToken ?? null,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

/** Wipe token material (disconnect / revocation). Returns whether it existed. */
export async function deleteCredential(
  organizationId: string,
  projectId: string,
): Promise<boolean> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query(
      `DELETE FROM gsc_project_credentials WHERE organization_id = $1 AND project_id = $2`,
      [organizationId, projectId],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

// ═══════════ Property connections ═══════════

export async function createConnection(input: {
  organizationId: string;
  projectId: string;
  externalProperty: string;
  scope?: string;
  credentialRef: string;
}): Promise<GscConnectionRow> {
  return withTenant(input.organizationId, async (client) => {
    // A disconnected property must be reconnectable: the UNIQUE slot is
    // revived in place instead of being held forever by a dead row. An ACTIVE
    // duplicate stays a duplicate.
    const res = await client.query<GscConnectionRow>(
      `INSERT INTO gsc_connections
         (organization_id, project_id, external_property, scope, credential_ref, status, connected_at)
       SELECT $1, p.id, $3, COALESCE($4, 'site'), $5, 'CONNECTED', now()
         FROM projects p
        WHERE p.id = $2 AND p.organization_id = $1
       ON CONFLICT (project_id, external_property) DO UPDATE
          SET status = 'CONNECTED',
              connected_at = now(),
              credential_ref = EXCLUDED.credential_ref,
              scope = EXCLUDED.scope
        WHERE gsc_connections.status = 'DISCONNECTED'
       RETURNING *`,
      [
        input.organizationId,
        input.projectId,
        input.externalProperty,
        input.scope ?? null,
        input.credentialRef,
      ],
    );
    const row = res.rows[0];
    if (!row) {
      // Either a foreign/unknown project or an already-connected property —
      // tell them apart with one existence probe.
      const clash = await client.query<{ id: string }>(
        `SELECT id FROM gsc_connections
          WHERE organization_id = $1 AND project_id = $2 AND external_property = $3`,
        [input.organizationId, input.projectId, input.externalProperty],
      );
      if ((clash.rowCount ?? 0) > 0) throw new GscAlreadyConnectedError();
      throw new GscTenantScopeError("Project not found in this organization.");
    }
    return row;
  });
}

export async function listConnections(
  organizationId: string,
  projectId: string,
): Promise<GscConnectionRow[]> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<GscConnectionRow>(
      `SELECT * FROM gsc_connections
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY created_at, id`,
      [organizationId, projectId],
    );
    return res.rows;
  });
}

export async function getConnection(
  organizationId: string,
  connectionId: string,
): Promise<GscConnectionRow | null> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<GscConnectionRow>(
      `SELECT * FROM gsc_connections WHERE organization_id = $1 AND id = $2`,
      [organizationId, connectionId],
    );
    return res.rows[0] ?? null;
  });
}

/** Mark a connection disconnected (row retained for provenance). */
export async function disconnectConnection(
  organizationId: string,
  connectionId: string,
): Promise<boolean> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query(
      `UPDATE gsc_connections
          SET status = 'DISCONNECTED', credential_ref = NULL
        WHERE organization_id = $1 AND id = $2 AND status <> 'DISCONNECTED'`,
      [organizationId, connectionId],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

/** Mark a connection's last sync (freshness metadata). */
export async function markConnectionSynced(
  organizationId: string,
  connectionId: string,
  at: string,
): Promise<void> {
  await withTenant(organizationId, async (client) => {
    await client.query(
      `UPDATE gsc_connections SET last_sync_at = $3::timestamptz
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, connectionId, at],
    );
  });
}

// ═══════════ Sync jobs (retry + idempotency) ═══════════

/**
 * Return the in-flight job for a (connection, window), or create a fresh attempt
 * after a completed job. Completed attempts stay available until the new one
 * commits, so a failed refresh cannot erase the last verified measurement.
 */
export async function createOrReuseJob(input: {
  organizationId: string;
  projectId: string;
  connectionId: string;
  windowStart: string;
  windowEnd: string;
  idempotencyKey: string;
}): Promise<GscSyncJobRow> {
  return withTenant(input.organizationId, async (client) => {
    const lockKey = `${input.organizationId}:${input.projectId}:${input.connectionId}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
    const existing = await client.query<GscSyncJobRow>(
      `SELECT *,
              to_char(window_start, 'YYYY-MM-DD') AS window_start_iso,
              to_char(window_end, 'YYYY-MM-DD') AS window_end_iso
         FROM gsc_sync_jobs
        WHERE organization_id = $1 AND project_id = $2 AND connection_id = $3
          AND window_start = $4::date AND window_end = $5::date
        ORDER BY requested_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [
        input.organizationId,
        input.projectId,
        input.connectionId,
        input.windowStart,
        input.windowEnd,
      ],
    );
    const latest = existing.rows[0];
    if (latest && latest.status !== "COMPLETED") {
      if (latest.status === "PENDING") return latest;
      if (latest.status === "RUNNING") {
        const startedAt = latest.started_at?.getTime();
        const leaseExpired =
          startedAt !== undefined && Date.now() - startedAt >= GSC_SYNC_JOB_LEASE_MS;
        if (!leaseExpired) return latest;
      }
      const rearmed = await client.query<GscSyncJobRow>(
        `UPDATE gsc_sync_jobs
            SET status = 'PENDING', started_at = NULL, completed_at = NULL,
                row_count = 0, error_code = NULL, error_message = NULL,
                next_retry_at = NULL
          WHERE organization_id = $1 AND id = $2
          RETURNING *,
            to_char(window_start, 'YYYY-MM-DD') AS window_start_iso,
            to_char(window_end, 'YYYY-MM-DD') AS window_end_iso`,
        [input.organizationId, latest.id],
      );
      const row = rearmed.rows[0];
      if (row) return row;
    }

    const idempotencyKey = latest
      ? `${input.idempotencyKey}:attempt:${randomUUID()}`
      : input.idempotencyKey;
    const res = await client.query<GscSyncJobRow>(
      `INSERT INTO gsc_sync_jobs
         (organization_id, project_id, connection_id, window_start, window_end, idempotency_key)
       VALUES ($1, $2, $3, $4::date, $5::date, $6)
       RETURNING *,
         to_char(window_start, 'YYYY-MM-DD') AS window_start_iso,
         to_char(window_end, 'YYYY-MM-DD') AS window_end_iso`,
      [
        input.organizationId,
        input.projectId,
        input.connectionId,
        input.windowStart,
        input.windowEnd,
        idempotencyKey,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new GscTenantScopeError("Connection not found in this organization.");
    return row;
  });
}

export async function getJob(organizationId: string, jobId: string): Promise<GscSyncJobRow | null> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<GscSyncJobRow>(
      `SELECT gsc_sync_jobs.*,
              to_char(window_start, 'YYYY-MM-DD') AS window_start_iso,
              to_char(window_end, 'YYYY-MM-DD') AS window_end_iso
         FROM gsc_sync_jobs WHERE organization_id = $1 AND id = $2`,
      [organizationId, jobId],
    );
    return res.rows[0] ?? null;
  });
}

export async function listJobs(
  organizationId: string,
  projectId: string,
): Promise<GscSyncJobRow[]> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<GscSyncJobRow>(
      `SELECT gsc_sync_jobs.*,
              to_char(window_start, 'YYYY-MM-DD') AS window_start_iso,
              to_char(window_end, 'YYYY-MM-DD') AS window_end_iso
         FROM gsc_sync_jobs
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY requested_at DESC, id DESC`,
      [organizationId, projectId],
    );
    return res.rows;
  });
}

/** Claim a pending job once. All job writers take the property lock before row locks. */
export async function claimJob(
  organizationId: string,
  jobId: string,
  startedAt: string,
): Promise<number | null> {
  return withTenant(organizationId, async (client) => {
    const job = await client.query<{ project_id: string; connection_id: string }>(
      `SELECT project_id, connection_id
         FROM gsc_sync_jobs
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, jobId],
    );
    const current = job.rows[0];
    if (!current) return null;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${organizationId}:${current.project_id}:${current.connection_id}`,
    ]);
    const claimed = await client.query<{ attempt: number }>(
      `UPDATE gsc_sync_jobs
          SET status = 'RUNNING', started_at = $3::timestamptz,
              completed_at = NULL, attempt = attempt + 1,
              claim_order = (
                SELECT COALESCE(MAX(previous.claim_order), 0) + 1
                  FROM gsc_sync_jobs AS previous
                 WHERE previous.organization_id = $1
                   AND previous.project_id = $4
                   AND previous.connection_id = $5
              )
        WHERE organization_id = $1 AND id = $2 AND status = 'PENDING'
        RETURNING attempt`,
      [organizationId, jobId, startedAt, current.project_id, current.connection_id],
    );
    return claimed.rows[0]?.attempt ?? null;
  });
}

export interface GscJobPatch {
  status?: string;
  startedAt?: string;
  completedAt?: string;
  rowCount?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  attempt?: number;
  nextRetryAt?: string | null;
  expectedAttempt: number;
}

export async function updateJob(
  organizationId: string,
  jobId: string,
  patch: GscJobPatch,
): Promise<boolean> {
  return withTenant(organizationId, async (client) => {
    const job = await client.query<{
      project_id: string;
      connection_id: string;
      window_start: string;
      window_end: string;
      claim_order: string;
    }>(
      `SELECT project_id, connection_id,
              to_char(window_start, 'YYYY-MM-DD') AS window_start,
              to_char(window_end, 'YYYY-MM-DD') AS window_end,
              claim_order::text AS claim_order
         FROM gsc_sync_jobs
        WHERE organization_id = $1 AND id = $2`,
      [organizationId, jobId],
    );
    const current = job.rows[0];
    if (!current) return false;
    // Take locks in the same order as createOrReuseJob, claimJob and metric
    // persistence: property advisory lock first, then any row lock from UPDATE.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${organizationId}:${current.project_id}:${current.connection_id}`,
    ]);
    if (patch.status === "RUNNING") {
      throw new Error("RUNNING is acquired only through claimJob().");
    }
    const res = await client.query(
      `UPDATE gsc_sync_jobs
          SET status          = COALESCE($3, status),
              started_at      = COALESCE($4::timestamptz, started_at),
              completed_at    = COALESCE($5::timestamptz, completed_at),
              row_count       = COALESCE($6, row_count),
              error_code      = CASE WHEN $7::boolean THEN $8 ELSE error_code END,
              error_message   = CASE WHEN $7::boolean THEN $9 ELSE error_message END,
              attempt         = COALESCE($10, attempt),
              next_retry_at   = CASE WHEN $11::boolean THEN $12::timestamptz ELSE next_retry_at END
        WHERE organization_id = $1 AND id = $2
          AND status = 'RUNNING' AND attempt = $13`,
      [
        organizationId,
        jobId,
        patch.status ?? null,
        patch.startedAt ?? null,
        patch.completedAt ?? null,
        patch.rowCount ?? null,
        patch.errorCode !== undefined,
        patch.errorCode ?? null,
        patch.errorMessage ?? null,
        patch.attempt ?? null,
        patch.nextRetryAt !== undefined,
        patch.nextRetryAt ?? null,
        patch.expectedAttempt,
      ],
    );
    if ((res.rowCount ?? 0) === 0) return false;
    if (patch.status === "COMPLETED") {
      // The fetch that started most recently owns dates covered by both
      // completed windows, regardless of completion order. Retire older rows
      // under the property lock in the same transaction as publishing this
      // attempt, so readers never see duplicate or partially replaced data.
      await client.query(
        `DELETE FROM gsc_query_metrics AS m
          USING gsc_sync_jobs AS old_job
          WHERE old_job.id = m.sync_job_id
            AND old_job.organization_id = $1
            AND old_job.project_id = $2
            AND old_job.connection_id = $3
            AND old_job.status = 'COMPLETED'
            AND old_job.id <> $4
            AND ROW(old_job.claim_order, old_job.id) <= ROW($7::bigint, $4::uuid)
            AND m.metric_date BETWEEN $5::date AND $6::date`,
        [
          organizationId,
          current.project_id,
          current.connection_id,
          jobId,
          current.window_start,
          current.window_end,
          current.claim_order,
        ],
      );
      await client.query(
        `DELETE FROM gsc_query_metrics AS m
          USING gsc_sync_jobs AS newer_job
          WHERE m.organization_id = $1
            AND m.project_id = $2
            AND m.sync_job_id = $4
            AND newer_job.organization_id = $1
            AND newer_job.project_id = $2
            AND newer_job.connection_id = $3
            AND newer_job.status = 'COMPLETED'
            AND newer_job.id <> $4
            AND ROW(newer_job.claim_order, newer_job.id) > ROW($5::bigint, $4::uuid)
            AND m.metric_date BETWEEN newer_job.window_start AND newer_job.window_end`,
        [organizationId, current.project_id, current.connection_id, jobId, current.claim_order],
      );
    }
    return true;
  });
}

// ═══════════ Search Analytics metrics ═══════════

/**
 * Replace a window's rows with the freshly fetched ones.
 *
 * DELETE + INSERT in one tenant transaction gives both idempotency (a retried
 * job rewrites the same window) and correct refresh semantics (Google revises
 * recent PRELIMINARY data, so overwriting beats appending duplicates).
 * An empty result set still replaces: a completed fetch that returned nothing
 * means the window has no rows — stale rows must not survive it.
 * Returns the number of rows written.
 */
export async function persistMetricWindow(input: {
  organizationId: string;
  projectId: string;
  syncJobId: string;
  expectedAttempt: number;
  window: GscWindow;
  rows: readonly GscMetricInput[];
}): Promise<number> {
  return withTenant(input.organizationId, async (client) => {
    const job = await client.query<{ connection_id: string }>(
      `SELECT connection_id FROM gsc_sync_jobs
        WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
      [input.organizationId, input.projectId, input.syncJobId],
    );
    const connectionId = job.rows[0]?.connection_id;
    if (!connectionId) throw new GscTenantScopeError("Sync job not found in this project.");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${input.organizationId}:${input.projectId}:${connectionId}`,
    ]);
    const claim = await client.query<{ status: string; attempt: number }>(
      `SELECT status, attempt FROM gsc_sync_jobs
        WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
      [input.organizationId, input.projectId, input.syncJobId],
    );
    const currentClaim = claim.rows[0];
    if (currentClaim?.status !== "RUNNING" || currentClaim.attempt !== input.expectedAttempt) {
      throw new GscSyncAttemptLostError();
    }
    await client.query(
      `DELETE FROM gsc_query_metrics
       WHERE organization_id = $1 AND project_id = $2
         AND metric_date BETWEEN $3::date AND $4::date
         AND sync_job_id = $5`,
      [
        input.organizationId,
        input.projectId,
        input.window.startDate,
        input.window.endDate,
        input.syncJobId,
      ],
    );
    if (input.rows.length === 0) return 0;
    const dates = input.rows.map((r) => r.date);
    const res = await client.query(
      `INSERT INTO gsc_query_metrics
         (organization_id, project_id, sync_job_id, metric_date, query, page, country, device,
          clicks, impressions, ctr, position)
       SELECT $1, $2, $3, d::date, q, p, c, dev, cl, im, ct, po
         FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                     $9::float8[], $10::float8[], $11::float8[], $12::float8[])
              AS t(d, q, p, c, dev, cl, im, ct, po)
       ON CONFLICT (sync_job_id, metric_date, query, page, country, device) DO UPDATE
          SET clicks = EXCLUDED.clicks,
              impressions = EXCLUDED.impressions,
              ctr = EXCLUDED.ctr,
              position = EXCLUDED.position`,
      [
        input.organizationId,
        input.projectId,
        input.syncJobId,
        dates,
        input.rows.map((r) => r.query),
        input.rows.map((r) => r.page),
        input.rows.map((r) => r.country),
        input.rows.map((r) => r.device),
        input.rows.map((r) => r.clicks),
        input.rows.map((r) => r.impressions),
        input.rows.map((r) => r.ctr),
        input.rows.map((r) => r.position),
      ],
    );
    return res.rowCount ?? 0;
  });
}

/** Pair each defined filter with its own placeholder — params and clauses can
 * never disagree, and no unused parameter is ever sent. */
function filterClauses(
  filters: GscMetricFilters | undefined,
  firstIndex = 5,
): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let index = firstIndex;
  const add = (column: string, value: string | undefined): void => {
    if (!value) return;
    clauses.push(`${column} = $${index}`);
    params.push(value);
    index += 1;
  };
  add("query", filters?.query);
  add("page", filters?.page);
  add("device", filters?.device);
  add("country", filters?.country);
  if (filters?.connectionId) {
    clauses.push(
      `sync_job_id IN (
         SELECT id FROM gsc_sync_jobs
          WHERE organization_id = $1 AND project_id = $2 AND connection_id = $${index}
       )`,
    );
    params.push(filters.connectionId);
    index += 1;
  }
  return { clauses, params };
}

/** Raw metric rows in a window (dates as `YYYY-MM-DD` text — never a local Date). */
export async function loadMetricRows(
  organizationId: string,
  projectId: string,
  window: GscWindow,
  filters?: GscMetricFilters,
  limit = 200_000,
): Promise<(GscMetricInput & { id: string })[]> {
  return withTenant(organizationId, async (client) => {
    const filter = filterClauses(filters);
    const clauses = [
      `organization_id = $1`,
      `project_id = $2`,
      `metric_date BETWEEN $3::date AND $4::date`,
      `sync_job_id IN (
         SELECT id FROM gsc_sync_jobs
          WHERE organization_id = $1 AND project_id = $2 AND status = 'COMPLETED'
       )`,
      ...filter.clauses,
    ];
    const maxRows = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 200_000;
    const res = await client.query<GscMetricInput & { id: string }>(
      `SELECT id, metric_date::text AS date, query, page, country, device,
              clicks, impressions, ctr, position
         FROM gsc_query_metrics
        WHERE ${clauses.join(" AND ")}
        ORDER BY metric_date, query, page, country, device, sync_job_id
        LIMIT ${maxRows + 1}`,
      [organizationId, projectId, window.startDate, window.endDate, ...filter.params],
    );
    if (res.rows.length > maxRows) throw new GscMeasurementWindowTooLargeError(maxRows);
    return res.rows;
  });
}

export interface GscDailyPoint {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Per-date aggregates for the Search Performance series. */
export async function metricSeries(
  organizationId: string,
  projectId: string,
  window: GscWindow,
  filters?: GscMetricFilters,
): Promise<GscDailyPoint[]> {
  return withTenant(organizationId, async (client) => {
    const filter = filterClauses(filters);
    const clauses = [
      `organization_id = $1`,
      `project_id = $2`,
      `metric_date BETWEEN $3::date AND $4::date`,
      `sync_job_id IN (
         SELECT id FROM gsc_sync_jobs
          WHERE organization_id = $1 AND project_id = $2 AND status = 'COMPLETED'
       )`,
      ...filter.clauses,
    ];
    const res = await client.query<{
      date: string;
      clicks: number;
      impressions: number;
      ctr: number;
      position: number;
    }>(
      `SELECT metric_date::text AS date,
              sum(clicks)::float8 AS clicks,
              sum(impressions)::float8 AS impressions,
              CASE WHEN sum(impressions) > 0
                   THEN sum(clicks) / sum(impressions) ELSE 0 END AS ctr,
              CASE WHEN sum(impressions) > 0
                   THEN sum(position * impressions) / sum(impressions) ELSE 0 END AS position
         FROM gsc_query_metrics
        WHERE ${clauses.join(" AND ")}
        GROUP BY metric_date
        ORDER BY metric_date`,
      [organizationId, projectId, window.startDate, window.endDate, ...filter.params],
    );
    return res.rows;
  });
}

export interface GscFreshness {
  /** Latest metric_date actually persisted for the project (null = no data). */
  latestMetricDate: string | null;
  /** Most recent completed sync, ISO. */
  lastSyncAt: string | null;
  /** Rows persisted for the project in total. */
  totalRows: number;
}

/** Freshness metadata — never claims newer data than what is stored. */
export async function metricFreshness(
  organizationId: string,
  projectId: string,
  connectionId?: string,
): Promise<GscFreshness> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<{
      latest: string | null;
      last_sync: Date | null;
      total: number;
    }>(
      `SELECT (SELECT max(metric_date)::text FROM gsc_query_metrics
                WHERE organization_id = $1 AND project_id = $2
                  AND sync_job_id IN (
                    SELECT id FROM gsc_sync_jobs WHERE organization_id = $1 AND project_id = $2 AND status = 'COMPLETED'
                  )
                  AND ($3::uuid IS NULL OR sync_job_id IN (
                    SELECT id FROM gsc_sync_jobs WHERE organization_id = $1 AND project_id = $2 AND connection_id = $3
                  ))) AS latest,
              (SELECT max(last_sync_at) FROM gsc_connections
                WHERE organization_id = $1 AND project_id = $2
                  AND ($3::uuid IS NULL OR id = $3)) AS last_sync,
              (SELECT count(*)::int FROM gsc_query_metrics
                WHERE organization_id = $1 AND project_id = $2
                  AND sync_job_id IN (
                    SELECT id FROM gsc_sync_jobs WHERE organization_id = $1 AND project_id = $2 AND status = 'COMPLETED'
                  )
                  AND ($3::uuid IS NULL OR sync_job_id IN (
                    SELECT id FROM gsc_sync_jobs WHERE organization_id = $1 AND project_id = $2 AND connection_id = $3
                  ))) AS total`,
      [organizationId, projectId, connectionId ?? null],
    );
    const row = res.rows[0];
    return {
      latestMetricDate: row?.latest ?? null,
      lastSyncAt: row?.last_sync ? row.last_sync.toISOString() : null,
      totalRows: row?.total ?? 0,
    };
  });
}
