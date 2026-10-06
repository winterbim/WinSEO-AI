// GSC-007 — Action Center verification driven by GSC measurements (real
// Fastify + real PostgreSQL/RLS).
//
// CLAIM: the complete loop is executable exactly as the mission defines it:
//   MEASURED finding → recommendation → user approval → modification →
//   waiting window → GSC remeasurement → VERIFIED / REJECTED / INCONCLUSIVE
// The verdict is deterministic SQL arithmetic over persisted gsc_query_metrics
// rows against the APPROVED gate — never an LLM judgement — and a sample too
// small (or a window with no rows) yields INCONCLUSIVE, never a flattering
// PASS. Fixture rows stand in for the Google fetch here (deterministic adapter
// test); against live Google the same rows arrive via GSC-005 once credentials
// exist.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Response } from "light-my-request";
import { buildApp } from "./server.ts";
import { withAdmin } from "@serpvera/db";
import { FakeGoogleTransport, metricRow } from "./integrations/gsc/test-doubles.ts";

const TAG = `gscver${process.pid}`;
const PW = "gsc-verify-pw-123";
const SEPTEMBER = { startDate: "2026-09-01", endDate: "2026-09-30" };
const AUGUST = { startDate: "2026-08-01", endDate: "2026-08-31" };
const MEASUREMENT_WINDOW = {
  startsAt: "2026-09-01T00:00:00.000Z",
  endsAt: "2026-09-30T23:59:59.000Z",
};

interface FindingPayload {
  module: string;
  subject: { query?: string; page?: string };
  title: string;
  rationale: string;
  datasetWindow: { startDate: string; endDate: string };
  filters: Record<string, string | number | boolean>;
  comparisonWindow?: { startDate: string; endDate: string };
  observed: Record<string, number | string>;
  evidenceClass: "MEASURED";
  verificationGate: {
    type: "gsc_window";
    spec: {
      metric: "ctr" | "clicks" | "impressions" | "position";
      operator: "gte" | "lte";
      threshold: number;
      query?: string;
      page?: string;
      minImpressions: number;
      windowDays: number;
    };
  };
  severity: "critical" | "high" | "medium" | "low" | "info";
}

function measuredFinding(subject: {
  query: string;
  page: string;
  module?: string;
  gate: FindingPayload["verificationGate"]["spec"];
}): FindingPayload {
  return {
    module: subject.module ?? "high_impressions_low_ctr",
    subject: { query: subject.query, page: subject.page },
    title: `Measured: ${subject.query}`,
    rationale: "Derived from persisted Search Analytics rows.",
    datasetWindow: SEPTEMBER,
    filters: { minImpressions: subject.gate.minImpressions, maxCtr: 0.02 },
    comparisonWindow: AUGUST,
    observed: { impressions: 49, clicks: 5, ctr: 0.102041, position: 4.734694, days: 2 },
    evidenceClass: "MEASURED",
    verificationGate: { type: "gsc_window", spec: subject.gate },
    severity: "medium",
  };
}

function sessionOf(res: Response): string {
  const header = res.headers["set-cookie"];
  const raw = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
  return /serpvera_session=([^;]+)/.exec(raw ?? "")?.[1] ?? "";
}

