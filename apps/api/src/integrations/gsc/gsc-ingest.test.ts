// GSC-005 machinery — Search Analytics ingestion orchestration, deterministically.
//
// CLAIM: ingestion is idempotent per (connection, window), paginates and
// de-duplicates honestly (impression-weighted, never average-of-averages),
// validates every row before persistence, retries only classified-transient
// failures with exponential backoff (quota cools down longer), and reports
// CREDENTIALS_REQUIRED — never fabricated rows — when no grant exists.
// The live Google wire is gated separately (GSC-004/GSC-005 BLOCKED without
// real credentials); fixtures here are deterministic adapter tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateMetricRows,
  backoffMs,
  canRetryJob,
  deriveIncrementalWindow,
  GSC_REVISION_DAYS,
  QUOTA_BACKOFF_MULTIPLIER,
  RETRY_BASE_DELAY_MS,
  runGscIngest,
  type GscIngestDeps,
} from "./ingest.ts";
import { deriveGscKey, encryptSecret } from "./crypto.ts";
import { GscApiError } from "./google-transport.ts";
import type { GscMetricRow } from "./types.ts";
import {
  FakeGscStore,
  FakeGoogleTransport,
  FIXTURE_WINDOW,
  metricRow,
  type FakeTransportScript,
} from "./test-doubles.ts";

const KEY = deriveGscKey("gsc-ingest-test-master-secret-at-least-32-chars");
const ORG = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const NOW = Date.now();

async function harness(script: FakeTransportScript = {}, overrides: Partial<GscIngestDeps> = {}) {
  const store = new FakeGscStore();
  const connection = await store.createConnection({
    organizationId: ORG,
    projectId: PROJECT,
    externalProperty: "sc-domain:example.com",
    credentialRef: "cred-1",
  });
  await store.upsertCredential({
    organizationId: ORG,
    projectId: PROJECT,
    encryptedAccessToken: encryptSecret("ya29.access", KEY),
    encryptedRefreshToken: encryptSecret("1//refresh", KEY),
    accessTokenExpiresAt: new Date(NOW + 3_600_000).toISOString(),
    scope: "webmasters.readonly",
    googleSubject: null,
  });
  const transport = new FakeGoogleTransport(script);
  const sleeps: number[] = [];
  const deps: GscIngestDeps = {
    store,
    transport,
    key: KEY,
    clientId: "client",
    clientSecret: "secret",
    organizationId: ORG,
    projectId: PROJECT,
    connectionId: connection.id,
    property: "sc-domain:example.com",
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => NOW,
    ...overrides,
  };
  return { store, transport, sleeps, deps, connection };
}

