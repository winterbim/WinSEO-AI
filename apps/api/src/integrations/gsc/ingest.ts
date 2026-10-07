// ─── GSC Search Analytics ingestion ───
//
// Responsibilities, in order:
//   1. One active job per (connection, window), atomically claimed; completed
//      attempts remain immutable history and a fresh attempt replaces them.
//   2. A valid access token (refreshing transparently; no credentials →
//      CREDENTIALS_REQUIRED, never fabricated rows).
//   3. Paginated fetch with deterministic de-duplication across pages.
//   4. Validation of every row against the window before it can be stored.
//   5. Atomic window replacement (Google revises recent PRELIMINARY data).
//   6. Classified retry with exponential backoff for transient failures only.

import { validateGscRow } from "./sync.ts";
import { GscCredentialsRequiredError, type GscMetricRow, type GscSyncWindow } from "./types.ts";
import {
  GscApiError,
  type GoogleTransport,
  type SearchAnalyticsRequest,
} from "./google-transport.ts";
import { getValidAccessToken } from "./oauth.ts";
import type { GscStore, GscWindowRange } from "../../stores/types.ts";
import { GSC_SYNC_JOB_LEASE_MS, GscSyncAttemptLostError } from "@serpvera/db";

/** Dimensions persisted by 0006 — one row per day × query × page × country × device. */
export const GSC_DIMENSIONS = ["date", "query", "page", "country", "device"] as const;
export const DEFAULT_ROW_LIMIT = 25_000; // Google's documented page maximum
export const DEFAULT_MAX_ROWS = 250_000; // Hard cap so one job cannot exhaust memory
export const DEFAULT_MAX_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 250;
/** Quota exhaustion deserves a longer cool-down than a transient 5xx. */
export const QUOTA_BACKOFF_MULTIPLIER = 8;

export interface GscIngestDeps {
  store: GscStore;
  transport: GoogleTransport;
  key: Buffer;
  clientId: string;
  clientSecret: string;
  organizationId: string;
  projectId: string;
  connectionId: string;
  property: string;
  rowLimit?: number;
  maxRows?: number;
  maxAttempts?: number;
  /** Injectable so retry backoff is provable without real waiting. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type GscIngestStatus =
  "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CREDENTIALS_REQUIRED" | "RETRY_SCHEDULED";

export interface GscIngestOutcome {
  jobId: string;
  status: GscIngestStatus;
  rowCount: number;
  attempt: number;
  window: GscWindowRange;
  /** Present unless the job completed; null on success. */
  error?: { code: string; message: string; retryable: boolean } | null;
  nextRetryAt: string | null;
  freshness: {
    latestMetricDate: string | null;
    lastSyncAt: string | null;
    totalRows: number;
  };
}

/**
 * Merge rows that share a dimension key.
 *
 * Pagination can drift while Google re-aggregates, producing duplicate keys
 * across pages. Summing clicks/impressions and re-deriving CTR and
 * impression-weighted position is the only aggregation that stays arithmetically
 * honest — averaging the averages would not.
 */
export function aggregateMetricRows(rows: readonly GscMetricRow[]): GscMetricRow[] {
  const byKey = new Map<
    string,
    { row: GscMetricRow; clicks: number; impressions: number; positionWeighted: number }
  >();
  for (const row of rows) {
    const key = `${row.date} ${row.query} ${row.page} ${row.country} ${row.device}`;
    const entry = byKey.get(key);
    if (!entry) {
      byKey.set(key, {
        row,
        clicks: row.clicks,
        impressions: row.impressions,
        positionWeighted: row.position * row.impressions,
      });
      continue;
    }
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.positionWeighted += row.position * row.impressions;
  }
  return [...byKey.values()].map(({ row, clicks, impressions, positionWeighted }) => ({
    ...row,
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? positionWeighted / impressions : 0,
  }));
}

/** Exponential backoff; quota exhaustion waits noticeably longer. */
export function backoffMs(attempt: number, error?: GscApiError): number {
  const multiplier = error?.code === "QUOTA_EXCEEDED" ? QUOTA_BACKOFF_MULTIPLIER : 1;
  return RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) * multiplier;
}

