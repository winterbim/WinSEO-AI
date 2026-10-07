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
  subject: {
    query?: string;
    page?: string;
    device?: string;
    country?: string;
    property?: string;
  };
  title: string;
  rationale: string;
  datasetWindow: { startDate: string; endDate: string };
  filters: Record<string, string | number | boolean>;
  comparisonWindow?: { startDate: string; endDate: string };
  observed: Record<string, number | string>;
  baseline?: Record<string, number | string>;
  delta?: Record<string, number>;
  evidenceClass: "MEASURED";
  verificationGate: {
    type: "gsc_window";
    spec: {
      metric: "ctr" | "clicks" | "impressions" | "position";
      operator: "gte" | "lte";
      threshold: number;
      query?: string;
      page?: string;
      device?: string;
      country?: string;
      connectionId?: string;
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
    connectionA?: string;
    verified?: string;
    rejected?: string;
    inconclusiveSample?: string;
    inconclusiveNoData?: string;
    inconclusiveRunning?: string;
    inconclusiveFailed?: string;
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
    const organizationId = (JSON.parse(org.body) as { organization: { id: string } }).organization
      .id;
    const selected = await inject("POST", "/v1/auth/select-organization", baseCookie, {
      organizationId,
    });
    return { organizationId, cookie: sessionOf(selected) };
  }

  /** Seed a workflow fixture without exercising the GSC promotion boundary. */
  async function createFixtureFinding(payload: FindingPayload): Promise<{
    actionId: string;
    findingId: string;
  }> {
    assert.ok(ctx.orgA && ctx.projectA);
    const scopedPayload: FindingPayload = {
      ...payload,
      verificationGate: {
        ...payload.verificationGate,
        spec: {
          ...payload.verificationGate.spec,
          ...(ctx.connectionA ? { connectionId: ctx.connectionA } : {}),
        },
      },
    };
    const ruleId = `GSC.fixture.${scopedPayload.module}::${scopedPayload.subject.query}`;
    const finding = await app.stores.crawl.addFinding(ctx.orgA, ctx.projectA, {
      ruleId,
      ruleVersion: "test-fixture",
      title: scopedPayload.title,
      epistemicClass: scopedPayload.evidenceClass,
      severity: scopedPayload.severity,
      explanation: scopedPayload.rationale,
      recommendation: scopedPayload.title,
      affectedUrls: [scopedPayload.subject.page ?? "https://example.com/"],
      verificationGate: scopedPayload.verificationGate.type,
    });
    const contentHash = createHash("sha256").update(JSON.stringify(scopedPayload)).digest("hex");
    const evidence = await app.stores.crawl.addEvidence(ctx.orgA, ctx.projectA, {
      kind: "gsc_data",
      sourceRef: `fixture://gsc/${contentHash}`,
      contentHash,
      objectKey: `${ctx.orgA}/${ctx.projectA}/test-fixtures/${contentHash}`,
      metadata: { ...scopedPayload },
    });
    await app.stores.crawl.linkFindingEvidence(ctx.orgA, finding.id, evidence.id);
    const action = await app.stores.crawl.createDetectedAction(ctx.orgA, ctx.projectA, finding.id);
    return { actionId: action.id, findingId: finding.id };
  }

  async function promoteRecommendation(payload: unknown, cookie = ctx.cookieA): Promise<Response> {
    assert.ok(ctx.projectA && cookie);
    return inject("POST", `/v1/projects/${ctx.projectA}/gsc/findings`, cookie, payload);
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
  async function walkToMeasuring(
    actionId: string,
    gate: FindingPayload["verificationGate"],
  ): Promise<void> {
    const propertyGate: FindingPayload["verificationGate"] = {
      ...gate,
      spec: { ...gate.spec, connectionId: ctx.connectionA },
    };
    let v = 1;
    for (const step of [
      { toState: "EVIDENCED" },
      {
        toState: "PROPOSED",
        recommendation: {
          summary: "Apply the measured change.",
          rationale: "The MEASURED finding shows the gap.",
          verificationGate: propertyGate,
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
    ctx.connectionA = connection.id;
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
    const septAttempt = await gsc.claimJob(
      a.organizationId,
      jobSept.id,
      "2026-10-01T00:00:00.000Z",
    );
    const augAttempt = await gsc.claimJob(a.organizationId, jobAug.id, "2026-09-01T00:00:00.000Z");
    assert.ok(septAttempt);
    assert.ok(augAttempt);
    await gsc.persistMetricWindow({
      organizationId: a.organizationId,
      projectId: ctx.projectA,
      syncJobId: jobSept.id,
      expectedAttempt: septAttempt,
      window: SEPTEMBER,
      rows: [
        // ctr 5/49 ≈ 0.1020, weighted position (4·40 + 8·9)/49 ≈ 4.7347
        metricRow({
          date: "2026-09-15",
          query: "verified q",
          page: "https://example.com/v",
          clicks: 4,
          impressions: 40,
          ctr: 0.1,
          position: 4,
        }),
        metricRow({
          date: "2026-09-16",
          query: "verified q",
          page: "https://example.com/v",
          clicks: 1,
          impressions: 9,
          ctr: 0.111,
          position: 8,
        }),
        metricRow({
          date: "2026-09-15",
          query: "rejected q",
          page: "https://example.com/r",
          clicks: 4,
          impressions: 40,
          ctr: 0.1,
          position: 4,
        }),
        metricRow({
          date: "2026-09-16",
          query: "rejected q",
          page: "https://example.com/r",
          clicks: 1,
          impressions: 9,
          ctr: 0.111,
          position: 8,
        }),
        metricRow({
          date: "2026-09-15",
          query: "thin q",
          page: "https://example.com/t",
          clicks: 1,
          impressions: 10,
          ctr: 0.1,
          position: 5,
        }),
        metricRow({
          date: "2026-09-15",
          query: "measured low ctr",
          page: "https://example.com/low",
          country: "fra",
          clicks: 5,
          impressions: 800,
          ctr: 0.00625,
          position: 8,
        }),
        metricRow({
          date: "2026-09-15",
          query: "measured low ctr",
          page: "https://example.com/low",
          country: "can",
          clicks: 100,
          impressions: 800,
          ctr: 0.125,
          position: 8,
        }),
      ],
    });
    await gsc.persistMetricWindow({
      organizationId: a.organizationId,
      projectId: ctx.projectA,
      syncJobId: jobAug.id,
      expectedAttempt: augAttempt,
      window: AUGUST,
      rows: [
        metricRow({
          date: "2026-08-15",
          query: "verified q",
          page: "https://example.com/v",
          clicks: 10,
          impressions: 100,
          ctr: 0.1,
          position: 6,
        }),
      ],
    });
    assert.equal(
      await gsc.updateJob(a.organizationId, jobSept.id, {
        status: "COMPLETED",
        expectedAttempt: septAttempt,
        rowCount: 7,
        completedAt: "2026-10-01T00:00:00.000Z",
      }),
      true,
    );
    assert.equal(
      await gsc.updateJob(a.organizationId, jobAug.id, {
        status: "COMPLETED",
        expectedAttempt: augAttempt,
        rowCount: 1,
        completedAt: "2026-09-01T00:00:00.000Z",
      }),
      true,
    );

    assert.deepEqual(
      (await gsc.listJobs(a.organizationId, ctx.projectA))
        .map(({ status, windowStart, windowEnd }) => ({ status, windowStart, windowEnd }))
        .sort(
          (left, right) =>
            left.windowStart.localeCompare(right.windowStart) ||
            left.status.localeCompare(right.status),
        ),
      [
        { status: "COMPLETED", windowStart: AUGUST.startDate, windowEnd: AUGUST.endDate },
        { status: "COMPLETED", windowStart: SEPTEMBER.startDate, windowEnd: SEPTEMBER.endDate },
      ],
    );

    ctx.verified = (
      await createFixtureFinding(
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
      )
    ).actionId;
    ctx.rejected = (
      await createFixtureFinding(
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
      )
    ).actionId;
    ctx.inconclusiveSample = (
      await createFixtureFinding(
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
      )
    ).actionId;
    ctx.inconclusiveNoData = (
      await createFixtureFinding(
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
      )
    ).actionId;
    ctx.inconclusiveFailed = (
      await createFixtureFinding(
        measuredFinding({
          query: "failed q",
          page: "https://example.com/failed",
          module: "winners_losers",
          gate: {
            metric: "impressions",
            operator: "gte",
            threshold: 1,
            query: "failed q",
            page: "https://example.com/failed",
            minImpressions: 0,
            windowDays: 30,
          },
        }),
      )
    ).actionId;
    ctx.inconclusiveRunning = (
      await createFixtureFinding(
        measuredFinding({
          query: "running-only q",
          page: "https://example.com/running-only",
          module: "winners_losers",
          gate: {
            metric: "impressions",
            operator: "gte",
            threshold: 1,
            query: "running-only q",
            page: "https://example.com/running-only",
            minImpressions: 0,
            windowDays: 30,
          },
        }),
      )
    ).actionId;
  });

  after(async () => {
    await withAdmin(async (client) => {
      await client.query(`DELETE FROM organizations WHERE name LIKE $1`, [`GSC Verify ${TAG}%`]);
      await client.query(`DELETE FROM users WHERE email LIKE $1`, [`%${TAG}%@test.local`]);
    });
    await app.close();
  });

  void it("promotes only a server-recomputed GSC recommendation and rejects stale subjects", async () => {
    assert.ok(ctx.projectA && ctx.cookieA && ctx.orgA);
    const intelligence = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/gsc/intelligence?startDate=${SEPTEMBER.startDate}&endDate=${SEPTEMBER.endDate}&module=high_impressions_low_ctr&country=fra`,
      ctx.cookieA,
    );
    assert.equal(intelligence.statusCode, 200, intelligence.body);
    const measured = (
      JSON.parse(intelligence.body) as { recommendations: FindingPayload[] }
    ).recommendations.find((candidate) => candidate.subject.query === "measured low ctr");
    assert.ok(measured, "recommendation must be derived from the fixture's persisted GSC row");
    assert.equal(measured.subject.country, "fra");
    assert.equal(measured.subject.property, "sc-domain:example.com");
    assert.equal(measured.verificationGate.spec.country, "fra");
    assert.equal(measured.verificationGate.spec.connectionId !== undefined, true);

    const forged = {
      ...measured,
      sourceFilters: { country: "fra" },
      title: "Invented title from caller",
      rationale: "Invented source and explanation",
      observed: { impressions: 999_999, clicks: 999_999, ctr: 1, position: 1, days: 30 },
      severity: "critical",
      verificationGate: {
        type: "gsc_window",
        spec: { ...measured.verificationGate.spec, threshold: 0.99 },
      },
    };
    const unfiltered = await promoteRecommendation({ ...forged, sourceFilters: {} });
    assert.equal(unfiltered.statusCode, 409, unfiltered.body);
    assert.equal(
      (JSON.parse(unfiltered.body) as { error: { code: string } }).error.code,
      "MEASUREMENT_STALE",
      "a filtered analysis cannot be promoted using unfiltered project rows",
    );

    const missingBaseline = await promoteRecommendation({
      module: "emerging_queries",
      subject: { query: "measured low ctr", page: "https://example.com/low" },
      datasetWindow: SEPTEMBER,
      comparisonWindow: { startDate: "2026-07-01", endDate: "2026-07-31" },
      sourceFilters: { country: "fra" },
    });
    assert.equal(missingBaseline.statusCode, 409, missingBaseline.body);
    assert.equal(
      (JSON.parse(missingBaseline.body) as { error: { code: string } }).error.code,
      "COMPARISON_WINDOW_NOT_SYNCED",
      "missing comparison coverage is never treated as zero impressions",
    );

    const [promoted, concurrentReplay] = await Promise.all([
      promoteRecommendation(forged),
      promoteRecommendation(forged),
    ]);
    assert.ok([201, 200].includes(promoted.statusCode), promoted.body);
    assert.ok([201, 200].includes(concurrentReplay.statusCode), concurrentReplay.body);
    const promotedBody = JSON.parse(promoted.body) as {
      created: boolean;
      findingId: string;
      evidenceId?: string;
      actionId: string;
    };
    const replayBody = JSON.parse(concurrentReplay.body) as {
      created: boolean;
      findingId: string;
      evidenceId?: string;
      actionId: string;
    };
    const created = (promotedBody.created ? promotedBody : replayBody) as {
      created: boolean;
      findingId: string;
      evidenceId: string;
      actionId: string;
      contentHash: string;
      epistemicClass: string;
      verificationGate: string;
    };
    const concurrentDuplicate = promotedBody.created ? replayBody : promotedBody;
    assert.equal(created.created, true);
    assert.equal(concurrentDuplicate.created, false);
    assert.equal(concurrentDuplicate.findingId, created.findingId);
    assert.equal(concurrentDuplicate.actionId, created.actionId);
    assert.equal(created.epistemicClass, "MEASURED");
    assert.equal(created.verificationGate, "gsc_window");

    const stored = await app.stores.crawl.getFinding(ctx.orgA, created.findingId);
    assert.ok(stored);
    assert.equal(stored.title, measured.title, "caller-supplied title is not persisted");
    assert.equal(stored.explanation, measured.rationale);
    assert.equal(stored.severity, measured.severity);
    const storedEvidence = stored.evidence[0];
    assert.ok(storedEvidence);
    assert.deepEqual(storedEvidence.metadata.observed, measured.observed);
    assert.deepEqual(storedEvidence.metadata.verificationGate, measured.verificationGate);
    assert.ok(app.stores.gsc);
    const gscStore = app.stores.gsc;
    assert.ok(gscStore);
    const organizationId = ctx.orgA;
    const projectId = ctx.projectA;
    assert.ok(organizationId && projectId);
    const selectedConnection = (await gscStore.listConnections(organizationId, projectId)).find(
      (connection) => connection.status === "CONNECTED",
    );
    assert.ok(selectedConnection);
    const replaceSeptemberRows = async (
      rows: Awaited<ReturnType<typeof gscStore.loadMetricRows>>,
    ): Promise<void> => {
      const replacement = await gscStore.createOrReuseJob({
        organizationId,
        projectId,
        connectionId: selectedConnection.id,
        windowStart: SEPTEMBER.startDate,
        windowEnd: SEPTEMBER.endDate,
        idempotencyKey: `${SEPTEMBER.startDate}:${SEPTEMBER.endDate}`,
      });
      const expectedAttempt = await gscStore.claimJob(
        organizationId,
        replacement.id,
        new Date().toISOString(),
      );
      assert.ok(expectedAttempt);
      await gscStore.persistMetricWindow({
        organizationId,
        projectId,
        syncJobId: replacement.id,
        expectedAttempt,
        window: SEPTEMBER,
        rows,
      });
      assert.equal(
        await gscStore.updateJob(organizationId, replacement.id, {
          status: "COMPLETED",
          expectedAttempt,
          completedAt: new Date().toISOString(),
        }),
        true,
      );
    };
    const sourceProperty = {
      connectionId: selectedConnection.id,
      externalProperty: selectedConnection.externalProperty,
    };
    const persistedRows = await app.stores.gsc.loadMetricRows(ctx.orgA, ctx.projectA, SEPTEMBER, {
      country: "fra",
      connectionId: selectedConnection.id,
    });
    const sourceRows = {
      current: persistedRows
        .map((row) => ({
          date: row.date,
          query: row.query,
          page: row.page,
          country: row.country,
          device: row.device,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      baseline: [],
    };
    const measurementSource = {
      sha256: createHash("sha256")
        .update(JSON.stringify({ sourceProperty, sourceRows }))
        .digest("hex"),
      sourceProperty,
      currentRowCount: sourceRows.current.length,
      baselineRowCount: 0,
    };
    assert.deepEqual(storedEvidence.metadata.measurementSource, measurementSource);
    assert.deepEqual(storedEvidence.metadata.sourceFilters, { country: "fra" });
    assert.deepEqual(storedEvidence.metadata.sourceProperty, sourceProperty);
    assert.equal(measured.verificationGate.spec.connectionId, selectedConnection.id);
    assert.equal(
      created.contentHash,
      createHash("sha256")
        .update(
          JSON.stringify({
            module: measured.module,
            subject: measured.subject,
            sourceProperty,
            datasetWindow: measured.datasetWindow,
            sourceFilters: { country: "fra" },
            filters: measured.filters,
            comparisonWindow: measured.comparisonWindow ?? null,
            baseline: measured.baseline ?? null,
            delta: measured.delta ?? null,
            measurementSource,
            observed: measured.observed,
            evidenceClass: measured.evidenceClass,
            verificationGate: measured.verificationGate,
          }),
        )
        .digest("hex"),
      "the hash covers the server-derived measurement, not the caller's values",
    );

    // A sync may replace a window after the API computed its recommendation.
    // The persistence boundary must reject that stale snapshot, while a fresh
    // promotion refreshes the still-unstarted workflow with new evidence.
    const oldEvidence = stored.evidence.find((item) => item.kind === "gsc_data");
    assert.ok(oldEvidence);
    const allSeptemberRows = await gscStore.loadMetricRows(organizationId, projectId, SEPTEMBER, {
      connectionId: selectedConnection.id,
    });
    await replaceSeptemberRows(
      allSeptemberRows.map((row) =>
        row.query === "measured low ctr" && row.country === "fra"
          ? { ...row, clicks: 10, ctr: 0.0125 }
          : row,
      ),
    );
    await assert.rejects(
      app.stores.crawl.createMeasuredGscWorkflow(
        ctx.orgA,
        ctx.projectA,
        {
          ruleId: stored.ruleId,
          ruleVersion: "1.0.0",
          title: measured.title,
          epistemicClass: "MEASURED",
          severity: measured.severity,
          explanation: measured.rationale,
          recommendation: measured.title,
          affectedUrls: ["https://example.com/low"],
          verificationGate: measured.verificationGate.type,
        },
        {
          kind: "gsc_data",
          sourceRef: oldEvidence.sourceRef,
          contentHash: oldEvidence.contentHash,
          objectKey: oldEvidence.objectKey,
          metadata: oldEvidence.metadata,
        },
      ),
      (error: unknown) => (error as { code?: string }).code === "MEASUREMENT_SNAPSHOT_CHANGED",
    );

    const refreshed = await promoteRecommendation(forged);
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    const refreshedBody = JSON.parse(refreshed.body) as {
      created: boolean;
      updated: boolean;
      findingId: string;
      evidenceId: string;
      actionId: string;
      contentHash: string;
    };
    assert.equal(refreshedBody.created, false);
    assert.equal(refreshedBody.updated, true);
    assert.equal(refreshedBody.findingId, created.findingId);
    assert.equal(refreshedBody.actionId, created.actionId);
    assert.notEqual(refreshedBody.evidenceId, oldEvidence.id);
    assert.notEqual(refreshedBody.contentHash, created.contentHash);
    const refreshedFinding = await app.stores.crawl.getFinding(ctx.orgA, created.findingId);
    assert.ok(refreshedFinding);
    assert.equal(
      refreshedFinding.evidence.filter((item) => item.kind === "gsc_data").length,
      2,
      "superseded evidence stays in the append-only evidence ledger",
    );

    const evidenced = await transition(created.actionId, 1, { toState: "EVIDENCED" });
    assert.equal(evidenced.statusCode, 200, evidenced.body);
    const tamperedGate = {
      ...measured.verificationGate,
      spec: { ...measured.verificationGate.spec, threshold: 0 },
    };
    const changedGate = await transition(created.actionId, 2, {
      toState: "PROPOSED",
      recommendation: {
        summary: "A proposal with a weakened verification gate.",
        verificationGate: tamperedGate,
      },
    });
    assert.equal(changedGate.statusCode, 409, changedGate.body);
    assert.equal(
      (JSON.parse(changedGate.body) as { error: { code: string } }).error.code,
      "RECOMMENDATION_REQUIRED",
    );
    const exactGateProposal = await transition(created.actionId, 2, {
      toState: "PROPOSED",
      recommendation: {
        summary: "Apply the measured change under its recorded verification gate.",
        verificationGate: measured.verificationGate,
      },
    });
    assert.equal(exactGateProposal.statusCode, 200, exactGateProposal.body);

    const rowsAfterProposal = await gscStore.loadMetricRows(organizationId, projectId, SEPTEMBER, {
      connectionId: selectedConnection.id,
    });
    await replaceSeptemberRows(
      rowsAfterProposal.map((row) =>
        row.query === "measured low ctr" && row.country === "fra"
          ? { ...row, clicks: 11, ctr: 0.01375 }
          : row,
      ),
    );
    const changedDuringAction = await promoteRecommendation(forged);
    assert.equal(changedDuringAction.statusCode, 409, changedDuringAction.body);
    assert.equal(
      (JSON.parse(changedDuringAction.body) as { error: { code: string } }).error.code,
      "MEASUREMENT_WORKFLOW_ADVANCED",
      "new measurements cannot silently replace evidence after an action is proposed",
    );

    // Continue from the action created by the real promotion route. Its
    // verification gate must retain the analysis country filter: including
    // the Canadian row would incorrectly turn this French low-CTR finding
    // into a PASS.
    const approved = await transition(created.actionId, 3, {
      toState: "APPROVED",
      approvalDecision: "APPROVE",
    });
    assert.equal(approved.statusCode, 200, approved.body);
    const manuallyReported = await transition(created.actionId, 4, {
      toState: "REPORTED_MANUALLY",
      implementation: { whatChanged: "Updated the result title.", how: "Fixture release." },
      rollback: { strategy: "Restore the previous title.", trigger: "CTR remains below target." },
    });
    assert.equal(manuallyReported.statusCode, 200, manuallyReported.body);
    const measuring = await transition(created.actionId, 5, {
      toState: "MEASURING",
      baselineSnapshot: { source: "gsc_query_metrics", window: AUGUST },
      comparisonWindow: {
        startsAt: `${SEPTEMBER.startDate}T00:00:00.000Z`,
        endsAt: `${SEPTEMBER.endDate}T23:59:59.000Z`,
      },
    });
    assert.equal(measuring.statusCode, 200, measuring.body);
    const evaluated = await transition(created.actionId, 6, { toState: "EVALUATE" });
    assert.equal(evaluated.statusCode, 200, evaluated.body);
    const promotedOutcome = (
      JSON.parse(evaluated.body) as {
        action: {
          state: string;
          verification: { verdict: string; filters: Record<string, unknown> };
        };
      }
    ).action;
    assert.equal(promotedOutcome.state, "REJECTED");
    assert.equal(promotedOutcome.verification.verdict, "FAIL");
    assert.equal(promotedOutcome.verification.filters.country, "fra");

    const viewerEmail = `${TAG}_viewer@test.local`;
    const viewerRegistration = await inject("POST", "/v1/auth/register", undefined, {
      email: viewerEmail,
      password: PW,
    });
    assert.equal(viewerRegistration.statusCode, 201, viewerRegistration.body);
    const viewerBaseCookie = sessionOf(viewerRegistration);
    await withAdmin(async (client) => {
      await client.query(
        `INSERT INTO memberships (user_id, organization_id, role)
         SELECT id, $1, 'VIEWER' FROM users WHERE email = $2`,
        [ctx.orgA, viewerEmail],
      );
    });
    const viewerSelected = await inject("POST", "/v1/auth/select-organization", viewerBaseCookie, {
      organizationId: ctx.orgA,
    });
    assert.equal(viewerSelected.statusCode, 200, viewerSelected.body);
    const viewerCookie = sessionOf(viewerSelected);
    const evidenceBeforeViewerAttempt = await app.stores.crawl.listEvidence(ctx.orgA, ctx.projectA);
    const viewerAttempt = await promoteRecommendation(forged, viewerCookie);
    assert.equal(viewerAttempt.statusCode, 403, viewerAttempt.body);
    const evidenceAfterViewerAttempt = await app.stores.crawl.listEvidence(ctx.orgA, ctx.projectA);
    assert.equal(evidenceAfterViewerAttempt.length, evidenceBeforeViewerAttempt.length);

    const stale = await promoteRecommendation({
      ...measured,
      subject: { query: "query-without-persisted-metrics", page: "https://example.com/missing" },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(
      (JSON.parse(stale.body) as { error: { code: string } }).error.code,
      "MEASUREMENT_STALE",
    );

    // Once the action has reached a terminal outcome, changed measurements
    // require a new review instead of rewriting the historical workflow.
    const duplicate = await promoteRecommendation(forged);
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.equal(
      (JSON.parse(duplicate.body) as { error: { code: string } }).error.code,
      "MEASUREMENT_WORKFLOW_ADVANCED",
    );
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
    const action = (
      JSON.parse(evaluated.body) as {
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
      }
    ).action;
    assert.equal(action.state, "VERIFIED");
    assert.equal(action.verification.verdict, "PASS");
    assert.equal(action.verification.source, "gsc_query_metrics");
    assert.deepEqual(
      action.verification.window,
      SEPTEMBER,
      "the declared window is measured exactly",
    );
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
    const action = (
      JSON.parse(evaluated.body) as {
        action: { state: string; verification: { verdict: string; comparedValue: number } };
      }
    ).action;
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
    const action = (
      JSON.parse(evaluated.body) as {
        action: {
          state: string;
          verification: { verdict: string; reason: string; observed: { impressions: number } };
        };
      }
    ).action;
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
    const action = (
      JSON.parse(evaluated.body) as {
        action: { state: string; verification: { verdict: string; reason: string } };
      }
    ).action;
    assert.equal(action.state, "INCONCLUSIVE");
    assert.equal(action.verification.reason, "no_gsc_data_in_window");
  });

  void it("does not verify against rows from RUNNING or FAILED sync jobs", async () => {
    assert.ok(ctx.inconclusiveRunning && ctx.inconclusiveFailed);
    assert.ok(ctx.orgA && ctx.projectA && ctx.connectionA && app.stores.gsc);
    const gscStore = app.stores.gsc;
    const incompleteJob = await gscStore.createOrReuseJob({
      organizationId: ctx.orgA,
      projectId: ctx.projectA,
      connectionId: ctx.connectionA,
      windowStart: SEPTEMBER.startDate,
      windowEnd: SEPTEMBER.endDate,
      idempotencyKey: `${SEPTEMBER.startDate}:${SEPTEMBER.endDate}`,
    });
    const incompleteAttempt = await gscStore.claimJob(
      ctx.orgA,
      incompleteJob.id,
      new Date().toISOString(),
    );
    assert.ok(incompleteAttempt);
    await gscStore.persistMetricWindow({
      organizationId: ctx.orgA,
      projectId: ctx.projectA,
      syncJobId: incompleteJob.id,
      expectedAttempt: incompleteAttempt,
      window: SEPTEMBER,
      rows: [
        metricRow({
          date: "2026-09-15",
          query: "running-only q",
          page: "https://example.com/running-only",
          clicks: 50,
          impressions: 50,
          ctr: 1,
          position: 1,
        }),
        metricRow({
          date: "2026-09-15",
          query: "failed q",
          page: "https://example.com/failed",
          clicks: 50,
          impressions: 50,
          ctr: 1,
          position: 1,
        }),
      ],
    });

    await walkToMeasuring(ctx.inconclusiveRunning, {
      type: "gsc_window",
      spec: {
        metric: "impressions",
        operator: "gte",
        threshold: 1,
        query: "running-only q",
        page: "https://example.com/running-only",
        minImpressions: 0,
        windowDays: 30,
      },
    });
    const runningEvaluation = await transition(ctx.inconclusiveRunning, 6, { toState: "EVALUATE" });
    assert.equal(runningEvaluation.statusCode, 200, runningEvaluation.body);
    const runningAction = (
      JSON.parse(runningEvaluation.body) as {
        action: { state: string; verification: { verdict: string; reason: string } };
      }
    ).action;
    assert.equal(runningAction.state, "INCONCLUSIVE");
    assert.equal(runningAction.verification.verdict, "INCONCLUSIVE");
    assert.equal(runningAction.verification.reason, "no_gsc_data_in_window");

    assert.equal(
      await gscStore.updateJob(ctx.orgA, incompleteJob.id, {
        status: "FAILED",
        expectedAttempt: incompleteAttempt,
        completedAt: new Date().toISOString(),
      }),
      true,
    );
    await walkToMeasuring(ctx.inconclusiveFailed, {
      type: "gsc_window",
      spec: {
        metric: "impressions",
        operator: "gte",
        threshold: 1,
        query: "failed q",
        page: "https://example.com/failed",
        minImpressions: 0,
        windowDays: 30,
      },
    });
    const failedEvaluation = await transition(ctx.inconclusiveFailed, 6, { toState: "EVALUATE" });
    assert.equal(failedEvaluation.statusCode, 200, failedEvaluation.body);
    const failedAction = (
      JSON.parse(failedEvaluation.body) as {
        action: { state: string; verification: { verdict: string; reason: string } };
      }
    ).action;
    assert.equal(failedAction.state, "INCONCLUSIVE");
    assert.equal(failedAction.verification.verdict, "INCONCLUSIVE");
    assert.equal(failedAction.verification.reason, "no_gsc_data_in_window");
  });

  void it("refuses to verify before a waiting window is recorded", async () => {
    const finding = await createFixtureFinding(
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
    const body = JSON.parse(res.body) as {
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
    };
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
    assert.equal(
      body.freshness.latestMetricDate,
      "2026-09-16",
      "freshness never overstates recency",
    );
  });

  void it("cross-tenant before/after is a uniform 404", async () => {
    assert.ok(ctx.verified && ctx.cookieB);
    const res = await inject("GET", `/v1/gsc/actions/${ctx.verified}/before-after`, ctx.cookieB);
    assert.equal(res.statusCode, 404);
  });
});