void describe("GSC-005 ingestion — happy path and idempotency", () => {
  void it("persists validated rows, completes the job and records freshness", async () => {
    const rows = [
      metricRow({ date: "2026-09-15", clicks: 4, impressions: 40 }),
      metricRow({
        date: "2026-09-16",
        query: "second",
        page: "https://example.com/second",
        clicks: 1,
        impressions: 9,
      }),
    ];
    const { store, deps, connection } = await harness({ analyticsRows: rows });

    const outcome = await runGscIngest(deps, FIXTURE_WINDOW);
    assert.equal(outcome.status, "COMPLETED");
    assert.equal(outcome.rowCount, 2);
    assert.equal(outcome.error, null);
    assert.equal(outcome.window.startDate, FIXTURE_WINDOW.startDate);
    assert.equal(outcome.freshness.totalRows, 2);
    assert.equal(outcome.freshness.latestMetricDate, "2026-09-16");

    const job = await store.getJob(ORG, outcome.jobId);
    assert.ok(job, "the job row must exist");
    assert.equal(job.status, "COMPLETED");
    assert.equal(job.rowCount, 2);
    assert.ok(job.completedAt, "completion is timestamped");
    const refreshed = await store.getConnection(ORG, connection.id);
    assert.ok(refreshed?.lastSyncAt, "connection freshness advances on completion");
  });

  void it("reuses ONE job per (connection, window) — retries cannot double-count", async () => {
    const { store, deps } = await harness({
      analyticsRows: [metricRow({ date: "2026-09-15" })],
    });

    const first = await runGscIngest(deps, FIXTURE_WINDOW);
    const second = await runGscIngest(deps, FIXTURE_WINDOW);
    assert.equal(first.jobId, second.jobId, "the same window re-arms the same job row");
    assert.equal((await store.listJobs(ORG, PROJECT)).length, 1);
    assert.equal(
      store.jobs.get(first.jobId)?.idempotencyKey,
      `${FIXTURE_WINDOW.startDate}:${FIXTURE_WINDOW.endDate}`,
      "the idempotency key is derived from the window itself",
    );
    assert.equal(store.metrics.length, 1, "window replacement, not accumulation");
  });

  void it("atomically replaces a window (Google revises PRELIMINARY data)", async () => {
    const { store, deps } = await harness({
      analyticsRows: [
        metricRow({ date: "2026-09-15", clicks: 4, impressions: 40 }),
        metricRow({ date: "2026-09-16", query: "gone", page: "https://example.com/gone" }),
      ],
    });
    await runGscIngest(deps, FIXTURE_WINDOW);

    // The revision: same window, corrected numbers, one row withdrawn.
    const revisedTransport = new FakeGoogleTransport({
      analyticsRows: [metricRow({ date: "2026-09-15", clicks: 7, impressions: 40 })],
    });
    await runGscIngest({ ...deps, transport: revisedTransport }, FIXTURE_WINDOW);
    assert.equal(store.metrics.length, 1, "the withdrawn row must not survive the re-sync");
    assert.equal(store.metrics[0]?.clicks, 7, "revised values overwrite stale ones");
  });

  void it("caps collection at maxRows so one job cannot exhaust memory", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      metricRow({ date: `2026-09-1${i}`, query: `q${i}`, page: `https://example.com/p${i}` }),
    );
    const { deps } = await harness({ analyticsRows: rows }, { rowLimit: 2, maxRows: 3 });
    const outcome = await runGscIngest(deps, FIXTURE_WINDOW);
    assert.equal(outcome.status, "COMPLETED");
    assert.equal(outcome.rowCount, 3);
  });
});

void describe("GSC-005 ingestion — pagination and honest aggregation", () => {
  void it("walks every page and merges drifted duplicates impression-weighted", async () => {
    const duplicated: GscMetricRow[] = [
      metricRow({ date: "2026-09-10", query: "a", clicks: 1, impressions: 10, position: 4 }),
      metricRow({ date: "2026-09-11", query: "b", clicks: 2, impressions: 8, position: 2 }),
      // Same dimension key as the row above — pagination drift while Google
      // re-aggregates. Merged: 5 clicks / 20 impressions, weighted position.
      metricRow({ date: "2026-09-11", query: "b", clicks: 3, impressions: 12, position: 5 }),
      metricRow({ date: "2026-09-12", query: "c", clicks: 0, impressions: 4, position: 9 }),
    ];
    const { store, transport, deps } = await harness(
      { analyticsRows: duplicated },
      { rowLimit: 2 },
    );

    const outcome = await runGscIngest(deps, FIXTURE_WINDOW);
    assert.equal(outcome.status, "COMPLETED");
    assert.equal(transport.analyticsRequests.length, 3, "page 1, page 2, and the empty terminator");
    assert.deepEqual(
      transport.analyticsRequests.map((r) => r.startRow),
      [0, 2, 4],
    );
    assert.deepEqual(
      transport.analyticsRequests[0]?.dimensions,
      ["date", "query", "page", "country", "device"],
      "every persisted dimension is fetched",
    );
    assert.equal(outcome.rowCount, 3, "four source rows, three dimension keys");

    const merged = store.metrics.find((m) => m.query === "b");
    assert.ok(merged);
    assert.equal(merged.clicks, 5);
    assert.equal(merged.impressions, 20);
    assert.equal(merged.ctr, 5 / 20, "CTR is re-derived, never averaged");
    assert.equal(merged.position, (2 * 8 + 5 * 12) / 20, "position is impression-weighted");
  });

  void it("keeps zero-impression rows finite (no NaN anywhere)", () => {
    const merged = aggregateMetricRows([
      metricRow({ date: "2026-09-10", clicks: 0, impressions: 0, ctr: 0, position: 0 }),
    ]);
    assert.equal(merged.length, 1);
    const first = merged[0];
    assert.ok(first);
    assert.equal(first.ctr, 0);
    assert.equal(first.position, 0);
  });
});