async function fetchAllPages(
  deps: GscIngestDeps,
  accessToken: string,
  window: GscSyncWindow,
): Promise<GscMetricRow[]> {
  const rowLimit = deps.rowLimit ?? DEFAULT_ROW_LIMIT;
  const maxRows = deps.maxRows ?? DEFAULT_MAX_ROWS;
  const collected: GscMetricRow[] = [];
  let startRow = 0;

  for (;;) {
    const request: SearchAnalyticsRequest = {
      startDate: window.startDate,
      endDate: window.endDate,
      dimensions: [...GSC_DIMENSIONS],
      rowLimit,
      startRow,
    };
    const page = await deps.transport.querySearchAnalytics(accessToken, deps.property, request);
    if (page.rows.length === 0) break;
    collected.push(...page.rows);
    if (page.rows.length < rowLimit) break;
    if (collected.length >= maxRows) break;
    startRow += page.rows.length;
  }

  return collected.slice(0, maxRows);
}

/**
 * Run (or re-run) the ingestion job for `window`.
 *
 * Returns an outcome instead of throwing for expected operational failures —
 * the job row is the record of truth and the caller decides how to surface it.
 */
export async function runGscIngest(
  deps: GscIngestDeps,
  window: GscSyncWindow,
): Promise<GscIngestOutcome> {
  const range = { startDate: window.startDate, endDate: window.endDate };
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const job = await deps.store.createOrReuseJob({
    organizationId: deps.organizationId,
    projectId: deps.projectId,
    connectionId: deps.connectionId,
    windowStart: window.startDate,
    windowEnd: window.endDate,
    idempotencyKey: `${window.startDate}:${window.endDate}`,
  });

  let attempt = job.attempt;
  let latestMetricDate: string | null = null;
  let lastSyncAt: string | null = null;
  let totalRows = 0;

  const readFreshness = async () => {
    const fresh = await deps.store.metricFreshness(deps.organizationId, deps.projectId);
    latestMetricDate = fresh.latestMetricDate;
    lastSyncAt = fresh.lastSyncAt;
    totalRows = fresh.totalRows;
  };
  await readFreshness();

  const currentOutcome = async (): Promise<GscIngestOutcome> => {
    const current = await deps.store.getJob(deps.organizationId, job.id);
    await readFreshness();
    const status = current?.status;
    const knownStatus: GscIngestStatus =
      status === "COMPLETED" || status === "FAILED" || status === "CREDENTIALS_REQUIRED"
        ? status
        : status === "PENDING"
          ? "PENDING"
          : "RUNNING";
    return {
      jobId: job.id,
      status: knownStatus,
      rowCount: current?.rowCount ?? 0,
      attempt: current?.attempt ?? job.attempt,
      window: range,
      error: current?.errorCode
        ? {
            code: current.errorCode,
            message: current.errorMessage ?? "Search Console sync did not complete.",
            retryable: current.nextRetryAt !== null,
          }
        : null,
      nextRetryAt: current?.nextRetryAt ?? null,
      freshness: { latestMetricDate, lastSyncAt, totalRows },
    };
  };

  const claimAttempt = await deps.store.claimJob(
    deps.organizationId,
    job.id,
    new Date(now()).toISOString(),
  );
  if (claimAttempt === null) return currentOutcome();

  const finish = async (
    status: GscIngestOutcome["status"],
    extra: {
      rowCount?: number;
      error?: { code: string; message: string; retryable: boolean } | null;
      nextRetryAt?: string | null;
    },
  ): Promise<GscIngestOutcome> => {
    const updated = await deps.store.updateJob(deps.organizationId, job.id, {
      status,
      attempt,
      expectedAttempt: claimAttempt,
      rowCount: extra.rowCount,
      errorCode: extra.error?.code ?? null,
      errorMessage: extra.error?.message ?? null,
      nextRetryAt: extra.nextRetryAt ?? null,
      completedAt:
        status === "COMPLETED" || status === "FAILED" ? new Date(now()).toISOString() : undefined,
    });
    if (!updated) return currentOutcome();
    if (status === "COMPLETED") {
      await deps.store.markConnectionSynced(
        deps.organizationId,
        deps.connectionId,
        new Date(now()).toISOString(),
      );
    }
    await readFreshness();
    return {
      jobId: job.id,
      status,
      rowCount: extra.rowCount ?? 0,
      attempt,
      window: range,
      error: extra.error,
      nextRetryAt: extra.nextRetryAt ?? null,
      freshness: { latestMetricDate, lastSyncAt, totalRows },
    };
  };

  let lastError: GscApiError | undefined;
  let rows: GscMetricRow[] = [];

  for (let tries = 0; tries < maxAttempts; tries++) {
    attempt += 1;
    try {
      const accessToken = await getValidAccessToken({
        store: deps.store,
        transport: deps.transport,
        key: deps.key,
        clientId: deps.clientId,
        clientSecret: deps.clientSecret,
        organizationId: deps.organizationId,
        projectId: deps.projectId,
        now: now(),
      });
      rows = await fetchAllPages(deps, accessToken, window);
      // Validate before any row can reach persistence. A date outside the
      // window or an impossible value is a protocol violation from the data
      // source — non-retryable, and never silently stored.
      for (const row of rows) {
        try {
          validateGscRow(row, window);
        } catch (err) {
          throw new GscApiError("INVALID_ARGUMENT", (err as Error).message, {
            retryable: false,
          });
        }
      }
      lastError = undefined;
      break;
    } catch (err) {
      if (err instanceof GscCredentialsRequiredError) {
        // No grant, no data. The job says so; nothing is invented.
        return finish("CREDENTIALS_REQUIRED", {
          error: {
            code: "CREDENTIALS_REQUIRED",
            message: "Google OAuth credentials are required for live Search Analytics.",
            retryable: false,
          },
          nextRetryAt: null,
        });
      }
      const apiError =
        err instanceof GscApiError
          ? err
          : new GscApiError("UNKNOWN", (err as Error).message, { retryable: false });
      lastError = apiError;
      if (!apiError.retryable || tries === maxAttempts - 1) break;
      await sleep(backoffMs(attempt, apiError));
    }
  }

  if (lastError) {
    const retryable = lastError.retryable;
    const nextRetryAt = retryable
      ? new Date(now() + backoffMs(attempt + 1, lastError)).toISOString()
      : null;
    return finish("FAILED", {
      error: { code: lastError.code, message: lastError.message, retryable },
      nextRetryAt,
    });
  }

  // Merging rows that share a dimension key cannot move a date or invent a
  // value, and every input row was validated above — the aggregate is valid.
  const deduped = aggregateMetricRows(rows);

  let written: number;
  try {
    written = await deps.store.persistMetricWindow({
      organizationId: deps.organizationId,
      projectId: deps.projectId,
      syncJobId: job.id,
      expectedAttempt: claimAttempt,
      window: range,
      rows: deduped,
    });
  } catch (err) {
    if (err instanceof GscSyncAttemptLostError) return currentOutcome();
    throw err;
  }

  return finish("COMPLETED", { rowCount: written, error: null, nextRetryAt: null });
}

