// GSC live routes — real Fastify + real PostgreSQL/RLS, scripted Google wire.
//
// CLAIM: the complete OAuth → discovery → association → ingestion → disconnect
// lifecycle works through the production routes against production storage,
// with (1) state/PKCE/single-use enforced, (2) tokens stored only as envelope
// ciphertext and never serialised, (3) tenant checks on every path, and
// (4) BLOCKED responses — never fabricated metrics — when the deployment has
// no Google client or no credential.
// GSC-004/GSC-005 against GOOGLE ITSELF remain BLOCKED until real credentials
// are supplied; the wire double exercises the identical code paths here.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Response } from "light-my-request";
import { buildApp } from "./server.ts";
import { withAdmin } from "@serpvera/db";
import { decryptSecret, deriveGscKey, encryptSecret } from "./integrations/gsc/crypto.ts";
import { hashState } from "./integrations/gsc/oauth.ts";
import { deriveIncrementalWindow } from "./integrations/gsc/ingest.ts";
import { invalidGrantError } from "./integrations/gsc/test-doubles.ts";
import { FakeGoogleTransport, metricRow } from "./integrations/gsc/test-doubles.ts";

const TAG = `gsclive${process.pid}`;
const PW = "gsc-live-pw-123";
const CLIENT_ID = "fixture-client-id";
const CLIENT_CS = "cs-value-42"; // test-only pairing value
const REDIRECT = "http://127.0.0.1:3000/api/integrations/gsc/callback";
const ACCESS_TOKEN = "ya29.fixture-access-token";
const REFRESH_TOKEN = "1//fixture-refresh-token";
const ID_TOKEN = `h.${Buffer.from(JSON.stringify({ sub: "google-sub-9" })).toString("base64url")}.s`;

const WINDOW = { startDate: "2026-09-01", endDate: "2026-09-30" };

function sessionOf(res: Response): string {
  const header = res.headers["set-cookie"];
  const raw = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
  return /serpvera_session=([^;]+)/.exec(raw ?? "")?.[1] ?? "";
}

/** Fail loudly if any Google token material ever reaches a response body. */
function assertNoLeak(body: string): void {
  for (const token of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_CS]) {
    assert.ok(!body.includes(token), `response leaked token material: ${token.slice(0, 6)}…`);
  }
}

