// ─── GSC DATABASE-LEVEL TENANT ISOLATION (GSC-003) ───
// Real PostgreSQL, real RLS: every cross-tenant query runs as the runtime role
// `serpvera_app` (NOSUPERUSER, NOBYPASSRLS) inside withTenant(), so results are
// decided by the PostgreSQL policy engine — not by application WHERE clauses.
//
// Also proves the real GSC persistence semantics: single-use OAuth state,
// idempotent job reuse, atomic window replacement (including the empty
// re-sync), and the freshness/series read paths.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  closePool,
  configurePool,
  consumeOauthState,
  createConnection,
  createOauthState,
  createOrReuseJob,
  claimJob,
  createProject,
  createUser,
  deleteCredential,
  getJob,
  loadMetricRows,
  GscMeasurementWindowTooLargeError,
  GscSyncAttemptLostError,
  metricFreshness,
  metricSeries,
  persistMetricWindow,
  updateJob,
  upsertCredential,
  withAdmin,
  withTenant,
} from "./index.ts";

const TAG = `gscrls${process.pid}`;
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STATE_HASH_A = `hash-${TAG}-a`;
const TOMORROW_ISO = new Date(Date.now() + 86_400_000).toISOString();

const ctx: {
  projectA: string;
  projectB: string;
  connectionA: string;
  jobA: string;
  jobRetry: string;
  jobRetryAttempt: number;
} = {
  projectA: "",
  projectB: "",
  connectionA: "",
  jobA: "",
  jobRetry: "",
  jobRetryAttempt: 0,
};