void describe("GSC-005 ingestion — credentials, retries and quota", () => {
  void it("reports CREDENTIALS_REQUIRED and invents nothing when no grant exists", async () => {
    const { store, deps } = await harness();
    store.credentials.clear();

    const outcome = await runGscIngest(deps, FIXTURE_WINDOW);
    assert.equal(outcome.status, "CREDENTIALS_REQUIRED");
    const failure = outcome.error;
    assert.ok(failure);
    assert.equal(failure.code, "CREDENTIALS_REQUIRED");
    assert.equal(failure.retryable, false);
    assert.equal(outcome.nextRetryAt, null);
    assert.equal(outcome.rowCount, 0);
    assert.equal(store.metrics.length, 0, "an empty input yields an empty output — never a fixture");
    assert.equal(store.persistCalls.length, 0, "nothing is persisted without data");
    const job = await store.getJob(ORG, outcome.jobId);
    assert.equal(job?.status, "CREDENTIALS_REQUIRED");
  });

  void it("retries classified-transient failures with exponential backoff, then succeeds", async () => {
    const rateLimited = (): GscApiError =>
      new GscApiError("RATE_LIMITED", "429", { retryable: true, status: 429 });
    const { store, sleeps, deps, connection } = await harness(
      {
        queryErrors: [rateLimited(), rateLimited()],
        analyticsRows: [metricRow({ date: "2026-09-15" })],
      },
      { maxAttempts: 3 },
    );

    const outcome = await runGscIngest(deps, FIXTURE_WINDOW);
    assert.equal(outcome.status, "COMPLETED");
    assert.equal(outcome.attempt, 3);
    assert.deepEqual(
      sleeps,
      [RETRY_BASE_DELAY_MS, RETRY_BASE_DELAY_MS * 2],
      "waits between attempts, doubling each time",
    );
    const job = await store.getJob(ORG, outcome.jobId);
    assert.equal(job?.status, "COMPLETED");
    assert.ok(
      (await store.getConnection(ORG, connection.id))?.lastSyncAt,
      "a successful retry still advances freshness",
    );
  });

  void it("gives up after maxAttempts and schedules the next attempt (FAILED, retryable)", async () => {
    const rateLimited = (): GscApiError =>
      new GscApiError("RATE_LIMITED", "429", { retryable: true, status: 429 });
    const { sleeps, deps } = await harness(
      { queryErrors: [rateLimited(), rateLimited()] },
      { maxAttempts: 2 },
    );

    const outcome = await runGscIngest(deps, FIXTURE_WINDOW);
    assert.equal(outcome.status, "FAILED");
    const failure = outcome.error;
    assert.ok(failure);
    assert.equal(failure.retryable, true);
    assert.equal(outcome.attempt, 2);
    assert.deepEqual(sleeps, [RETRY_BASE_DELAY_MS], "one wait between the two attempts");
    const retryAt = outcome.nextRetryAt;
    assert.ok(retryAt, "a retryable failure schedules the next attempt");
    assert.ok(Date.parse(retryAt) > NOW, "the retry lands in the future");
    assert.equal(
      Date.parse(retryAt),
      NOW + backoffMs(3, rateLimited()),
      "the scheduled retry follows the same exponential schedule",
    );
  });

  void it("does not retry non-retryable failures and schedules nothing", async () => {
    const badRequest = (): GscApiError =>
      new GscApiError("INVALID_ARGUMENT", "bad window", { retryable: false, status: 400 });
    const { store, sleeps, deps } = await harness({ queryErrors: [badRequest()] });

    const outcome = await runGscIngest(deps, FIXTURE_WINDOW);
    assert.equal(outcome.status, "FAILED");
    const failure = outcome.error;
    assert.ok(failure);
    assert.equal(failure.code, "INVALID_ARGUMENT");
    assert.equal(failure.retryable, false);
    assert.equal(outcome.nextRetryAt, null);
    assert.equal(outcome.attempt, 1, "a deterministic failure is not hammered");
    assert.deepEqual(sleeps, []);
    assert.equal(store.persistCalls.length, 0);
  });

  void it("treats every impossible row class as a protocol violation before persistence", async () => {
    for (const bad of [
      metricRow({ date: "2026-08-01" }), // outside the requested window
      metricRow({ date: "2026-09-15", clicks: -1 }), // negative count
      metricRow({ date: "2026-09-15", ctr: 1.5 }), // impossible CTR
      metricRow({ date: "2026-09-15", position: Number.NaN }), // non-finite
      metricRow({ date: "2026-09-15", impressions: Number.POSITIVE_INFINITY }), // non-finite
    ]) {
      const { store, deps } = await harness({ analyticsRows: [bad] });
      const outcome = await runGscIngest(deps, FIXTURE_WINDOW);
      assert.equal(outcome.status, "FAILED", JSON.stringify(bad));
      const failure = outcome.error;
      assert.ok(failure);
      assert.equal(failure.code, "INVALID_ARGUMENT");
      assert.equal(failure.retryable, false);
      assert.equal(store.persistCalls.length, 0, "invalid rows never reach persistence");
      assert.equal(store.metrics.length, 0);
    }
  });

  void it("cools quota exhaustion down harder than an ordinary transient error", () => {
    const quota = new GscApiError("QUOTA_EXCEEDED", "quota", { retryable: true, status: 403 });
    const transient = new GscApiError("RATE_LIMITED", "429", { retryable: true, status: 429 });
    assert.equal(backoffMs(1, quota), RETRY_BASE_DELAY_MS * QUOTA_BACKOFF_MULTIPLIER);
    assert.equal(backoffMs(1, transient), RETRY_BASE_DELAY_MS);
    assert.equal(backoffMs(3, transient), RETRY_BASE_DELAY_MS * 4, "exponential in the attempt");
    assert.ok(backoffMs(3, quota) > backoffMs(3, transient));
  });

  void it("classifies which stored jobs may be retried", () => {
    const past = new Date(NOW - 1_000).toISOString();
    const future = new Date(NOW + 60_000).toISOString();
    assert.equal(canRetryJob({ status: "PENDING", nextRetryAt: null }, NOW), true);
    assert.equal(canRetryJob({ status: "FAILED", nextRetryAt: past }, NOW), true);
    assert.equal(canRetryJob({ status: "FAILED", nextRetryAt: null }, NOW), true);
    assert.equal(canRetryJob({ status: "FAILED", nextRetryAt: future }, NOW), false);
    assert.equal(canRetryJob({ status: "RUNNING", nextRetryAt: null }, NOW), false);
    assert.equal(canRetryJob({ status: "COMPLETED", nextRetryAt: null }, NOW), false);
    assert.equal(canRetryJob({ status: "CREDENTIALS_REQUIRED", nextRetryAt: null }, NOW), false);
  });
});