/** Decide whether an operator/scheduler may run a stored job again. */
export function canRetryJob(
  job: { status: string; nextRetryAt: string | null; startedAt?: string | null },
  nowMs: number,
): boolean {
  if (job.status === "RUNNING") {
    const startedAt = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
    return Number.isFinite(startedAt) && nowMs - startedAt >= GSC_SYNC_JOB_LEASE_MS;
  }
  if (job.status === "COMPLETED") return false;
  if (job.status === "CREDENTIALS_REQUIRED") return false;
  if (job.status === "PENDING") return true;
  return job.nextRetryAt === null || Date.parse(job.nextRetryAt) <= nowMs;
}

// ─── Incremental synchronization windows ───

/**
 * Google revises recent rows (its data is PRELIMINARY for a few days), so every
 * incremental sync re-covers the last `GSC_REVISION_DAYS` days even if they
 * were synced before. Final historical days are synced once.
 */
export const GSC_REVISION_DAYS = 3;
/** First sync without history: look back this far, never fabricate more. */
export const DEFAULT_INCREMENTAL_LOOKBACK_DAYS = 28;

/**
 * The window an incremental job should fetch next.
 *
 * Pure date arithmetic — deterministic given (lastSyncDate, today):
 *   • never synced      → [today − lookback, yesterday]
 *   • synced before     → [lastSync − revision overlap, yesterday], clamped to
 *     the lookback floor so an old `lastSync` cannot request ancient history
 *     that a fresh install never asked for.
 * Yesterday is the ceiling: today's Google numbers are incomplete all day.
 */
export function deriveIncrementalWindow(
  lastSyncDate: string | null,
  today: string,
  lookbackDays: number = DEFAULT_INCREMENTAL_LOOKBACK_DAYS,
): GscSyncWindow {
  const DAY = 86_400_000;
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const endMs = todayMs - DAY; // yesterday
  const lookback = Math.max(1, Math.trunc(lookbackDays));
  const floorMs = endMs - (lookback - 1) * DAY;

  let startMs = floorMs;
  if (lastSyncDate) {
    const lastMs = Date.parse(`${lastSyncDate}T00:00:00Z`);
    if (Number.isFinite(lastMs)) {
      startMs = Math.max(lastMs - GSC_REVISION_DAYS * DAY, floorMs);
    }
  }
  if (startMs > endMs) startMs = endMs;

  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return { startDate: iso(startMs), endDate: iso(endMs) };
}