void describe("GSC-007 Action Center verification via GSC measurements (real PostgreSQL)", () => {
  let app: FastifyInstance;
  const ctx: {
    orgA?: string;
    projectA?: string;
    cookieA?: string;
    cookieB?: string;
    verified?: string;
    rejected?: string;
    inconclusiveSample?: string;
    inconclusiveNoData?: string;
    control?: string;
  } = {};

  function inject(
    method: "GET" | "POST",
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
      name: `GSC Verify ${TAG} ${tag}`,
      slug: `gscver-${TAG}-${tag}-${suffix}`,
    });
    assert.equal(org.statusCode, 201, org.body);
    const organizationId = (JSON.parse(org.body) as { organization: { id: string } }).organization.id;
    const selected = await inject("POST", "/v1/auth/select-organization", baseCookie, {
      organizationId,
    });
    return { organizationId, cookie: sessionOf(selected) };
  }

  /** Promote a MEASURED recommendation → finding + evidence + DETECTED action. */
  async function createFinding(payload: FindingPayload): Promise<{
    actionId: string;
    findingId: string;
    evidenceId?: string;
    contentHash?: string;
    created: boolean;
    epistemicClass?: string;
    verificationGate?: string;
  }> {
    const res = await inject(
      "POST",
      `/v1/projects/${ctx.projectA}/gsc/findings`,
      ctx.cookieA,
      payload,
    );
    assert.ok(res.statusCode === 201 || res.statusCode === 200, res.body);
    return JSON.parse(res.body) as {
      actionId: string;
      findingId: string;
      evidenceId?: string;
      contentHash?: string;
      created: boolean;
      epistemicClass?: string;
      verificationGate?: string;
    };
  }

  function transition(
    actionId: string,
    expectedVersion: number,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return inject("POST", `/v1/actions/${actionId}/transitions`, ctx.cookieA, {
      expectedVersion,
      ...body,
    });
  }

  /** Walk finding → … → MEASURING so EVALUATE has a waiting window recorded. */
  async function walkToMeasuring(actionId: string, gate: FindingPayload["verificationGate"]): Promise<void> {
    let v = 1;
    for (const step of [
      { toState: "EVIDENCED" },
      {
        toState: "PROPOSED",
        recommendation: {
          summary: "Apply the measured change.",
          rationale: "The MEASURED finding shows the gap.",
          verificationGate: gate,
        },
      },
      { toState: "APPROVED", approvalDecision: "APPROVE" },
      {
        toState: "REPORTED_MANUALLY",
        implementation: { whatChanged: "Title and snippet rewritten.", how: "Release 7." },
        rollback: { strategy: "Revert release 7.", trigger: "Gate fails." },
      },
      {
        toState: "MEASURING",
        baselineSnapshot: { source: "gsc_query_metrics", window: AUGUST },
        comparisonWindow: MEASUREMENT_WINDOW,
      },
    ]) {
      const res = await transition(actionId, v, step);
      assert.equal(res.statusCode, 200, `${step.toState}: ${res.body}`);
      v += 1;
    }
  }

  before(async () => {
    process.env.GSC_CLIENT_ID = "fixture-client-id";
    process.env.GSC_CLIENT_SECRET = "cs-value-42";
    process.env.GSC_REDIRECT_URI = "http://127.0.0.1:3000/api/integrations/gsc/callback";
    app = await buildApp({
      driver: "postgres",
      maxPool: 6,
      gscTransport: new FakeGoogleTransport(),
    });
    await app.ready();
    const a = await tenant("a");
    const b = await tenant("b");
    ctx.orgA = a.organizationId;
    ctx.cookieA = a.cookie;
    ctx.cookieB = b.cookie;
    const project = await inject("POST", "/v1/projects", a.cookie, {
      organizationId: a.organizationId,
      name: "GSC Verification Fixture",
      primaryDomain: "example.com",
    });
    assert.equal(project.statusCode, 201, project.body);
    ctx.projectA = (JSON.parse(project.body) as { project: { id: string } }).project.id;

    // Measured rows exactly as GSC-005 would persist them (deterministic
    // adapter fixtures): a September measurement window and an August baseline.
    const gsc = app.stores.gsc;
    assert.ok(gsc, "GSC-007 requires the PostgreSQL store");
    const connection = await gsc.createConnection({
      organizationId: a.organizationId,
      projectId: ctx.projectA,
      externalProperty: "sc-domain:example.com",
      credentialRef: "cred-fixture",
    });
    const jobSept = await gsc.createOrReuseJob({
      organizationId: a.organizationId,
      projectId: ctx.projectA,
      connectionId: connection.id,
      windowStart: SEPTEMBER.startDate,
      windowEnd: SEPTEMBER.endDate,
      idempotencyKey: `${SEPTEMBER.startDate}:${SEPTEMBER.endDate}`,
    });
    const jobAug = await gsc.createOrReuseJob({
      organizationId: a.organizationId,
      projectId: ctx.projectA,
      connectionId: connection.id,
      windowStart: AUGUST.startDate,
      windowEnd: AUGUST.endDate,
      idempotencyKey: `${AUGUST.startDate}:${AUGUST.endDate}`,
    });
    await gsc.persistMetricWindow({
      organizationId: a.organizationId,
      projectId: ctx.projectA,
      syncJobId: jobSept.id,
      window: SEPTEMBER,
      rows: [
        // ctr 5/49 ≈ 0.1020, weighted position (4·40 + 8·9)/49 ≈ 4.7347
        metricRow({ date: "2026-09-15", query: "verified q", page: "https://example.com/v", clicks: 4, impressions: 40, ctr: 0.1, position: 4 }),
        metricRow({ date: "2026-09-16", query: "verified q", page: "https://example.com/v", clicks: 1, impressions: 9, ctr: 0.111, position: 8 }),
        metricRow({ date: "2026-09-15", query: "rejected q", page: "https://example.com/r", clicks: 4, impressions: 40, ctr: 0.1, position: 4 }),
        metricRow({ date: "2026-09-16", query: "rejected q", page: "https://example.com/r", clicks: 1, impressions: 9, ctr: 0.111, position: 8 }),
        metricRow({ date: "2026-09-15", query: "thin q", page: "https://example.com/t", clicks: 1, impressions: 10, ctr: 0.1, position: 5 }),
      ],
    });
    await gsc.persistMetricWindow({
      organizationId: a.organizationId,
      projectId: ctx.projectA,
      syncJobId: jobAug.id,
      window: AUGUST,
      rows: [
        metricRow({ date: "2026-08-15", query: "verified q", page: "https://example.com/v", clicks: 10, impressions: 100, ctr: 0.1, position: 6 }),
      ],
    });

    ctx.verified = (await createFinding(
      measuredFinding({
        query: "verified q",
        page: "https://example.com/v",
        gate: {
          metric: "ctr",
          operator: "gte",
          threshold: 0.05,
          query: "verified q",
          page: "https://example.com/v",
          minImpressions: 30,
          windowDays: 30,
        },
      }),
    )).actionId;
    ctx.rejected = (await createFinding(
      measuredFinding({
        query: "rejected q",
        page: "https://example.com/r",
        module: "ranking_opportunity",
        gate: {
          metric: "position",
          operator: "lte",
          threshold: 2,
          query: "rejected q",
          page: "https://example.com/r",
          minImpressions: 30,
          windowDays: 30,
        },
      }),
    )).actionId;
    ctx.inconclusiveSample = (await createFinding(
      measuredFinding({
        query: "thin q",
        page: "https://example.com/t",
        module: "emerging_queries",
        gate: {
          metric: "ctr",
          operator: "gte",
          threshold: 0.05,
          query: "thin q",
          page: "https://example.com/t",
          minImpressions: 1_000,
          windowDays: 30,
        },
      }),
    )).actionId;
    ctx.inconclusiveNoData = (await createFinding(
      measuredFinding({
        query: "absent q",
        page: "https://example.com/absent",
        module: "winners_losers",
        gate: {
          metric: "impressions",
          operator: "gte",
          threshold: 1,
          query: "absent q",
          page: "https://example.com/absent",
          minImpressions: 0,
          windowDays: 30,
        },
      }),
    )).actionId;
  });

  after(async () => {
    await withAdmin(async (client) => {
      await client.query(`DELETE FROM organizations WHERE name LIKE $1`, [
        `GSC Verify ${TAG}%`,
      ]);
      await client.query(`DELETE FROM users WHERE email LIKE $1`, [`%${TAG}%@test.local`]);
    });
    await app.close();
  });

  void it("promotes a MEASURED recommendation into finding + evidence + DETECTED action", async () => {
    const first = await createFinding(
      measuredFinding({
        query: "dup q",
        page: "https://example.com/d",
        gate: {
          metric: "ctr",
          operator: "gte",
          threshold: 0.05,
          query: "dup q",
          page: "https://example.com/d",
          minImpressions: 30,
          windowDays: 30,
        },
      }),
    );
    assert.equal(first.created, true);
    assert.equal(first.epistemicClass, "MEASURED");
    assert.equal(first.verificationGate, "gsc_window");
    assert.equal(
      first.contentHash,
      createHash("sha256")
        .update(
          JSON.stringify({
            module: "high_impressions_low_ctr",
            subject: { query: "dup q", page: "https://example.com/d" },
            datasetWindow: SEPTEMBER,
            filters: { minImpressions: 30, maxCtr: 0.02 },
            comparisonWindow: AUGUST,
            observed: { impressions: 49, clicks: 5, ctr: 0.102041, position: 4.734694, days: 2 },
            evidenceClass: "MEASURED",
            verificationGate: {
              type: "gsc_window",
              spec: {
                metric: "ctr",
                operator: "gte",
                threshold: 0.05,
                query: "dup q",
                page: "https://example.com/d",
                minImpressions: 30,
                windowDays: 30,
              },
            },
          }),
        )
        .digest("hex"),
      "the evidence hash is reproducible from the measured claim",
    );

    // Re-running the intelligence modules must NOT spawn duplicate workflows.
    const duplicate = await createFinding(
      measuredFinding({
        query: "dup q",
        page: "https://example.com/d",
        gate: {
          metric: "ctr",
          operator: "gte",
          threshold: 0.05,
          query: "dup q",
          page: "https://example.com/d",
          minImpressions: 30,
          windowDays: 30,
        },
      }),
    );
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.findingId, first.findingId);
  });

  void it("VERIFIED: approval → modification → waiting window → measured gate passes", async () => {
    assert.ok(ctx.verified);
    const gate: FindingPayload["verificationGate"] = {
      type: "gsc_window",
      spec: {
        metric: "ctr",
        operator: "gte",
        threshold: 0.05,
        query: "verified q",
        page: "https://example.com/v",
        minImpressions: 30,
        windowDays: 30,
      },
    };
    await walkToMeasuring(ctx.verified, gate);

    const evaluated = await transition(ctx.verified, 6, { toState: "EVALUATE" });
    assert.equal(evaluated.statusCode, 200, evaluated.body);
    const action = (JSON.parse(evaluated.body) as {
      action: {
        state: string;
        verification: {
          verdict: string;
          comparedValue: number;
          observed: Record<string, number>;
          window: { startDate: string; endDate: string };
          source: string;
        };
        history: unknown[];
      };
    }).action;
    assert.equal(action.state, "VERIFIED");
    assert.equal(action.verification.verdict, "PASS");
    assert.equal(action.verification.source, "gsc_query_metrics");
    assert.deepEqual(action.verification.window, SEPTEMBER, "the declared window is measured exactly");
    assert.equal(action.verification.observed.impressions, 49);
    assert.equal(action.verification.observed.clicks, 5);
    assert.ok(Math.abs(action.verification.comparedValue - 5 / 49) < 1e-9, "ctr 5/49 ≥ 0.05");
    assert.equal(action.history.length, 6, "every accepted transition is immutable history");
  });

  void it("REJECTED: the same loop with a gate the measurements miss", async () => {
    assert.ok(ctx.rejected);
    await walkToMeasuring(ctx.rejected, {
      type: "gsc_window",
      spec: {
        metric: "position",
        operator: "lte",
        threshold: 2,
        query: "rejected q",
        page: "https://example.com/r",
        minImpressions: 30,
        windowDays: 30,
      },
    });

    const evaluated = await transition(ctx.rejected, 6, { toState: "EVALUATE" });
    assert.equal(evaluated.statusCode, 200, evaluated.body);
    const action = (JSON.parse(evaluated.body) as {
      action: { state: string; verification: { verdict: string; comparedValue: number } };
    }).action;
    assert.equal(action.state, "REJECTED");
    assert.equal(action.verification.verdict, "FAIL");
    assert.ok(
      Math.abs(action.verification.comparedValue - (4 * 40 + 8 * 9) / 49) < 1e-9,
      "position 4.73 ≰ 2 — arithmetic, not judgement",
    );
  });

  void it("INCONCLUSIVE: a sample too small to judge is never a PASS", async () => {
    assert.ok(ctx.inconclusiveSample);
    await walkToMeasuring(ctx.inconclusiveSample, {
      type: "gsc_window",
      spec: {
        metric: "ctr",
        operator: "gte",
        threshold: 0.05,
        query: "thin q",
        page: "https://example.com/t",
        minImpressions: 1_000,
        windowDays: 30,
      },
    });

    const evaluated = await transition(ctx.inconclusiveSample, 6, { toState: "EVALUATE" });
    assert.equal(evaluated.statusCode, 200, evaluated.body);
    const action = (JSON.parse(evaluated.body) as {
      action: { state: string; verification: { verdict: string; reason: string; observed: { impressions: number } } };
    }).action;
    assert.equal(action.state, "INCONCLUSIVE");
    assert.equal(action.verification.verdict, "INCONCLUSIVE");
    assert.equal(action.verification.reason, "insufficient_sample");
    assert.equal(action.verification.observed.impressions, 10);
  });

  void it("INCONCLUSIVE: a window without measured rows says so explicitly", async () => {
    assert.ok(ctx.inconclusiveNoData);
    await walkToMeasuring(ctx.inconclusiveNoData, {
      type: "gsc_window",
      spec: {
        metric: "impressions",
        operator: "gte",
        threshold: 1,
        query: "absent q",
        page: "https://example.com/absent",
        minImpressions: 0,
        windowDays: 30,
      },
    });

    const evaluated = await transition(ctx.inconclusiveNoData, 6, { toState: "EVALUATE" });
    assert.equal(evaluated.statusCode, 200, evaluated.body);
    const action = (JSON.parse(evaluated.body) as {
      action: { state: string; verification: { verdict: string; reason: string } };
    }).action;
    assert.equal(action.state, "INCONCLUSIVE");
    assert.equal(action.verification.reason, "no_gsc_data_in_window");
  });

  void it("refuses to verify before a waiting window is recorded", async () => {
    const finding = await createFinding(
      measuredFinding({
        query: "control q",
        page: "https://example.com/c",
        module: "page_query_intersections",
        gate: {
          metric: "clicks",
          operator: "gte",
          threshold: 10,
          query: "control q",
          page: "https://example.com/c",
          minImpressions: 30,
          windowDays: 30,
        },
      }),
    );
    ctx.control = finding.actionId;
    const early = await transition(ctx.control, 1, { toState: "EVALUATE" });
    assert.equal(early.statusCode, 409);
    assert.equal(
      (JSON.parse(early.body) as { error: { code: string } }).error.code,
      "INVALID_TRANSITION",
    );
    const direct = await transition(ctx.control, 1, { toState: "VERIFIED" });
    assert.equal(direct.statusCode, 409, "verdicts are computed, never declared");
  });

  void it("the Action Center before/after surface shows the measured comparison", async () => {
    assert.ok(ctx.verified && ctx.cookieA);
    const res = await inject("GET", `/v1/gsc/actions/${ctx.verified}/before-after`, ctx.cookieA);
    assert.equal(res.statusCode, 200, res.body);
    const body = (JSON.parse(res.body) as {
      state: string;
      gate: string;
      subject: Record<string, string>;
      baselineWindow: { startDate: string; endDate: string };
      measurementWindow: { startDate: string; endDate: string };
      comparison: {
        delta: Record<string, number>;
        observed: Record<string, number>;
        baseline: Record<string, number>;
        evidenceClass: string;
      } | null;
      verification: { verdict: string };
      freshness: { totalRows: number; latestMetricDate: string | null };
    });
    assert.equal(body.state, "VERIFIED");
    assert.equal(body.gate, "gsc_window");
    assert.deepEqual(body.measurementWindow, SEPTEMBER);
    assert.deepEqual(body.subject, { query: "verified q", page: "https://example.com/v" });
    const rec = body.comparison;
    assert.ok(rec, "both windows carry measured rows, so a comparison exists");
    assert.equal(rec.evidenceClass, "MEASURED");
    assert.equal(rec.baseline.impressions, 100);
    assert.equal(rec.observed.impressions, 49);
    assert.equal(rec.delta.clicks, -0.5, "10 → 5 clicks, measured");
    assert.equal(body.verification.verdict, "PASS");
    assert.equal(body.freshness.latestMetricDate, "2026-09-16", "freshness never overstates recency");
  });

  void it("cross-tenant before/after is a uniform 404", async () => {
    assert.ok(ctx.verified && ctx.cookieB);
    const res = await inject("GET", `/v1/gsc/actions/${ctx.verified}/before-after`, ctx.cookieB);
    assert.equal(res.statusCode, 404);
  });
});