void describe("incremental synchronization windows", () => {
  void it("first sync: a bounded lookback ending yesterday (today is never complete)", () => {
    const window = deriveIncrementalWindow(null, "2026-10-04", 28);
    assert.deepEqual(window, { startDate: "2026-09-06", endDate: "2026-10-03" });
  });

  void it("later syncs re-cover Google's revision window from the last sync", () => {
    const window = deriveIncrementalWindow("2026-10-01", "2026-10-04");
    assert.equal(GSC_REVISION_DAYS, 3);
    assert.deepEqual(window, { startDate: "2026-09-28", endDate: "2026-10-03" });
  });

  void it("clamps to the lookback floor and never emits a future or inverted window", () => {
    // An ancient lastSync must not drag the window past the lookback floor…
    assert.deepEqual(deriveIncrementalWindow("2026-09-07", "2026-10-04", 28), {
      startDate: "2026-09-06",
      endDate: "2026-10-03",
    });
    // …and a future lastSync collapses to a single day instead of inverting.
    assert.deepEqual(deriveIncrementalWindow("2026-10-08", "2026-10-04"), {
      startDate: "2026-10-03",
      endDate: "2026-10-03",
    });
    // A malformed marker falls back to first-sync behaviour.
    assert.deepEqual(deriveIncrementalWindow("not-a-date", "2026-10-04", 28), {
      startDate: "2026-09-06",
      endDate: "2026-10-03",
    });
  });
});
