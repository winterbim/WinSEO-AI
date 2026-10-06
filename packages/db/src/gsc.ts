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
      [
        input.organizationId,
        input.projectId,
        input.stateHash,
        input.codeVerifier,
        input.expiresAt,
      ],
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
export async function deleteCredential(organizationId: string, projectId: string): Promise<boolean> {
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
 * Create, or re-arm, the job for a (connection, window).
 *
 * The idempotency key makes a retried window address the SAME row: a second
 * attempt cannot create a twin job that would double-count metrics.
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
    const res = await client.query<GscSyncJobRow>(
      `INSERT INTO gsc_sync_jobs
         (organization_id, project_id, connection_id, window_start, window_end, idempotency_key)
       VALUES ($1, $2, $3, $4::date, $5::date, $6)
       ON CONFLICT (connection_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET status = 'PENDING',
                     error_code = NULL,
                     error_message = NULL,
                     next_retry_at = NULL
       RETURNING *`,
      [
        input.organizationId,
        input.projectId,
        input.connectionId,
        input.windowStart,
        input.windowEnd,
        input.idempotencyKey,
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
      `SELECT * FROM gsc_sync_jobs WHERE organization_id = $1 AND id = $2`,
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
      `SELECT * FROM gsc_sync_jobs
        WHERE organization_id = $1 AND project_id = $2
        ORDER BY requested_at DESC, id DESC`,
      [organizationId, projectId],
    );
    return res.rows;
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
}

export async function updateJob(
  organizationId: string,
  jobId: string,
  patch: GscJobPatch,
): Promise<boolean> {
  return withTenant(organizationId, async (client) => {
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
        WHERE organization_id = $1 AND id = $2`,
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
      ],
    );
    return (res.rowCount ?? 0) > 0;
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
  window: GscWindow;
  rows: readonly GscMetricInput[];
}): Promise<number> {
  return withTenant(input.organizationId, async (client) => {
    await client.query(
      `DELETE FROM gsc_query_metrics
        WHERE organization_id = $1 AND project_id = $2
          AND metric_date BETWEEN $3::date AND $4::date`,
      [input.organizationId, input.projectId, input.window.startDate, input.window.endDate],
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
      ...filter.clauses,
    ];
    const res = await client.query<GscMetricInput & { id: string }>(
      `SELECT id, metric_date::text AS date, query, page, country, device,
              clicks, impressions, ctr, position
         FROM gsc_query_metrics
        WHERE ${clauses.join(" AND ")}
        ORDER BY metric_date, query, page, country, device
        LIMIT ${Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 200_000}`,
      [organizationId, projectId, window.startDate, window.endDate, ...filter.params],
    );
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
      ...filter.clauses,
    ];
    const res = await client.query<{ date: string; clicks: number; impressions: number; ctr: number; position: number }>(
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
): Promise<GscFreshness> {
  return withTenant(organizationId, async (client) => {
    const res = await client.query<{
      latest: string | null;
      last_sync: Date | null;
      total: number;
    }>(
      `SELECT (SELECT max(metric_date)::text FROM gsc_query_metrics
                WHERE organization_id = $1 AND project_id = $2) AS latest,
              (SELECT max(last_sync_at) FROM gsc_connections
                WHERE organization_id = $1 AND project_id = $2) AS last_sync,
              (SELECT count(*)::int FROM gsc_query_metrics
                WHERE organization_id = $1 AND project_id = $2) AS total`,
      [organizationId, projectId],
    );
    const row = res.rows[0];
    return {
      latestMetricDate: row?.latest ?? null,
      lastSyncAt: row?.last_sync ? row.last_sync.toISOString() : null,
      totalRows: row?.total ?? 0,
    };
  });
}
