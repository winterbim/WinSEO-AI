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
  createProject,
  createUser,
  deleteCredential,
  getJob,
  loadMetricRows,
  metricFreshness,
  metricSeries,
  persistMetricWindow,
  upsertCredential,
  withAdmin,
  withTenant,
} from "./index.ts";

const TAG = `gscrls${process.pid}`;
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STATE_HASH_A = `hash-${TAG}-a`;
const TOMORROW_ISO = new Date(Date.now() + 86_400_000).toISOString();

const ctx: { projectA: string; projectB: string; connectionA: string; jobA: string } = {
  projectA: "",
  projectB: "",
  connectionA: "",
  jobA: "",
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
    await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: job.id,
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

  void it("job creation is idempotent per (connection, window) on real constraints", async () => {
    const again = await createOrReuseJob({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      connectionId: ctx.connectionA,
      windowStart: "2026-09-01",
      windowEnd: "2026-09-30",
      idempotencyKey: "2026-09-01:2026-09-30",
    });
    assert.equal(again.id, ctx.jobA, "the UNIQUE index re-arms the same job row");
    const jobs = await withTenant(ORG_A, async (c) => {
      const res = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM gsc_sync_jobs WHERE project_id = $1`,
        [ctx.projectA],
      );
      return res.rows[0]?.n ?? -1;
    });
    assert.equal(jobs, 1);
  });

  void it("window replacement is atomic: revised rows overwrite, empty re-sync erases", async () => {
    const replaced = await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: ctx.jobA,
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
    let rows = await loadMetricRows(ORG_A, ctx.projectA, {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    });
    assert.equal(rows.length, 1, "the withdrawn row is gone, not doubled");
    assert.equal(rows[0]?.clicks, 7);

    const erased = await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: ctx.jobA,
      window: { startDate: "2026-09-01", endDate: "2026-09-30" },
      rows: [],
    });
    assert.equal(erased, 0);
    rows = await loadMetricRows(ORG_A, ctx.projectA, {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    });
    assert.equal(rows.length, 0, "a completed empty fetch erases stale rows for its window");
  });

  void it("read paths filter dimensions and report honest freshness", async () => {
    await persistMetricWindow({
      organizationId: ORG_A,
      projectId: ctx.projectA,
      syncJobId: ctx.jobA,
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

    const filtered = await loadMetricRows(
      ORG_A,
      ctx.projectA,
      { startDate: "2026-09-01", endDate: "2026-09-30" },
      { device: "MOBILE" },
    );
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.query, "alpha mobile");

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
        assert.ok(
          name.startsWith("encrypted_"),
          `token column ${name} must be envelope-encrypted`,
        );
      }
    }
    assert.ok(columns.includes("encrypted_refresh_token"));
    assert.ok(columns.includes("encrypted_access_token"));
  });
});
