// ─── Deterministic test doubles for the GSC integration ───
//
// Fixtures live ONLY here and are reachable only from *.test.ts files. The
// evidence policy allows fixtures for deterministic adapter tests; production
// code paths never import this module. Every double is a pure in-memory
// simulation: same inputs → same behaviour, no clock of its own (expiry checks
// compare against Date.now() exactly like production).

import type {
  GscCredentialInput,
  GscDailyPoint,
  GscFreshness,
  GscMetricFilter,
  GscMetricPoint,
  GscStore,
  GscWindowRange,
  StoredGscConnection,
  StoredGscCredential,
  StoredGscJob,
} from "../../stores/types.ts";
import { GSC_SYNC_JOB_LEASE_MS, GscSyncAttemptLostError } from "@serpvera/db";
import { GscApiError } from "./google-transport.ts";
import type {
  GoogleTokenResponse,
  GoogleTransport,
  GscSiteEntry,
  SearchAnalyticsRequest,
  SearchAnalyticsResponse,
} from "./google-transport.ts";
import type { GscMetricRow, GscSyncWindow } from "./types.ts";

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq.toString().padStart(4, "0")}`;
}

/** A metric row with sensible defaults; override per scenario. */
export function metricRow(partial: Partial<GscMetricRow> = {}): GscMetricRow {
  return {
    date: "2026-09-15",
    query: "evidence seo",
    page: "https://example.com/evidence",
    country: "fra",
    device: "DESKTOP",
    clicks: 4,
    impressions: 40,
    ctr: 0.1,
    position: 3.5,
    ...partial,
  };
}

// ═══════════ In-memory GscStore (mirrors the PostgreSQL contract) ═══════════

interface OauthStateRow {
  organizationId: string;
  projectId: string;
  stateHash: string;
  codeVerifier: string;
  expiresAt: string;
  usedAt: string | null;
}

interface MetricRowRecord extends GscMetricPoint {
  organizationId: string;
  projectId: string;
  syncJobId: string;
}

export class FakeGscStore implements GscStore {
  readonly oauthStates = new Map<string, OauthStateRow>();
  readonly credentials = new Map<string, StoredGscCredential & { organizationId: string }>();
  readonly connections = new Map<string, StoredGscConnection & { organizationId: string }>();
  readonly jobs = new Map<
    string,
    StoredGscJob & { organizationId: string; idempotencyKey: string | null }
  >();
  readonly metrics: MetricRowRecord[] = [];
  readonly persistCalls: GscWindowRange[] = [];

  private key(organizationId: string, projectId: string): string {
    return `${organizationId}:${projectId}`;
  }

  createOauthState(input: {
    organizationId: string;
    projectId: string;
    stateHash: string;
    codeVerifier: string;
    expiresAt: string;
  }): Promise<void> {
    this.oauthStates.set(input.stateHash, { ...input, usedAt: null });
    return Promise.resolve();
  }

  consumeOauthState(
    organizationId: string,
    stateHash: string,
  ): Promise<{ projectId: string; codeVerifier: string } | null> {
    const row = this.oauthStates.get(stateHash);
    const claimable =
      row?.organizationId === organizationId &&
      row.usedAt === null &&
      Date.parse(row.expiresAt) > Date.now();
    if (!row || !claimable) return Promise.resolve(null);
    row.usedAt = new Date().toISOString();
    return Promise.resolve({ projectId: row.projectId, codeVerifier: row.codeVerifier });
  }

  upsertCredential(input: GscCredentialInput): Promise<string> {
    const key = this.key(input.organizationId, input.projectId);
    const existing = this.credentials.get(key);
    const record = {
      id: existing?.id ?? id("cred"),
      organizationId: input.organizationId,
      projectId: input.projectId,
      encryptedRefreshToken: input.encryptedRefreshToken,
      encryptedAccessToken: input.encryptedAccessToken,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      scope: input.scope,
      googleSubject: input.googleSubject,
    };
    this.credentials.set(key, record);
    return Promise.resolve(record.id);
  }

  getCredential(organizationId: string, projectId: string): Promise<StoredGscCredential | null> {
    const row = this.credentials.get(this.key(organizationId, projectId));
    return Promise.resolve(row ? { ...row } : null);
  }

  updateCredentialTokens(input: {
    organizationId: string;
    projectId: string;
    encryptedAccessToken: string;
    accessTokenExpiresAt: string;
    encryptedRefreshToken?: string;
  }): Promise<boolean> {
    const row = this.credentials.get(this.key(input.organizationId, input.projectId));
    if (!row) return Promise.resolve(false);
    row.encryptedAccessToken = input.encryptedAccessToken;
    row.accessTokenExpiresAt = input.accessTokenExpiresAt;
    if (input.encryptedRefreshToken !== undefined) {
      row.encryptedRefreshToken = input.encryptedRefreshToken;
    }
    return Promise.resolve(true);
  }

  deleteCredential(organizationId: string, projectId: string): Promise<boolean> {
    return Promise.resolve(this.credentials.delete(this.key(organizationId, projectId)));
  }

  createConnection(input: {
    organizationId: string;
    projectId: string;
    externalProperty: string;
    scope?: string;
    credentialRef: string;
  }): Promise<StoredGscConnection> {
    for (const row of this.connections.values()) {
      if (row.projectId === input.projectId && row.externalProperty === input.externalProperty) {
        if (row.status !== "DISCONNECTED") {
          // Mirrors the UNIQUE (project_id, external_property) constraint.
          const err = new Error("duplicate connection") as Error & { code?: string };
          err.code = "23505";
          return Promise.reject(err);
        }
        // Mirrors ON CONFLICT … DO UPDATE WHERE status = 'DISCONNECTED'.
        row.status = "CONNECTED";
        row.connectedAt = new Date().toISOString();
        row.credentialRef = input.credentialRef;
        row.scope = input.scope ?? row.scope;
        return Promise.resolve({ ...row });
      }
    }
    const row = {
      id: id("conn"),
      organizationId: input.organizationId,
      projectId: input.projectId,
      externalProperty: input.externalProperty,
      scope: input.scope ?? "site",
      credentialRef: input.credentialRef,
      status: "CONNECTED",
      connectedAt: new Date().toISOString(),
      lastSyncAt: null,
    };
    this.connections.set(row.id, row);
    return Promise.resolve({ ...row });
  }

  listConnections(organizationId: string, projectId: string): Promise<StoredGscConnection[]> {
    return Promise.resolve(
      [...this.connections.values()]
        .filter((r) => r.organizationId === organizationId && r.projectId === projectId)
        .map(({ organizationId: _org, ...rest }) => ({ ...rest })),
    );
  }

  getConnection(organizationId: string, connectionId: string): Promise<StoredGscConnection | null> {
    const row = this.connections.get(connectionId);
    if (row?.organizationId !== organizationId) return Promise.resolve(null);
    const { organizationId: _org, ...rest } = row;
    return Promise.resolve({ ...rest });
  }

  disconnectConnection(organizationId: string, connectionId: string): Promise<boolean> {
    const row = this.connections.get(connectionId);
    if (row?.organizationId !== organizationId) return Promise.resolve(false);
    row.status = "DISCONNECTED";
    return Promise.resolve(true);
  }

  markConnectionSynced(organizationId: string, connectionId: string, at: string): Promise<void> {
    const row = this.connections.get(connectionId);
    if (row?.organizationId === organizationId) row.lastSyncAt = at;
    return Promise.resolve();
  }

  createOrReuseJob(input: {
    organizationId: string;
    projectId: string;
    connectionId: string;
    windowStart: string;
    windowEnd: string;
    idempotencyKey: string;
  }): Promise<StoredGscJob> {
    const previous = [...this.jobs.values()].filter(
      (job) =>
        job.connectionId === input.connectionId &&
        (job.idempotencyKey === input.idempotencyKey ||
          job.idempotencyKey?.startsWith(`${input.idempotencyKey}:attempt:`)),
    );
    const latest = previous.at(-1);
    const staleRunning =
      latest?.status === "RUNNING" &&
      latest.startedAt !== null &&
      Date.now() - Date.parse(latest.startedAt) >= GSC_SYNC_JOB_LEASE_MS;
    if (latest && (latest.status === "PENDING" || (latest.status === "RUNNING" && !staleRunning))) {
      const { organizationId: _org, idempotencyKey: _ik, ...rest } = latest;
      return Promise.resolve({ ...rest });
    }
    if (latest && latest.status !== "COMPLETED") {
      latest.status = "PENDING";
      latest.startedAt = null;
      latest.completedAt = null;
      latest.rowCount = 0;
      latest.errorCode = null;
      latest.errorMessage = null;
      latest.nextRetryAt = null;
      const { organizationId: _org, idempotencyKey: _ik, ...rest } = latest;
      return Promise.resolve({ ...rest });
    }
    const row = {
      id: id("job"),
      organizationId: input.organizationId,
      projectId: input.projectId,
      connectionId: input.connectionId,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      status: "PENDING",
      rowCount: 0,
      attempt: 0,
      errorCode: null,
      errorMessage: null,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      nextRetryAt: null,
      idempotencyKey: latest
        ? `${input.idempotencyKey}:attempt:${id("attempt")}`
        : input.idempotencyKey,
    };
    this.jobs.set(row.id, row);
    const { organizationId: _org, idempotencyKey: _ik, ...rest } = row;
    return Promise.resolve({ ...rest });
  }

  getJob(organizationId: string, jobId: string): Promise<StoredGscJob | null> {
    const row = this.jobs.get(jobId);
    if (row?.organizationId !== organizationId) return Promise.resolve(null);
    const { organizationId: _org, idempotencyKey: _ik, ...rest } = row;
    return Promise.resolve({ ...rest });
  }

  listJobs(organizationId: string, projectId: string): Promise<StoredGscJob[]> {
    return Promise.resolve(
      [...this.jobs.values()]
        .filter((j) => j.organizationId === organizationId && j.projectId === projectId)
        .map(({ organizationId: _org, idempotencyKey: _ik, ...rest }) => ({ ...rest })),
    );
  }

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
      expectedAttempt: number;
    },
  ): Promise<boolean> {
    const row = this.jobs.get(jobId);
    if (
      row?.organizationId !== organizationId ||
      row.status !== "RUNNING" ||
      row.attempt !== patch.expectedAttempt
    ) {
      return Promise.resolve(false);
    }
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.startedAt !== undefined) row.startedAt = patch.startedAt;
    if (patch.completedAt !== undefined) row.completedAt = patch.completedAt;
    if (patch.rowCount !== undefined) row.rowCount = patch.rowCount;
    if (patch.errorCode !== undefined) row.errorCode = patch.errorCode;
    if (patch.errorMessage !== undefined) row.errorMessage = patch.errorMessage;
    if (patch.attempt !== undefined) row.attempt = patch.attempt;
    if (patch.nextRetryAt !== undefined) row.nextRetryAt = patch.nextRetryAt;
    if (patch.status === "COMPLETED") {
      for (let i = this.metrics.length - 1; i >= 0; i--) {
        const metric = this.metrics[i];
        const previousJob = metric ? this.jobs.get(metric.syncJobId) : undefined;
        if (
          metric?.organizationId === organizationId &&
          metric.projectId === row.projectId &&
          metric.date >= row.windowStart &&
          metric.date <= row.windowEnd &&
          previousJob?.connectionId === row.connectionId &&
          previousJob.status === "COMPLETED" &&
          previousJob.id !== row.id
        ) {
          this.metrics.splice(i, 1);
        }
      }
    }
    return Promise.resolve(true);
  }

  claimJob(organizationId: string, jobId: string, startedAt: string): Promise<number | null> {
    const row = this.jobs.get(jobId);
    if (row?.organizationId !== organizationId || row.status !== "PENDING") {
      return Promise.resolve(null);
    }
    row.status = "RUNNING";
    row.startedAt = startedAt;
    row.completedAt = null;
    row.attempt += 1;
    return Promise.resolve(row.attempt);
  }

  persistMetricWindow(input: {
    organizationId: string;
    projectId: string;
    syncJobId: string;
    expectedAttempt: number;
    window: GscWindowRange;
    rows: readonly GscMetricPoint[];
  }): Promise<number> {
    const job = this.jobs.get(input.syncJobId);
    if (
      job?.organizationId !== input.organizationId ||
      job.projectId !== input.projectId ||
      job.status !== "RUNNING" ||
      job.attempt !== input.expectedAttempt
    ) {
      return Promise.reject(new GscSyncAttemptLostError());
    }
    // Preserve completed rows until the replacement attempt commits.
    this.persistCalls.push({ ...input.window });
    const inWindow = (p: GscMetricPoint): boolean =>
      p.date >= input.window.startDate && p.date <= input.window.endDate;
    for (let i = this.metrics.length - 1; i >= 0; i--) {
      const row = this.metrics[i];
      if (
        row?.organizationId === input.organizationId &&
        row.projectId === input.projectId &&
        inWindow(row) &&
        (row.syncJobId === input.syncJobId || this.jobs.get(row.syncJobId)?.status !== "COMPLETED")
      ) {
        this.metrics.splice(i, 1);
      }
    }
    for (const point of input.rows) {
      this.metrics.push({
        ...point,
        organizationId: input.organizationId,
        projectId: input.projectId,
        syncJobId: input.syncJobId,
      });
    }
    return Promise.resolve(input.rows.length);
  }

  loadMetricRows(
    organizationId: string,
    projectId: string,
    window: GscWindowRange,
    filters?: GscMetricFilter,
  ): Promise<GscMetricPoint[]> {
    return Promise.resolve(
      this.metrics
        .filter(
          (r) =>
            r.organizationId === organizationId &&
            r.projectId === projectId &&
            r.date >= window.startDate &&
            r.date <= window.endDate &&
            this.jobs.get(r.syncJobId)?.status === "COMPLETED" &&
            (!filters?.query || r.query === filters.query) &&
            (!filters?.page || r.page === filters.page) &&
            (!filters?.device || r.device === filters.device) &&
            (!filters?.country || r.country === filters.country),
        )
        .map(({ organizationId: _o, projectId: _p, syncJobId: _s, ...point }) => ({ ...point })),
    );
  }

  metricSeries(
    organizationId: string,
    projectId: string,
    window: GscWindowRange,
    filters?: GscMetricFilter,
  ): Promise<GscDailyPoint[]> {
    return this.loadMetricRows(organizationId, projectId, window, filters).then((rows) => {
      const byDate = new Map<string, { clicks: number; impressions: number; weighted: number }>();
      for (const row of rows) {
        const entry = byDate.get(row.date) ?? { clicks: 0, impressions: 0, weighted: 0 };
        entry.clicks += row.clicks;
        entry.impressions += row.impressions;
        entry.weighted += row.position * row.impressions;
        byDate.set(row.date, entry);
      }
      return [...byDate.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, e]) => ({
          date,
          clicks: e.clicks,
          impressions: e.impressions,
          ctr: e.impressions > 0 ? e.clicks / e.impressions : 0,
          position: e.impressions > 0 ? e.weighted / e.impressions : 0,
        }));
    });
  }

  metricFreshness(organizationId: string, projectId: string): Promise<GscFreshness> {
    const rows = this.metrics.filter(
      (r) =>
        r.organizationId === organizationId &&
        r.projectId === projectId &&
        this.jobs.get(r.syncJobId)?.status === "COMPLETED",
    );
    const dates = rows.map((r) => r.date).sort();
    const syncs = [...this.connections.values()]
      .filter((c) => c.organizationId === organizationId && c.projectId === projectId)
      .map((c) => c.lastSyncAt)
      .filter((v): v is string => v !== null)
      .sort();
    return Promise.resolve({
      latestMetricDate: dates.at(-1) ?? null,
      lastSyncAt: syncs.at(-1) ?? null,
      totalRows: rows.length,
    });
  }
}

// ═══════════ Scripted GoogleTransport (wire contract double) ═══════════

export interface FakeTransportScript {
  sites?: GscSiteEntry[];
  /** Per-token listings — lets tests discriminate "listed for THIS grant". */
  sitesByToken?: Record<string, GscSiteEntry[]>;
  /** Full row set served to searchAnalytics/query, sliced like Google's API. */
  analyticsRows?: GscMetricRow[];
  tokenResponse?: Partial<GoogleTokenResponse>;
  refreshTokenResponse?: Partial<GoogleTokenResponse>;
  /** Consumed in order before any success; the last one repeats. */
  exchangeErrors?: GscApiError[];
  refreshErrors?: GscApiError[];
  revokeErrors?: GscApiError[];
  queryErrors?: GscApiError[];
}

export class FakeGoogleTransport implements GoogleTransport {
  readonly exchangedCodes: string[] = [];
  readonly exchangedVerifiers: string[] = [];
  readonly refreshTokensUsed: string[] = [];
  readonly revokedTokens: string[] = [];
  readonly analyticsRequests: SearchAnalyticsRequest[] = [];
  readonly script: FakeTransportScript;

  constructor(script: FakeTransportScript = {}) {
    this.script = script;
  }

  /** Failures are consumed in order; an empty queue means success. */
  private take(queue: GscApiError[] | undefined): GscApiError | null {
    return queue?.shift() ?? null;
  }

  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<GoogleTokenResponse> {
    this.exchangedCodes.push(input.code);
    this.exchangedVerifiers.push(input.codeVerifier);
    const failure = this.take(this.script.exchangeErrors);
    if (failure) return Promise.reject(failure);
    return Promise.resolve({
      accessToken: "ya29.fixture-access-token",
      refreshToken: "1//fixture-refresh-token",
      expiresIn: 3599,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      tokenId: "fixture.id.token",
      ...this.script.tokenResponse,
    });
  }

  refreshAccessToken(input: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  }): Promise<GoogleTokenResponse> {
    this.refreshTokensUsed.push(input.refreshToken);
    const failure = this.take(this.script.refreshErrors);
    if (failure) return Promise.reject(failure);
    return Promise.resolve({
      accessToken: "ya29.fixture-refreshed-access",
      expiresIn: 3599,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      ...this.script.refreshTokenResponse,
    });
  }

  revokeToken(input: { token: string; clientId: string; clientSecret: string }): Promise<void> {
    this.revokedTokens.push(input.token);
    const failure = this.take(this.script.revokeErrors);
    if (failure) return Promise.reject(failure);
    return Promise.resolve();
  }

  listSites(accessToken: string): Promise<GscSiteEntry[]> {
    return Promise.resolve(this.script.sitesByToken?.[accessToken] ?? this.script.sites ?? []);
  }

  querySearchAnalytics(
    _accessToken: string,
    _property: string,
    request: SearchAnalyticsRequest,
  ): Promise<SearchAnalyticsResponse> {
    this.analyticsRequests.push(request);
    const failure = this.take(this.script.queryErrors);
    if (failure) return Promise.reject(failure);
    const all = this.script.analyticsRows ?? [];
    const rows = all.slice(request.startRow, request.startRow + request.rowLimit);
    return Promise.resolve({ rows, aggregationType: "aggregateByDate" });
  }
}

/** Transport whose refresh always fails like a revoked refresh token does. */
export function invalidGrantError(): GscApiError {
  return new GscApiError("UNAUTHORIZED", "invalid_grant", { retryable: false, status: 400 });
}

/** Convenience: a window usable in fixture sync calls. */
export const FIXTURE_WINDOW: GscSyncWindow = {
  startDate: "2026-09-01",
  endDate: "2026-09-30",
};