void describe("GSC-003 tenant isolation on GSC tables (real PostgreSQL RLS)", () => {
  before(async () => {
    configurePool({
      host: process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
      database: process.env.PGDATABASE ?? "serpvera_dev",
      runtimeRole: "serpvera_app",
      maxPool: 4,
    });

    // Deterministic tenant ids so raw cross-tenant SQL is testable; admin
    // bootstrap mirrors what the API does at registration time.
    const userA = await createUser(`a_${TAG}@test.local`, "hash-a");
    const userB = await createUser(`b_${TAG}@test.local`, "hash-b");
    await withAdmin(async (c) => {
      await c.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG_A, ORG_B]]);
      await c.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`, [
        ORG_A,
        `GSC Alpha ${TAG}`,
        `gsc-alpha-${TAG}`,
      ]);
      await c.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`, [
        ORG_B,
        `GSC Beta ${TAG}`,
        `gsc-beta-${TAG}`,
      ]);
      await c.query(
        `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'OWNER'), ($3, $4, 'OWNER')`,
        [ORG_A, userA.id, ORG_B, userB.id],
      );
    });
    const projA = await createProject(ORG_A, "GSC Alpha Site", "alpha.example.com");
    const projB = await createProject(ORG_B, "GSC Beta Site", "beta.example.com");
    ctx.projectA = projA.id;
    ctx.projectB = projB.id;

    // Seed tenant A's full GSC footprint through the production functions.
    await createOauthState({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      stateHash: STATE_HASH_A,
      codeVerifier: `verifier-${TAG}`,
      expiresAt: TOMORROW_ISO,
    });
    const credentialId = await upsertCredential({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      encryptedRefreshToken: "ct-refresh-a",
      encryptedAccessToken: "ct-access-a",
      accessTokenExpiresAt: TOMORROW_ISO,
      scope: "webmasters.readonly",
      googleSubject: `sub-${TAG}`,
    });
    const connection = await createConnection({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      externalProperty: "sc-domain:alpha.example.com",
      credentialRef: credentialId,
    });
    ctx.connectionA = connection.id;
    const job = await createOrReuseJob({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      connectionId: connection.id,
      windowStart: "2026-09-01",
      windowEnd: "2026-09-30",
      idempotencyKey: "2026-09-01:2026-09-30",
    });
    ctx.jobA = job.id;
    const expectedAttempt = await claimJob(ORG_A, job.id, new Date().toISOString());
    assert.equal(expectedAttempt, 1);
    await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: job.id,
      expectedAttempt,
      window: { startDate: "2026-09-01", endDate: "2026-09-30" },
      rows: [
        {
          date: "2026-09-15",
          query: "alpha query",
          page: "https://alpha.example.com/page",
          country: "fra",
          device: "DESKTOP",
          clicks: 4,
          impressions: 40,
          ctr: 0.1,
          position: 3.5,
        },
        {
          date: "2026-09-16",
          query: "alpha mobile",
          page: "https://alpha.example.com/page",
          country: "deu",
          device: "MOBILE",
          clicks: 1,
          impressions: 9,
          ctr: 0.111,
          position: 8,
        },
      ],
    });
    await updateJob(ORG_A, job.id, {
      status: "COMPLETED",
      expectedAttempt,
      completedAt: new Date().toISOString(),
    });
  });

  after(async () => {
    try {
      await withAdmin(async (c) => {
        await c.query(`DELETE FROM users WHERE email LIKE $1`, [`%_${TAG}@test.local`]);
        await c.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG_A, ORG_B]]);
      });
    } finally {
      await closePool();
    }
  });

  void it("POSITIVE CONTROL — tenant A's GSC rows really exist (admin view)", async () => {
    const counts = await withAdmin(async (c) => {
      const res = await c.query<{ t: string; n: number }>(
        `SELECT 'gsc_project_credentials' AS t, count(*)::int AS n
           FROM gsc_project_credentials WHERE organization_id = $1
         UNION ALL
         SELECT 'gsc_oauth_states', count(*)::int FROM gsc_oauth_states WHERE organization_id = $1
         UNION ALL
         SELECT 'gsc_connections', count(*)::int FROM gsc_connections WHERE organization_id = $1
         UNION ALL
         SELECT 'gsc_sync_jobs', count(*)::int FROM gsc_sync_jobs WHERE organization_id = $1
         UNION ALL
         SELECT 'gsc_query_metrics', count(*)::int FROM gsc_query_metrics WHERE organization_id = $1`,
        [ORG_A],
      );
      return Object.fromEntries(res.rows.map((r) => [r.t, r.n]));
    });
    assert.deepEqual(counts, {
      gsc_project_credentials: 1,
      gsc_oauth_states: 1,
      gsc_connections: 1,
      gsc_sync_jobs: 1,
      gsc_query_metrics: 2,
    });
  });

  void it("tenant B sees ZERO of tenant A's GSC rows on every table (no WHERE clause helps)", async () => {
    const visible = await withTenant(ORG_B, async (c) => {
      const res = await c.query<{ n: number }>(
        `SELECT ((SELECT count(*) FROM gsc_project_credentials) +
                 (SELECT count(*) FROM gsc_oauth_states) +
                 (SELECT count(*) FROM gsc_connections) +
                 (SELECT count(*) FROM gsc_sync_jobs) +
                 (SELECT count(*) FROM gsc_query_metrics))::int AS n`,
      );
      return res.rows[0]?.n ?? -1;
    });
    assert.equal(visible, 0, "RLS must hide every GSC table from a foreign tenant");
  });

  void it("tenant B cannot UPDATE or DELETE tenant A's token material (0 rows)", async () => {
    const result = await withTenant(ORG_B, async (c) => {
      const updated = await c.query(
        `UPDATE gsc_project_credentials SET encrypted_access_token = 'tampered'`,
      );
      const deleted = await c.query(`DELETE FROM gsc_oauth_states`);
      return { updated: updated.rowCount ?? -1, deleted: deleted.rowCount ?? -1 };
    });
    assert.deepEqual(result, { updated: 0, deleted: 0 });
  });

  void it("tenant B cannot INSERT rows stamped with tenant A (WITH CHECK)", async () => {
    await assert.rejects(
      withTenant(ORG_B, async (c) =>
        c.query(
          `INSERT INTO gsc_query_metrics
             (organization_id, project_id, sync_job_id, metric_date, query, page,
              clicks, impressions, ctr, position)
           VALUES ($1, $2, $3, '2026-09-20', 'x', 'https://x.example.com/', 0, 1, 0, 1)`,
          [ORG_A, ctx.projectA, ctx.jobA],
        ),
      ),
      /row-level security|policy/i,
    );
  });

  void it("the store functions refuse to cross tenants even with known foreign ids", async () => {
    const credential = await withTenant(ORG_B, async () =>
      // getJob-style scoped read with a foreign organization id returns null.
      getJob(ORG_B, ctx.jobA),
    );
    assert.equal(credential, null);
    await assert.rejects(
      createOauthState({
        organizationId: ORG_B,
        projectId: ctx.projectA, // tenant A's project
        stateHash: `hash-${TAG}-evil`,
        codeVerifier: "v",
        expiresAt: TOMORROW_ISO,
      }),
      /not found in this organization/i,
    );
  });

  void it("OAuth state is single-use at the database boundary and tenant-scoped", async () => {
    const foreignClaim = await consumeOauthState(ORG_B, STATE_HASH_A);
    assert.equal(foreignClaim, null, "a foreign tenant cannot claim tenant A's state");

    const claimed = await consumeOauthState(ORG_A, STATE_HASH_A);
    assert.deepEqual(claimed, {
      projectId: ctx.projectA,
      codeVerifier: `verifier-${TAG}`,
    });
    const replay = await consumeOauthState(ORG_A, STATE_HASH_A);
    assert.equal(replay, null, "the atomic claim consumed the row");
  });

  void it("an expired state is unclaimable", async () => {
    await createOauthState({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      stateHash: `hash-${TAG}-expired`,
      codeVerifier: "v2",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(await consumeOauthState(ORG_A, `hash-${TAG}-expired`), null);
  });

  void it("reuses an in-flight job and creates a new attempt after a completed window", async () => {
    const again = await createOrReuseJob({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      connectionId: ctx.connectionA,
      windowStart: "2026-09-01",
      windowEnd: "2026-09-30",
      idempotencyKey: "2026-09-01:2026-09-30",
    });
    assert.notEqual(again.id, ctx.jobA, "a completed attempt remains immutable history");
    ctx.jobRetry = again.id;
    const concurrentReplay = await createOrReuseJob({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      connectionId: ctx.connectionA,
      windowStart: "2026-09-01",
      windowEnd: "2026-09-30",
      idempotencyKey: "2026-09-01:2026-09-30",
    });
    assert.equal(concurrentReplay.id, again.id, "retries reuse the active attempt");
    const jobs = await withTenant(ORG_A, async (c) => {
      const res = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM gsc_sync_jobs WHERE project_id = $1`,
        [ctx.projectA],
      );
      return res.rows[0]?.n ?? -1;
    });
    assert.equal(jobs, 2);
  });

  void it("serializes concurrent job claims and rejects stale fencing attempts", async () => {
    const claims = await Promise.all([
      claimJob(ORG_A, ctx.jobRetry, new Date().toISOString()),
      claimJob(ORG_A, ctx.jobRetry, new Date().toISOString()),
    ]);
    const winner = claims.find((attempt): attempt is number => attempt !== null);
    assert.ok(winner, "one request must acquire the pending job");
    assert.equal(claims.filter((attempt) => attempt !== null).length, 1);
    ctx.jobRetryAttempt = winner;

    await assert.rejects(
      persistMetricWindow({
        organizationId: ORG_A,
        projectId: ctx.projectA,
        syncJobId: ctx.jobRetry,
        expectedAttempt: winner - 1,
        window: { startDate: "2026-09-01", endDate: "2026-09-30" },
        rows: [],
      }),
      (error: unknown) => error instanceof GscSyncAttemptLostError,
    );
    assert.equal(
      await updateJob(ORG_A, ctx.jobRetry, {
        status: "FAILED",
        expectedAttempt: winner - 1,
        completedAt: new Date().toISOString(),
      }),
      false,
      "a stale worker cannot demote the current attempt",
    );
    assert.equal((await getJob(ORG_A, ctx.jobRetry))?.status, "RUNNING");
    assert.equal(
      await updateJob(ORG_A, ctx.jobRetry, {
        status: "FAILED",
        expectedAttempt: winner,
        completedAt: new Date().toISOString(),
      }),
      true,
      "the winning worker can finish its current attempt after stale writes are rejected",
    );
  });

  void it("reclaims an expired RUNNING job without exposing its partial rows", async () => {
    const staleJob = await createOrReuseJob({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      connectionId: ctx.connectionA,
      windowStart: "2026-09-01",
      windowEnd: "2026-09-30",
      idempotencyKey: "2026-09-01:2026-09-30",
    });
    const expiredStartedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const staleAttempt = await claimJob(ORG_A, staleJob.id, expiredStartedAt);
    assert.ok(staleAttempt);
    await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: staleJob.id,
      expectedAttempt: staleAttempt,
      window: { startDate: "2026-09-01", endDate: "2026-09-30" },
      rows: [
        {
          date: "2026-09-15",
          query: "abandoned-partial-query",
          page: "https://alpha.example.com/partial",
          country: "fra",
          device: "DESKTOP",
          clicks: 999,
          impressions: 999,
          ctr: 1,
          position: 1,
        },
      ],
    });

    const beforeReclaim = await loadMetricRows(
      ORG_A,
      ctx.projectA,
      { startDate: "2026-09-01", endDate: "2026-09-30" },
      { connectionId: ctx.connectionA },
    );
    assert.equal(beforeReclaim.length, 2, "the previous completed measurements remain readable");

    const reclaimed = await createOrReuseJob({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      connectionId: ctx.connectionA,
      windowStart: "2026-09-01",
      windowEnd: "2026-09-30",
      idempotencyKey: "2026-09-01:2026-09-30",
    });
    assert.equal(reclaimed.id, staleJob.id);
    assert.equal(reclaimed.status, "PENDING");
    const freshAttempt = await claimJob(ORG_A, reclaimed.id, new Date().toISOString());
    if (freshAttempt === null) throw new Error("the expired job must be claimable");
    assert.equal(freshAttempt, staleAttempt + 1, "reclaim increments the fencing attempt");

    await assert.rejects(
      persistMetricWindow({
        organizationId: ORG_A,
        projectId: ctx.projectA,
        syncJobId: staleJob.id,
        expectedAttempt: staleAttempt,
        window: { startDate: "2026-09-01", endDate: "2026-09-30" },
        rows: [],
      }),
      (error: unknown) => error instanceof GscSyncAttemptLostError,
    );
    assert.equal(
      await updateJob(ORG_A, staleJob.id, {
        status: "FAILED",
        expectedAttempt: staleAttempt,
        completedAt: new Date().toISOString(),
      }),
      false,
      "an abandoned worker cannot fail the reclaimed job",
    );

    await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: reclaimed.id,
      expectedAttempt: freshAttempt,
      window: { startDate: "2026-09-01", endDate: "2026-09-30" },
      rows: [
        {
          date: "2026-09-15",
          query: "fresh-query",
          page: "https://alpha.example.com/fresh",
          country: "fra",
          device: "DESKTOP",
          clicks: 2,
          impressions: 20,
          ctr: 0.1,
          position: 2,
        },
      ],
    });
    assert.equal(
      await updateJob(ORG_A, reclaimed.id, {
        status: "COMPLETED",
        expectedAttempt: freshAttempt,
        completedAt: new Date().toISOString(),
      }),
      true,
    );
    const finalRows = await loadMetricRows(
      ORG_A,
      ctx.projectA,
      { startDate: "2026-09-01", endDate: "2026-09-30" },
      { connectionId: ctx.connectionA },
    );
    assert.equal(finalRows.length, 1);
    assert.equal(finalRows[0]?.query, "fresh-query");
  });

  void it("preserves writes from distinct jobs with overlapping windows", async () => {
    const longWindow = await createOrReuseJob({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      connectionId: ctx.connectionA,
      windowStart: "2026-10-15",
      windowEnd: "2026-11-15",
      idempotencyKey: "2026-10-15:2026-11-15",
    });
    const longAttempt = await claimJob(ORG_A, longWindow.id, "2026-10-01T00:00:00.000Z");
    assert.ok(longAttempt);
    await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: longWindow.id,
      expectedAttempt: longAttempt,
      window: { startDate: "2026-10-15", endDate: "2026-11-15" },
      rows: [
        {
          date: "2026-10-20",
          query: "long-window-overlap",
          page: "https://alpha.example.com/long-window",
          country: "fra",
          device: "DESKTOP",
          clicks: 12,
          impressions: 120,
          ctr: 0.1,
          position: 3,
        },
        {
          date: "2026-11-05",
          query: "long-window-tail",
          page: "https://alpha.example.com/long-window",
          country: "fra",
          device: "DESKTOP",
          clicks: 5,
          impressions: 50,
          ctr: 0.1,
          position: 4,
        },
      ],
    });

    const shortWindow = await createOrReuseJob({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      connectionId: ctx.connectionA,
      windowStart: "2026-10-01",
      windowEnd: "2026-10-31",
      idempotencyKey: "2026-10-01:2026-10-31",
    });
    // Simulate a second API instance with a clock that is one day behind.
    // PostgreSQL claim order, rather than the client timestamp, must win.
    const shortAttempt = await claimJob(ORG_A, shortWindow.id, "2026-09-30T00:00:00.000Z");
    assert.ok(shortAttempt);
    await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: shortWindow.id,
      expectedAttempt: shortAttempt,
      window: { startDate: "2026-10-01", endDate: "2026-10-31" },
      rows: [
        {
          date: "2026-10-02",
          query: "short-window-only",
          page: "https://alpha.example.com/short-window",
          country: "fra",
          device: "DESKTOP",
          clicks: 3,
          impressions: 30,
          ctr: 0.1,
          position: 6,
        },
        {
          date: "2026-10-20",
          query: "short-window-overlap",
          page: "https://alpha.example.com/short-window",
          country: "fra",
          device: "DESKTOP",
          clicks: 4,
          impressions: 40,
          ctr: 0.1,
          position: 5,
        },
      ],
    });
    assert.equal(
      await updateJob(ORG_A, shortWindow.id, {
        status: "COMPLETED",
        expectedAttempt: shortAttempt,
        completedAt: new Date().toISOString(),
      }),
      true,
    );

    const beforeLongCompletion = await loadMetricRows(
      ORG_A,
      ctx.projectA,
      { startDate: "2026-10-01", endDate: "2026-11-15" },
      { connectionId: ctx.connectionA },
    );
    assert.deepEqual(
      beforeLongCompletion.map((row) => row.query).sort(),
      ["short-window-only", "short-window-overlap"],
      "the partial long-window job cannot leak into measured reads",
    );

    assert.equal(
      await updateJob(ORG_A, longWindow.id, {
        status: "COMPLETED",
        expectedAttempt: longAttempt,
        completedAt: new Date().toISOString(),
      }),
      true,
    );
    const finalRows = await loadMetricRows(
      ORG_A,
      ctx.projectA,
      { startDate: "2026-10-01", endDate: "2026-11-15" },
      { connectionId: ctx.connectionA },
    );
    assert.deepEqual(
      finalRows.map((row) => row.query).sort(),
      ["long-window-tail", "short-window-only", "short-window-overlap"],
      "the latest-claimed fetch wins its overlap even when an older fetch completes later",
    );

    await withAdmin(async (client) => {
      await client.query("DELETE FROM gsc_query_metrics WHERE sync_job_id = ANY($1::uuid[])", [
        [longWindow.id, shortWindow.id],
      ]);
      await client.query("DELETE FROM gsc_sync_jobs WHERE id = ANY($1::uuid[])", [
        [longWindow.id, shortWindow.id],
      ]);
    });
  });

  void it("lets the newest fetch replace an older completed overlap", async () => {
    const olderWindow = await createOrReuseJob({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      connectionId: ctx.connectionA,
      windowStart: "2026-12-15",
      windowEnd: "2027-01-15",
      idempotencyKey: "2026-12-15:2027-01-15",
    });
    const olderAttempt = await claimJob(ORG_A, olderWindow.id, "2026-11-01T00:00:00.000Z");
    assert.ok(olderAttempt);
    await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: olderWindow.id,
      expectedAttempt: olderAttempt,
      window: { startDate: "2026-12-15", endDate: "2027-01-15" },
      rows: [
        {
          date: "2026-12-20",
          query: "older-window-overlap",
          page: "https://alpha.example.com/older-window",
          country: "fra",
          device: "DESKTOP",
          clicks: 12,
          impressions: 120,
          ctr: 0.1,
          position: 3,
        },
        {
          date: "2027-01-10",
          query: "older-window-tail",
          page: "https://alpha.example.com/older-window",
          country: "fra",
          device: "DESKTOP",
          clicks: 5,
          impressions: 50,
          ctr: 0.1,
          position: 4,
        },
      ],
    });

    const newerWindow = await createOrReuseJob({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      connectionId: ctx.connectionA,
      windowStart: "2026-12-01",
      windowEnd: "2026-12-31",
      idempotencyKey: "2026-12-01:2026-12-31",
    });
    const newerAttempt = await claimJob(ORG_A, newerWindow.id, "2026-11-01T00:00:00.000Z");
    assert.ok(newerAttempt);
    await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: newerWindow.id,
      expectedAttempt: newerAttempt,
      window: { startDate: "2026-12-01", endDate: "2026-12-31" },
      rows: [
        {
          date: "2026-12-05",
          query: "newer-window-only",
          page: "https://alpha.example.com/newer-window",
          country: "fra",
          device: "DESKTOP",
          clicks: 3,
          impressions: 30,
          ctr: 0.1,
          position: 6,
        },
        {
          date: "2026-12-20",
          query: "newer-window-overlap",
          page: "https://alpha.example.com/newer-window",
          country: "fra",
          device: "DESKTOP",
          clicks: 4,
          impressions: 40,
          ctr: 0.1,
          position: 5,
        },
      ],
    });

    assert.equal(
      await updateJob(ORG_A, olderWindow.id, {
        status: "COMPLETED",
        expectedAttempt: olderAttempt,
        completedAt: new Date().toISOString(),
      }),
      true,
    );
    assert.equal(
      await updateJob(ORG_A, newerWindow.id, {
        status: "COMPLETED",
        expectedAttempt: newerAttempt,
        completedAt: new Date().toISOString(),
      }),
      true,
    );

    const rows = await loadMetricRows(
      ORG_A,
      ctx.projectA,
      { startDate: "2026-12-01", endDate: "2027-01-15" },
      { connectionId: ctx.connectionA },
    );
    assert.deepEqual(
      rows.map((row) => row.query).sort(),
      ["newer-window-only", "newer-window-overlap", "older-window-tail"],
      "a later fetch replaces an older completed overlap and retains non-overlapping history",
    );

    await withAdmin(async (client) => {
      await client.query("DELETE FROM gsc_query_metrics WHERE sync_job_id = ANY($1::uuid[])", [
        [olderWindow.id, newerWindow.id],
      ]);
      await client.query("DELETE FROM gsc_sync_jobs WHERE id = ANY($1::uuid[])", [
        [olderWindow.id, newerWindow.id],
      ]);
    });
  });

  void it("window replacement is atomic: revised rows overwrite, empty re-sync erases", async () => {
    const replacement = await createOrReuseJob({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      connectionId: ctx.connectionA,
      windowStart: "2026-09-01",
      windowEnd: "2026-09-30",
      idempotencyKey: "2026-09-01:2026-09-30",
    });
    const expectedAttempt = await claimJob(ORG_A, replacement.id, new Date().toISOString());
    assert.ok(expectedAttempt);
    const replaced = await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: replacement.id,
      expectedAttempt,
      window: { startDate: "2026-09-01", endDate: "2026-09-30" },
      rows: [
        {
          date: "2026-09-15",
          query: "alpha query",
          page: "https://alpha.example.com/page",
          country: "fra",
          device: "DESKTOP",
          clicks: 7,
          impressions: 40,
          ctr: 0.175,
          position: 3.1,
        },
      ],
    });
    assert.equal(replaced, 1);
    assert.equal(
      await updateJob(ORG_A, replacement.id, {
        status: "COMPLETED",
        expectedAttempt,
        completedAt: new Date().toISOString(),
      }),
      true,
    );
    let rows = await loadMetricRows(ORG_A, ctx.projectA, {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    });
    assert.equal(rows.length, 1, "the withdrawn row is gone, not doubled");
    assert.equal(rows[0]?.clicks, 7);

    const emptyReplacement = await createOrReuseJob({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      connectionId: ctx.connectionA,
      windowStart: "2026-09-01",
      windowEnd: "2026-09-30",
      idempotencyKey: "2026-09-01:2026-09-30",
    });
    const emptyAttempt = await claimJob(ORG_A, emptyReplacement.id, new Date().toISOString());
    assert.ok(emptyAttempt);
    const erased = await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: emptyReplacement.id,
      expectedAttempt: emptyAttempt,
      window: { startDate: "2026-09-01", endDate: "2026-09-30" },
      rows: [],
    });
    assert.equal(erased, 0);
    assert.equal(
      await updateJob(ORG_A, emptyReplacement.id, {
        status: "COMPLETED",
        expectedAttempt: emptyAttempt,
        completedAt: new Date().toISOString(),
      }),
      true,
    );
    rows = await loadMetricRows(ORG_A, ctx.projectA, {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    });
    assert.equal(rows.length, 0, "a completed empty fetch erases stale rows for its window");
  });

  void it("read paths filter dimensions and report honest freshness", async () => {
    const completedAttempt = await createOrReuseJob({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      connectionId: ctx.connectionA,
      windowStart: "2026-09-01",
      windowEnd: "2026-09-30",
      idempotencyKey: "2026-09-01:2026-09-30",
    });
    const expectedAttempt = await claimJob(ORG_A, completedAttempt.id, new Date().toISOString());
    assert.ok(expectedAttempt);
    await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: completedAttempt.id,
      expectedAttempt,
      window: { startDate: "2026-09-01", endDate: "2026-09-30" },
      rows: [
        {
          date: "2026-09-15",
          query: "alpha query",
          page: "https://alpha.example.com/page",
          country: "fra",
          device: "DESKTOP",
          clicks: 4,
          impressions: 40,
          ctr: 0.1,
          position: 3.5,
        },
        {
          date: "2026-09-16",
          query: "alpha mobile",
          page: "https://alpha.example.com/page",
          country: "deu",
          device: "MOBILE",
          clicks: 1,
          impressions: 9,
          ctr: 0.111,
          position: 8,
        },
      ],
    });
    assert.equal(
      await updateJob(ORG_A, completedAttempt.id, {
        status: "COMPLETED",
        expectedAttempt,
        completedAt: new Date().toISOString(),
      }),
      true,
    );

    const filtered = await loadMetricRows(
      ORG_A,
      ctx.projectA,
      { startDate: "2026-09-01", endDate: "2026-09-30" },
      { device: "MOBILE" },
    );
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.query, "alpha mobile");

    await assert.rejects(
      loadMetricRows(
        ORG_A,
        ctx.projectA,
        { startDate: "2026-09-01", endDate: "2026-09-30" },
        { connectionId: ctx.connectionA },
        1,
      ),
      (error: unknown) => error instanceof GscMeasurementWindowTooLargeError,
      "an over-limit window must fail explicitly instead of looking complete",
    );

    const series = await metricSeries(ORG_A, ctx.projectA, {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    });
    assert.equal(series.length, 2);
    const day = series.find((p) => p.date === "2026-09-15");
    assert.ok(day, "2026-09-15 must appear in the measured series");
    assert.equal(day.clicks, 4);
    assert.equal(day.ctr, 0.1);
    const freshness = await metricFreshness(ORG_A, ctx.projectA);
    assert.equal(freshness.latestMetricDate, "2026-09-16");
    assert.equal(freshness.totalRows, 2);

    // And a foreign tenant asking the same questions gets honest emptiness.
    const foreign = await metricFreshness(ORG_B, ctx.projectA);
    assert.deepEqual(foreign, { latestMetricDate: null, lastSyncAt: null, totalRows: 0 });
  });

  void it("keeps complete rows visible and excludes partial rows until the new job completes", async () => {
    const partialJob = await createOrReuseJob({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      connectionId: ctx.connectionA,
      windowStart: "2026-09-01",
      windowEnd: "2026-09-30",
      idempotencyKey: "2026-09-01:2026-09-30",
    });
    const expectedAttempt = await claimJob(ORG_A, partialJob.id, new Date().toISOString());
    assert.ok(expectedAttempt);
    await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: partialJob.id,
      expectedAttempt,
      window: { startDate: "2026-09-01", endDate: "2026-09-30" },
      rows: [
        {
          date: "2026-09-15",
          query: "partial-only-query",
          page: "https://alpha.example.com/new",
          country: "fra",
          device: "DESKTOP",
          clicks: 99,
          impressions: 100,
          ctr: 0.99,
          position: 1,
        },
      ],
    });

    const incompleteRows = await loadMetricRows(
      ORG_A,
      ctx.projectA,
      { startDate: "2026-09-01", endDate: "2026-09-30" },
      { query: "partial-only-query", connectionId: ctx.connectionA },
    );
    assert.deepEqual(incompleteRows, [], "a running job cannot create measured rows");
    const priorCompleteRows = await loadMetricRows(
      ORG_A,
      ctx.projectA,
      { startDate: "2026-09-01", endDate: "2026-09-30" },
      { connectionId: ctx.connectionA },
    );
    assert.equal(priorCompleteRows.length, 2, "the last completed window remains available");

    await updateJob(ORG_A, partialJob.id, {
      status: "COMPLETED",
      expectedAttempt,
      completedAt: new Date().toISOString(),
    });
    const completedRows = await loadMetricRows(
      ORG_A,
      ctx.projectA,
      { startDate: "2026-09-01", endDate: "2026-09-30" },
      { connectionId: ctx.connectionA },
    );
    assert.equal(completedRows.length, 1, "completion atomically retires the old window");
    assert.equal(completedRows[0]?.query, "partial-only-query");
    assert.equal(completedRows[0].clicks, 99);
  });

  void it("credential deletion is tenant-scoped (disconnect cannot hit a foreign grant)", async () => {
    const foreignDelete = await deleteCredential(ORG_B, ctx.projectA);
    assert.equal(foreignDelete, false);
    const ownDelete = await deleteCredential(ORG_A, ctx.projectA);
    assert.equal(ownDelete, true);
  });

  void it("stores only opaque ciphertext — no plaintext token column exists", async () => {
    const columns = await withAdmin(async (c) => {
      const res = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'gsc_project_credentials'`,
      );
      return res.rows.map((r) => r.column_name);
    });
    for (const name of columns) {
      // Anything that could hold a token VALUE must be envelope ciphertext.
      // (Timestamps and `token_type` are metadata and exempt.)
      if (/(^|_)access_token$|(^|_)refresh_token$/.test(name)) {
        assert.ok(name.startsWith("encrypted_"), `token column ${name} must be envelope-encrypted`);
      }
    }
    assert.ok(columns.includes("encrypted_refresh_token"));
    assert.ok(columns.includes("encrypted_access_token"));
  });
});