void describe("GSC live routes (real PostgreSQL, scripted Google wire)", () => {
  let app: FastifyInstance;
  const transport = new FakeGoogleTransport();
  const ctx: {
    orgA?: string;
    orgB?: string;
    projectA?: string;
    cookieA?: string;
    cookieB?: string;
    connectionId?: string;
    jobId?: string;
  } = {};

  function inject(
    method: "GET" | "POST" | "DELETE",
    url: string,
    cookie?: string,
    payload?: unknown,
  ): Promise<Response> {
    return app.inject({
      method,
      url,
      ...(cookie ? { headers: { cookie: `serpvera_session=${cookie}` } } : {}),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  }

  async function tenant(tag: "a" | "b"): Promise<{ organizationId: string; cookie: string }> {
    const suffix = randomUUID().slice(0, 8);
    const reg = await inject("POST", "/v1/auth/register", undefined, {
      email: `${tag}${TAG}${suffix}@test.local`,
      password: PW,
    });
    assert.equal(reg.statusCode, 201, reg.body);
    const baseCookie = sessionOf(reg);
    const org = await inject("POST", "/v1/organizations", baseCookie, {
      name: `GSC Org ${TAG} ${tag}`,
      slug: `gsc-${TAG}-${tag}-${suffix}`,
    });
    assert.equal(org.statusCode, 201, org.body);
    const organizationId = (JSON.parse(org.body) as { organization: { id: string } }).organization
      .id;
    const selected = await inject("POST", "/v1/auth/select-organization", baseCookie, {
      organizationId,
    });
    assert.equal(selected.statusCode, 200, selected.body);
    return { organizationId, cookie: sessionOf(selected) };
  }

  /** Run a full authorize and return the issued state + challenge. */
  async function authorize(): Promise<{ state: string; codeChallenge: string }> {
    assert.ok(ctx.cookieA && ctx.projectA);
    const res = await inject("POST", "/v1/gsc/oauth/authorize", ctx.cookieA, {
      projectId: ctx.projectA,
    });
    assert.equal(res.statusCode, 200, res.body);
    assertNoLeak(res.body);
    const url = new URL((JSON.parse(res.body) as { authorizeUrl: string }).authorizeUrl);
    const state = url.searchParams.get("state") ?? "";
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    assert.ok(state.length > 0 && codeChallenge.length > 0);
    return { state, codeChallenge };
  }

  async function connect(property = "sc-domain:example.com"): Promise<string> {
    assert.ok(ctx.cookieA && ctx.projectA);
    const res = await inject("POST", `/v1/projects/${ctx.projectA}/gsc/connections`, ctx.cookieA, {
      externalProperty: property,
    });
    assert.equal(res.statusCode, 201, res.body);
    assertNoLeak(res.body);
    return (JSON.parse(res.body) as { connection: { id: string } }).connection.id;
  }

  before(async () => {
    process.env.GSC_CLIENT_ID = CLIENT_ID;
    process.env.GSC_CLIENT_SECRET = CLIENT_CS;
    process.env.GSC_REDIRECT_URI = REDIRECT;
    transport.script.tokenResponse = {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      tokenId: ID_TOKEN,
    };
    transport.script.sites = [
      { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
      { siteUrl: "https://example.com/blog/", permissionLevel: "siteFullUser" },
    ];
    app = await buildApp({ driver: "postgres", maxPool: 6, gscTransport: transport });
    await app.ready();
    const a = await tenant("a");
    const b = await tenant("b");
    ctx.orgA = a.organizationId;
    ctx.cookieA = a.cookie;
    ctx.orgB = b.organizationId;
    ctx.cookieB = b.cookie;
    const project = await inject("POST", "/v1/projects", a.cookie, {
      organizationId: a.organizationId,
      name: "GSC Live Fixture",
      primaryDomain: "example.com",
    });
    assert.equal(project.statusCode, 201, project.body);
    ctx.projectA = (JSON.parse(project.body) as { project: { id: string } }).project.id;
  });

  after(async () => {
    await withAdmin(async (client) => {
      await client.query(`DELETE FROM organizations WHERE name LIKE $1`, [`GSC Org ${TAG}%`]);
      await client.query(`DELETE FROM users WHERE email LIKE $1`, [`%${TAG}%@test.local`]);
    });
    await app.close();
  });

  // ─── GSC-001: authorization and callback security ───

  void it("authorize returns a PKCE consent URL and persists single-use state", async () => {
    const { state, codeChallenge } = await authorize();
    const url = (
      await inject("POST", "/v1/gsc/oauth/authorize", ctx.cookieA, { projectId: ctx.projectA })
    ).body;
    assertNoLeak(url);

    const stored = await withAdmin(async (c) => {
      const res = await c.query<{ used_at: Date | null; code_verifier: string; expires_at: Date }>(
        `SELECT used_at, code_verifier, expires_at FROM gsc_oauth_states WHERE state_hash = $1`,
        [hashState(state)],
      );
      return res.rows[0] ?? null;
    });
    assert.ok(stored, "the state hash is server-held before any callback");
    assert.equal(stored.used_at, null);
    assert.ok(stored.code_verifier.length >= 43, "the PKCE verifier never leaves the server");
    assert.ok(!url.includes(stored.code_verifier));
    assert.ok(codeChallenge.length >= 43);
  });

  void it("callback exchanges the code and stores ONLY envelope ciphertext", async () => {
    const { state } = await authorize();
    const res = await inject("GET", `/v1/gsc/oauth/callback?code=auth-code-1&state=${state}`);
    assert.equal(res.statusCode, 200, res.body);
    assertNoLeak(res.body);
    const body = JSON.parse(res.body) as {
      status: string;
      projectId: string;
      credentialRef: string;
    };
    assert.equal(body.status, "connected");
    assert.equal(body.projectId, ctx.projectA);

    const row = await withAdmin(async (c) => {
      const res2 = await c.query<{
        encrypted_refresh_token: string;
        encrypted_access_token: string;
        google_subject: string | null;
      }>(
        `SELECT encrypted_refresh_token, encrypted_access_token, google_subject
           FROM gsc_project_credentials WHERE project_id = $1`,
        [ctx.projectA],
      );
      return res2.rows[0] ?? null;
    });
    assert.ok(row);
    assert.ok(!row.encrypted_refresh_token.includes(REFRESH_TOKEN), "ciphertext at rest");
    assert.ok(!row.encrypted_access_token.includes(ACCESS_TOKEN), "ciphertext at rest");
    const key = deriveGscKey(process.env.GSC_TOKEN_KEY ?? process.env.AUTH_SECRET ?? "");
    assert.equal(decryptSecret(row.encrypted_refresh_token, key), REFRESH_TOKEN);
    assert.equal(decryptSecret(row.encrypted_access_token, key), ACCESS_TOKEN);
    assert.equal(row.google_subject, "google-sub-9", "the stable Google subject, never an email");
  });

  void it("rejects replayed and tampered states with byte-identical answers (no oracle)", async () => {
    const { state } = await authorize();
    const ok = await inject("GET", `/v1/gsc/oauth/callback?code=c2&state=${state}`);
    assert.equal(ok.statusCode, 200, ok.body);

    const replay = await inject("GET", `/v1/gsc/oauth/callback?code=c2&state=${state}`);
    assert.equal(replay.statusCode, 400);
    assert.equal(
      (JSON.parse(replay.body) as { error: { code: string } }).error.code,
      "INVALID_STATE",
    );

    const tampered = await inject(
      "GET",
      `/v1/gsc/oauth/callback?code=c2&state=${state.slice(0, -2)}xy`,
    );
    assert.equal(tampered.statusCode, 400);
    assert.equal(
      (JSON.parse(tampered.body) as { error: { code: string } }).error.code,
      "INVALID_STATE",
    );
    // Indistinguishability over the WHOLE observable response, not just code +
    // status: unknown, replayed and tampered must not be told apart.
    assert.equal(replay.body, tampered.body, "full response bodies must be identical");

    // A user denial is answered distinctly, on a FRESH state.
    const fresh = await authorize();
    const denied = await inject(
      "GET",
      `/v1/gsc/oauth/callback?error=access_denied&state=${fresh.state}`,
    );
    assert.equal(denied.statusCode, 400);
    assert.equal(
      (JSON.parse(denied.body) as { error: { code: string } }).error.code,
      "GSC_ACCESS_DENIED",
      "the user's own denial is reported as such — not blamed on the state",
    );
  });

  void it("requires a session to start the flow at all", async () => {
    const res = await inject("POST", "/v1/gsc/oauth/authorize", undefined, {
      projectId: ctx.projectA,
    });
    assert.equal(res.statusCode, 401);
  });

  void it("refuses an expired state at the real database boundary", async () => {
    const { state } = await authorize();
    await withAdmin(async (c) => {
      await c.query(
        `UPDATE gsc_oauth_states SET expires_at = now() - interval '1 minute' WHERE state_hash = $1`,
        [hashState(state)],
      );
    });
    const res = await inject("GET", `/v1/gsc/oauth/callback?code=c3&state=${state}`);
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(
      (JSON.parse(res.body) as { error: { code: string } }).error.code,
      "INVALID_STATE",
      "expiry is enforced by the database claim, not only by test doubles",
    );
  });

  // ─── GSC-004 (adapter): property discovery and association ───

  void it("discovers properties from the live grant shape and associates one with the project", async () => {
    const sites = await inject("GET", `/v1/projects/${ctx.projectA}/gsc/sites`, ctx.cookieA);
    assert.equal(sites.statusCode, 200, sites.body);
    assert.deepEqual(
      (JSON.parse(sites.body) as { sites: unknown[] }).sites,
      transport.script.sites,
    );

    ctx.connectionId = await connect();

    const unlisted = await inject(
      "POST",
      `/v1/projects/${ctx.projectA}/gsc/connections`,
      ctx.cookieA,
      { externalProperty: "https://someone-else.example.org/" },
    );
    assert.equal(unlisted.statusCode, 400);
    assert.equal(
      (JSON.parse(unlisted.body) as { error: { code: string } }).error.code,
      "GSC_PROPERTY_NOT_AUTHORIZED",
      "a property the grant does not list can never be attached",
    );

    const duplicate = await inject(
      "POST",
      `/v1/projects/${ctx.projectA}/gsc/connections`,
      ctx.cookieA,
      { externalProperty: "sc-domain:example.com" },
    );
    assert.equal(duplicate.statusCode, 409);
    assert.equal(
      (JSON.parse(duplicate.body) as { error: { code: string } }).error.code,
      "GSC_ALREADY_CONNECTED",
    );
  });

  void it("reports an empty discovery list honestly when the grant lists nothing", async () => {
    const saved = transport.script.sites;
    transport.script.sites = [];
    try {
      const res = await inject("GET", `/v1/projects/${ctx.projectA}/gsc/sites`, ctx.cookieA);
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(
        (JSON.parse(res.body) as { sites: unknown[] }).sites,
        [],
        "no properties means an empty list — never an invented one",
      );
    } finally {
      transport.script.sites = saved;
    }
  });

  // ─── GSC-005 (adapter): ingestion through the real persistence path ───

  void it("ingests measured rows end-to-end and serves them with freshness", async () => {
    assert.ok(ctx.connectionId && ctx.projectA && ctx.cookieA);
    const unsynced = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/gsc/summary?startDate=${WINDOW.startDate}&endDate=${WINDOW.endDate}`,
      ctx.cookieA,
    );
    assert.equal(unsynced.statusCode, 200, unsynced.body);
    const unsyncedData = JSON.parse(unsynced.body) as {
      syncCoverage: string;
      totals: unknown;
      series: unknown[];
    };
    assert.equal(unsyncedData.syncCoverage, "INCOMPLETE");
    assert.equal(unsyncedData.totals, null, "incomplete windows have no measured totals");
    assert.deepEqual(unsyncedData.series, [], "incomplete windows expose no partial series");

    const unsyncedBreakdown = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/gsc/breakdown?startDate=${WINDOW.startDate}&endDate=${WINDOW.endDate}&dimension=query`,
      ctx.cookieA,
    );
    assert.equal(unsyncedBreakdown.statusCode, 200, unsyncedBreakdown.body);
    const incompleteBreakdown = JSON.parse(unsyncedBreakdown.body) as {
      syncCoverage: string;
      rows: unknown[];
      sourceRows: number;
    };
    assert.equal(incompleteBreakdown.syncCoverage, "INCOMPLETE");
    assert.deepEqual(incompleteBreakdown.rows, [], "incomplete windows expose no query rows");
    assert.equal(incompleteBreakdown.sourceRows, 0);

    transport.script.analyticsRows = [
      metricRow({
        date: "2026-09-15",
        query: "evidence seo",
        page: "https://example.com/evidence",
        clicks: 4,
        impressions: 40,
        position: 4,
      }),
      metricRow({
        date: "2026-09-16",
        query: "second q",
        page: "https://example.com/second",
        clicks: 1,
        impressions: 9,
        position: 8,
      }),
    ];
    const partialWindow = { startDate: "2026-09-15", endDate: "2026-09-16" };
    const partialSync = await inject("POST", `/v1/projects/${ctx.projectA}/gsc/sync`, ctx.cookieA, {
      connectionId: ctx.connectionId,
      ...partialWindow,
    });
    assert.equal(partialSync.statusCode, 200, partialSync.body);
    const partialSummary = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/gsc/summary?startDate=${WINDOW.startDate}&endDate=${WINDOW.endDate}`,
      ctx.cookieA,
    );
    const partialData = JSON.parse(partialSummary.body) as {
      syncCoverage: string;
      totals: unknown;
      series: unknown[];
    };
    assert.equal(partialData.syncCoverage, "INCOMPLETE");
    assert.equal(partialData.totals, null, "a verified subset cannot become full-window totals");
    assert.deepEqual(
      partialData.series,
      [],
      "a verified subset cannot become a full-window series",
    );

    const partialBreakdown = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/gsc/breakdown?startDate=${WINDOW.startDate}&endDate=${WINDOW.endDate}&dimension=query`,
      ctx.cookieA,
    );
    const partialGroups = JSON.parse(partialBreakdown.body) as {
      syncCoverage: string;
      rows: unknown[];
    };
    assert.equal(partialGroups.syncCoverage, "INCOMPLETE");
    assert.deepEqual(partialGroups.rows, [], "partial query groups are not exposed");

    const sync = await inject("POST", `/v1/projects/${ctx.projectA}/gsc/sync`, ctx.cookieA, {
      connectionId: ctx.connectionId,
      ...WINDOW,
    });
    assert.equal(sync.statusCode, 200, sync.body);
    assertNoLeak(sync.body);
    const outcome = (
      JSON.parse(sync.body) as {
        outcome: {
          status: string;
          rowCount: number;
          jobId: string;
          freshness: { totalRows: number };
        };
      }
    ).outcome;
    assert.equal(outcome.status, "COMPLETED");
    ctx.jobId = outcome.jobId;
    assert.equal(outcome.rowCount, 2);
    assert.equal(outcome.freshness.totalRows, 2);

    const summary = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/gsc/summary?startDate=${WINDOW.startDate}&endDate=${WINDOW.endDate}`,
      ctx.cookieA,
    );
    assert.equal(summary.statusCode, 200, summary.body);
    const data = JSON.parse(summary.body) as {
      totals: { clicks: number; impressions: number; ctr: number; days: number } | null;
      series: { date: string }[];
      freshness: { latestMetricDate: string | null; totalRows: number };
      syncCoverage: string;
    };
    assert.ok(data.totals);
    assert.deepEqual(data.totals, {
      clicks: 5,
      impressions: 49,
      ctr: 5 / 49,
      position: (4 * 40 + 8 * 9) / 49,
      days: 2,
    });
    assert.equal(data.freshness.latestMetricDate, "2026-09-16");
    assert.equal(data.syncCoverage, "SYNCED");

    const breakdown = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/gsc/breakdown?startDate=${WINDOW.startDate}&endDate=${WINDOW.endDate}&dimension=query`,
      ctx.cookieA,
    );
    assert.equal(breakdown.statusCode, 200, breakdown.body);
    const breakdownData = JSON.parse(breakdown.body) as {
      syncCoverage: string;
      rows: { key: string; impressions: number }[];
    };
    assert.equal(breakdownData.syncCoverage, "SYNCED");
    const groups = breakdownData.rows;
    assert.deepEqual(groups.map((g) => g.key).sort(), ["evidence seo", "second q"]);
  });

  void it("does not present a legacy completed job as current coverage or measurement", async () => {
    assert.ok(ctx.jobId && ctx.projectA && ctx.cookieA);
    const rawConnection = await withAdmin(async (c) => {
      await c.query(`UPDATE gsc_sync_jobs SET ingestion_version = 0 WHERE id = $1`, [ctx.jobId]);
      const result = await c.query<{ rawLastSyncAt: Date | null; trustedLastSyncAt: Date | null }>(
        `SELECT c.last_sync_at AS "rawLastSyncAt",
                (SELECT max(j.completed_at)
                   FROM gsc_sync_jobs j
                  WHERE j.connection_id = c.id
                    AND j.status = 'COMPLETED'
                    AND j.ingestion_version >= 1) AS "trustedLastSyncAt"
           FROM gsc_connections c
          WHERE c.id = $1`,
        [ctx.connectionId],
      );
      return result.rows[0] ?? null;
    });
    assert.ok(rawConnection?.rawLastSyncAt, "connection retains its raw historical timestamp");
    assert.ok(rawConnection.trustedLastSyncAt, "the preceding partial window remains trusted");
    assert.notEqual(
      rawConnection.rawLastSyncAt.toISOString(),
      rawConnection.trustedLastSyncAt.toISOString(),
      "the latest raw timestamp belongs to the legacy attempt, not the trusted partial one",
    );

    const summary = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/gsc/summary?startDate=${WINDOW.startDate}&endDate=${WINDOW.endDate}`,
      ctx.cookieA,
    );
    assert.equal(summary.statusCode, 200, summary.body);
    const data = JSON.parse(summary.body) as {
      totals: { clicks: number } | null;
      series: unknown[];
      freshness: { totalRows: number; lastSyncAt: string | null };
      syncCoverage: string;
    };
    assert.equal(data.totals, null, "an unverified window does not return partial totals");
    assert.deepEqual(data.series, [], "unverified historical rows are withheld");
    assert.equal(data.freshness.totalRows, 0, "legacy rows do not contribute to freshness");
    assert.equal(
      data.freshness.lastSyncAt,
      rawConnection.trustedLastSyncAt.toISOString(),
      "only the preceding trusted partial-window attempt contributes to freshness",
    );
    assert.equal(data.syncCoverage, "INCOMPLETE", "a fresh current-version sync is required");

    const jobs = await inject("GET", `/v1/projects/${ctx.projectA}/gsc/jobs`, ctx.cookieA);
    const connections = (JSON.parse(jobs.body) as { connections: { lastSyncAt: string | null }[] })
      .connections;
    assert.equal(connections[0]?.lastSyncAt, rawConnection.trustedLastSyncAt.toISOString());
  });

  void it("re-sync creates a new completed attempt and replaces, never doubles", async () => {
    assert.ok(ctx.connectionId && ctx.projectA && ctx.cookieA);
    transport.script.analyticsRows = [
      metricRow({
        date: "2026-09-15",
        query: "evidence seo",
        page: "https://example.com/evidence",
        clicks: 7,
        impressions: 40,
      }),
    ];
    const sync = await inject("POST", `/v1/projects/${ctx.projectA}/gsc/sync`, ctx.cookieA, {
      connectionId: ctx.connectionId,
      ...WINDOW,
    });
    assert.equal(sync.statusCode, 200, sync.body);
    const outcome = (JSON.parse(sync.body) as { outcome: { jobId: string; rowCount: number } })
      .outcome;
    assert.equal(outcome.rowCount, 1);

    const jobs = await inject("GET", `/v1/projects/${ctx.projectA}/gsc/jobs`, ctx.cookieA);
    const jobList = JSON.parse(jobs.body) as {
      jobs: { id: string; status: string; rowCount: number }[];
      connections: { externalProperty: string; lastSyncAt: string | null }[];
    };
    assert.equal(
      jobList.jobs.length,
      3,
      "partial, legacy, and replacement attempts stay in history",
    );
    const firstJob = jobList.jobs[0];
    assert.ok(firstJob);
    assert.equal(firstJob.id, outcome.jobId);
    assert.equal(firstJob.status, "COMPLETED");
    assert.equal(
      jobList.jobs.filter((job) => job.status === "COMPLETED").length,
      3,
      "partial, legacy, and replacement attempts remain auditable",
    );
    const firstConnection = jobList.connections[0];
    assert.ok(firstConnection?.lastSyncAt, "freshness metadata is exposed");

    const summary = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/gsc/summary?startDate=${WINDOW.startDate}&endDate=${WINDOW.endDate}`,
      ctx.cookieA,
    );
    const data = JSON.parse(summary.body) as {
      totals: { clicks: number } | null;
      freshness: { totalRows: number };
    };
    assert.equal(data.totals?.clicks, 7, "revised values replace stale ones");
    assert.equal(data.freshness.totalRows, 1, "the withdrawn row is gone");
  });

  void it("incremental sync (no dates) derives its window from the last sync", async () => {
    assert.ok(ctx.connectionId && ctx.projectA && ctx.cookieA);
    await withAdmin(async (c) => {
      await c.query(`UPDATE gsc_sync_jobs SET ingestion_version = 0 WHERE connection_id = $1`, [
        ctx.connectionId,
      ]);
    });

    const unverifiedConnections = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/gsc/jobs`,
      ctx.cookieA,
    );
    const unverifiedLastSync = (
      JSON.parse(unverifiedConnections.body) as { connections: { lastSyncAt: string | null }[] }
    ).connections[0]?.lastSyncAt;
    assert.equal(unverifiedLastSync, null, "legacy jobs cannot set the next incremental window");

    transport.script.analyticsRows = [];
    const sync = await inject("POST", `/v1/projects/${ctx.projectA}/gsc/sync`, ctx.cookieA, {
      connectionId: ctx.connectionId,
    });
    assert.equal(sync.statusCode, 200, sync.body);
    const outcome = (
      JSON.parse(sync.body) as {
        outcome: { status: string; window: { startDate: string; endDate: string } };
      }
    ).outcome;
    assert.equal(outcome.status, "COMPLETED");

    const jobs = await inject("GET", `/v1/projects/${ctx.projectA}/gsc/jobs`, ctx.cookieA);
    const connections = (JSON.parse(jobs.body) as { connections: { lastSyncAt: string | null }[] })
      .connections;
    const lastSync = connections[0]?.lastSyncAt?.slice(0, 10) ?? null;
    const today = new Date().toISOString().slice(0, 10);
    assert.deepEqual(outcome.window, deriveIncrementalWindow(null, today));
    assert.ok(lastSync, "a new verified collection restores the trusted sync date");
    assert.equal(outcome.window.endDate < today, true, "today's incomplete data is never claimed");
  });

  void it("rejects malformed windows before any job exists", async () => {
    assert.ok(ctx.connectionId && ctx.cookieA && ctx.projectA);
    for (const body of [
      { connectionId: ctx.connectionId, startDate: "2026-09-30", endDate: "2026-09-01" },
      { connectionId: ctx.connectionId, startDate: "2030-01-01", endDate: "2030-01-05" },
      { connectionId: ctx.connectionId, startDate: "2020-01-01", endDate: "2026-01-01" },
      { connectionId: ctx.connectionId, startDate: "2026-09-01" },
    ]) {
      const res = await inject("POST", `/v1/projects/${ctx.projectA}/gsc/sync`, ctx.cookieA, body);
      assert.ok(
        res.statusCode === 400,
        `expected 400 for ${JSON.stringify(body)}, got ${res.statusCode}`,
      );
    }
  });

  void it("refreshes an expired access token transparently and stores the rotation encrypted", async () => {
    assert.ok(ctx.connectionId && ctx.cookieA && ctx.projectA && ctx.orgA);
    const key = deriveGscKey(process.env.GSC_TOKEN_KEY ?? process.env.AUTH_SECRET ?? "");
    await app.stores.gsc?.updateCredentialTokens({
      organizationId: ctx.orgA,
      projectId: ctx.projectA,
      encryptedAccessToken: encryptSecret("ya29.stale-access", key),
      accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    transport.script.refreshTokenResponse = {
      accessToken: "ya29.rotated-live",
      refreshToken: "1//rotated-live",
    };

    const sync = await inject("POST", `/v1/projects/${ctx.projectA}/gsc/sync`, ctx.cookieA, {
      connectionId: ctx.connectionId,
      ...WINDOW,
    });
    assert.equal(sync.statusCode, 200, sync.body);
    assertNoLeak(sync.body);
    assert.deepEqual(
      transport.refreshTokensUsed,
      [REFRESH_TOKEN],
      "the refresh used the decrypted grant",
    );

    const row = await withAdmin(async (c) => {
      const res = await c.query<{
        encrypted_access_token: string;
        encrypted_refresh_token: string;
      }>(
        `SELECT encrypted_access_token, encrypted_refresh_token FROM gsc_project_credentials WHERE project_id = $1`,
        [ctx.projectA],
      );
      return res.rows[0];
    });
    assert.ok(row);
    assert.equal(decryptSecret(row.encrypted_access_token, key), "ya29.rotated-live");
    assert.equal(decryptSecret(row.encrypted_refresh_token, key), "1//rotated-live");
  });

  void it("reports CREDENTIALS_REQUIRED at route level when the grant was revoked", async () => {
    assert.ok(ctx.connectionId && ctx.cookieA && ctx.projectA && ctx.orgA);
    const key = deriveGscKey(process.env.GSC_TOKEN_KEY ?? process.env.AUTH_SECRET ?? "");
    await app.stores.gsc?.updateCredentialTokens({
      organizationId: ctx.orgA,
      projectId: ctx.projectA,
      encryptedAccessToken: encryptSecret("ya29.rotated-live", key),
      accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    transport.script.refreshErrors = [invalidGrantError()];
    try {
      const sync = await inject("POST", `/v1/projects/${ctx.projectA}/gsc/sync`, ctx.cookieA, {
        connectionId: ctx.connectionId,
        ...WINDOW,
      });
      assert.equal(sync.statusCode, 200, sync.body);
      const outcome = (
        JSON.parse(sync.body) as {
          outcome: { status: string; error: { code: string; retryable: boolean } | null };
        }
      ).outcome;
      assert.equal(outcome.status, "CREDENTIALS_REQUIRED");
      assert.equal(outcome.error?.code ?? "CREDENTIALS_REQUIRED", "CREDENTIALS_REQUIRED");
    } finally {
      transport.script.refreshErrors = [];
    }
  });

  // ─── GSC-003: tenant isolation at the HTTP boundary ───

  void it("returns uniform 404s to a foreign tenant on every GSC surface", async () => {
    assert.ok(ctx.projectA && ctx.cookieB && ctx.connectionId);
    type Attempt = ["GET" | "POST" | "DELETE", string, unknown?];
    const attempts: Attempt[] = [
      ["GET", `/v1/projects/${ctx.projectA}/gsc/sites`],
      ["GET", `/v1/projects/${ctx.projectA}/gsc/jobs`],
      [
        "GET",
        `/v1/projects/${ctx.projectA}/gsc/summary?startDate=${WINDOW.startDate}&endDate=${WINDOW.endDate}`,
      ],
      [
        "GET",
        `/v1/projects/${ctx.projectA}/gsc/breakdown?startDate=${WINDOW.startDate}&endDate=${WINDOW.endDate}&dimension=query`,
      ],
      [
        "GET",
        `/v1/projects/${ctx.projectA}/gsc/intelligence?startDate=${WINDOW.startDate}&endDate=${WINDOW.endDate}`,
      ],
      [
        "POST",
        `/v1/projects/${ctx.projectA}/gsc/connections`,
        { externalProperty: "sc-domain:example.com" },
      ],
      [
        "POST",
        `/v1/projects/${ctx.projectA}/gsc/sync`,
        { connectionId: ctx.connectionId, ...WINDOW },
      ],
      [
        "POST",
        `/v1/projects/${ctx.projectA}/gsc/findings`,
        {
          module: "high_impressions_low_ctr",
          subject: { query: "q", page: "https://example.com/p" },
          title: "Cross-tenant probe",
          rationale: "probe",
          datasetWindow: { startDate: WINDOW.startDate, endDate: WINDOW.endDate },
          filters: { minImpressions: 500, maxCtr: 0.02 },
          observed: { impressions: 600, clicks: 6, ctr: 0.01, position: 4, days: 1 },
          evidenceClass: "MEASURED",
          verificationGate: {
            type: "gsc_window",
            spec: {
              metric: "ctr",
              operator: "gte",
              threshold: 0.02,
              minImpressions: 500,
              windowDays: 30,
            },
          },
          severity: "low",
        },
      ],
      ["DELETE", `/v1/gsc/connections/${ctx.connectionId}`],
      ["POST", `/v1/gsc/oauth/authorize`, { projectId: ctx.projectA }],
    ];
    for (const [method, url, payload] of attempts) {
      const res = await inject(method, url, ctx.cookieB, payload);
      assert.equal(res.statusCode, 404, `${method} ${url} → ${res.statusCode}: ${res.body}`);
      assert.equal(
        (JSON.parse(res.body) as { error: { code: string } }).error.code,
        "NOT_FOUND",
        `${method} ${url} must not leak what exists`,
      );
    }

    // The state-changing retry surface gets a REAL tenant-A job id — a
    // tenancy-blind handler would answer something other than 404 here —
    // and a foreign id must be byte-indistinguishable from an absent one.
    assert.ok(ctx.jobId, "a real job id must exist for the cross-tenant retry probe");
    const foreignJob = await inject("POST", `/v1/gsc/jobs/${ctx.jobId}/retry`, ctx.cookieB, {});
    const absentJob = await inject("POST", `/v1/gsc/jobs/${randomUUID()}/retry`, ctx.cookieB, {});
    assert.equal(foreignJob.statusCode, 404, foreignJob.body);
    assert.equal(absentJob.statusCode, 404, absentJob.body);
    assert.equal(
      foreignJob.body,
      absentJob.body,
      "foreign and absent job ids must be indistinguishable",
    );

    // And the data tenant B CAN see is exactly its own (empty) footprint.
    const foreignSummary = await app.stores.gsc?.metricFreshness(
      ctx.orgB ?? "",
      ctx.projectA ?? "",
    );
    assert.deepEqual(foreignSummary, { latestMetricDate: null, lastSyncAt: null, totalRows: 0 });
  });

  // ─── Disconnect / revocation ───

  void it("disconnect revokes both tokens at Google and erases local material", async () => {
    assert.ok(ctx.connectionId && ctx.cookieA && ctx.projectA);
    transport.revokedTokens.length = 0;
    const res = await inject("DELETE", `/v1/gsc/connections/${ctx.connectionId}`, ctx.cookieA);
    assert.equal(res.statusCode, 200, res.body);
    assertNoLeak(res.body);
    assert.deepEqual(
      transport.revokedTokens.sort(),
      ["1//rotated-live", "ya29.rotated-live"].sort(),
      "both CURRENT grants (post-rotation) are revoked at Google",
    );

    const state = await withAdmin(async (c) => {
      const creds = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM gsc_project_credentials WHERE project_id = $1`,
        [ctx.projectA],
      );
      const conn = await c.query<{ status: string }>(
        `SELECT status FROM gsc_connections WHERE id = $1`,
        [ctx.connectionId],
      );
      const credentials = creds.rows[0];
      const connection = conn.rows[0];
      assert.ok(credentials && connection);
      return { credentials, status: connection.status };
    });
    assert.deepEqual(state, { credentials: { n: 0 }, status: "DISCONNECTED" });

    // A disconnected connection cannot be synced.
    const sync = await inject("POST", `/v1/projects/${ctx.projectA}/gsc/sync`, ctx.cookieA, {
      connectionId: ctx.connectionId,
      ...WINDOW,
    });
    assert.equal(sync.statusCode, 404);
  });

  void it("reconnects a disconnected property (revives the UNIQUE slot) and still refuses active duplicates", async () => {
    assert.ok(ctx.projectA && ctx.cookieA);
    // Disconnect erased the grant; a fresh OAuth round restores it exactly as a
    // real re-authorization would.
    const { state } = await authorize();
    const cb = await inject("GET", `/v1/gsc/oauth/callback?code=reconnect-1&state=${state}`);
    assert.equal(cb.statusCode, 200, cb.body);

    const reconnect = await inject(
      "POST",
      `/v1/projects/${ctx.projectA}/gsc/connections`,
      ctx.cookieA,
      { externalProperty: "sc-domain:example.com" },
    );
    assert.equal(reconnect.statusCode, 201, reconnect.body);
    const revived = (JSON.parse(reconnect.body) as { connection: { id: string; status: string } })
      .connection;
    assert.equal(revived.status, "CONNECTED");
    assert.equal(revived.id, ctx.connectionId, "the same row is revived, not shadowed");

    const duplicate = await inject(
      "POST",
      `/v1/projects/${ctx.projectA}/gsc/connections`,
      ctx.cookieA,
      { externalProperty: "sc-domain:example.com" },
    );
    assert.equal(duplicate.statusCode, 409);
    assert.equal(
      (JSON.parse(duplicate.body) as { error: { code: string } }).error.code,
      "GSC_ALREADY_CONNECTED",
    );
  });

  void it("checks the current grant and fails closed on an additional active property", async () => {
    assert.ok(ctx.cookieA && ctx.projectA && ctx.orgA);
    // Two disjoint listings, answered per presented token: a property listed
    // for another grant must not attach, and the current grant's must.
    transport.script.sitesByToken = {
      "ya29.grant-a": [{ siteUrl: "sc-domain:grant-a.example", permissionLevel: "siteOwner" }],
      "ya29.grant-b": [{ siteUrl: "sc-domain:grant-b.example", permissionLevel: "siteOwner" }],
    };
    const key = deriveGscKey(process.env.GSC_TOKEN_KEY ?? process.env.AUTH_SECRET ?? "");
    await app.stores.gsc?.updateCredentialTokens({
      organizationId: ctx.orgA,
      projectId: ctx.projectA,
      encryptedAccessToken: encryptSecret("ya29.grant-b", key),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    try {
      const foreign = await inject(
        "POST",
        `/v1/projects/${ctx.projectA}/gsc/connections`,
        ctx.cookieA,
        { externalProperty: "sc-domain:grant-a.example" },
      );
      assert.equal(foreign.statusCode, 400, foreign.body);
      assert.equal(
        (JSON.parse(foreign.body) as { error: { code: string } }).error.code,
        "GSC_PROPERTY_NOT_AUTHORIZED",
        "a property listed for ANOTHER grant is not listed for THIS one",
      );

      const own = await inject(
        "POST",
        `/v1/projects/${ctx.projectA}/gsc/connections`,
        ctx.cookieA,
        { externalProperty: "sc-domain:grant-b.example" },
      );
      assert.equal(own.statusCode, 409, own.body);
      assert.equal(
        (JSON.parse(own.body) as { error: { code: string } }).error.code,
        "GSC_PROPERTY_CONFLICT",
        "an authorized property cannot replace the already active project property silently",
      );
    } finally {
      delete transport.script.sitesByToken;
      await app.stores.gsc?.updateCredentialTokens({
        organizationId: ctx.orgA,
        projectId: ctx.projectA,
        encryptedAccessToken: encryptSecret("ya29.rotated-live", key),
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
  });

  void it("refuses to associate a property when no grant is stored", async () => {
    assert.ok(ctx.projectA && ctx.cookieA && ctx.orgA);
    const removed = await app.stores.gsc?.deleteCredential(ctx.orgA, ctx.projectA);
    assert.equal(removed, true);
    const res = await inject("POST", `/v1/projects/${ctx.projectA}/gsc/connections`, ctx.cookieA, {
      externalProperty: "https://example.com/blog/",
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(
      (JSON.parse(res.body) as { error: { code: string } }).error.code,
      "GSC_NOT_CONNECTED",
    );
  });
});

void describe("GSC BLOCKED surfaces — explicit, never fabricated", () => {
  void it("without Google client configuration the API answers GSC_NOT_CONFIGURED", async () => {
    const savedId = process.env.GSC_CLIENT_ID;
    const savedCs = process.env.GSC_CLIENT_SECRET;
    const savedUri = process.env.GSC_REDIRECT_URI;
    delete process.env.GSC_CLIENT_ID;
    delete process.env.GSC_CLIENT_SECRET;
    delete process.env.GSC_REDIRECT_URI;
    const app = await buildApp({
      driver: "postgres",
      maxPool: 2,
      gscTransport: new FakeGoogleTransport(),
    });
    try {
      await app.ready();
      const res = await app.inject({
        method: "GET",
        url: `/v1/gsc/oauth/callback?code=x&state=${Buffer.from(
          "11111111-1111-4111-8111-111111111111",
        ).toString("base64url")}.abc`,
      });
      assert.equal(res.statusCode, 503);
      assert.equal(
        (JSON.parse(res.body) as { error: { code: string } }).error.code,
        "GSC_NOT_CONFIGURED",
      );
    } finally {
      await app.close();
      if (savedId) process.env.GSC_CLIENT_ID = savedId;
      if (savedCs) process.env.GSC_CLIENT_SECRET = savedCs;
      if (savedUri) process.env.GSC_REDIRECT_URI = savedUri;
    }
  });

  void it("without the PostgreSQL store the API answers GSC_STORE_UNAVAILABLE", async () => {
    const app = await buildApp({ driver: "memory", gscTransport: new FakeGoogleTransport() });
    try {
      await app.ready();
      const res = await app.inject({
        method: "GET",
        url: `/v1/gsc/oauth/callback?code=x&state=${Buffer.from(
          "11111111-1111-4111-8111-111111111111",
        ).toString("base64url")}.abc`,
      });
      assert.equal(res.statusCode, 501);
      assert.equal(
        (JSON.parse(res.body) as { error: { code: string } }).error.code,
        "GSC_STORE_UNAVAILABLE",
      );
    } finally {
      await app.close();
    }
  });
});
