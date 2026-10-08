// ─── PHASE-3-UI API gate: workspace + Evidence Ledger endpoints ───
//
// Proves the dashboard's data plane on the production route wiring against
// PostgreSQL: list projects, overview aggregation, crawl history, evidence
// listing, finding detail with linked evidence — all tenant-scoped, with
// cross-tenant negatives AND a non-vacuous admin control.
//
// The audit core processes deterministic local HTML; no third-party site is fetched.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Response } from "light-my-request";
import { buildApp } from "./server.ts";
import { withAdmin } from "@serpvera/db";
import { createFixtureSiteAuditRunner } from "./audit/fixture-audit.ts";

const TAG = `ui${process.pid}${(Date.now() % 100_000).toString(36)}`;
const PW = "workspace-pw-123";

function sessionOf(res: Response): string {
  const sc = res.headers["set-cookie"];
  const raw = typeof sc === "string" ? sc : Array.isArray(sc) ? sc[0] : undefined;
  const m = /serpvera_session=([^;]+)/.exec(raw ?? "");
  return m?.[1] ?? "";
}

async function injectJson(
  app: FastifyInstance,
  method: "GET" | "POST",
  url: string,
  cookie?: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    ...(cookie ? { headers: { cookie: `serpvera_session=${cookie}` } } : {}),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

void describe("workspace/Evidence-Ledger endpoints (real PostgreSQL)", () => {
  let app: FastifyInstance;
  const ctx: {
    cookieA?: string;
    orgId?: string;
    projectId?: string;
    cookieB?: string;
  } = {};

  before(async () => {
    app = await buildApp({
      driver: "postgres",
      auditSite: createFixtureSiteAuditRunner(),
    });
    await app.ready();

    // ── Tenant A: full onboarding + deterministic fixture crawl ──
    const uid = randomUUID().slice(0, 8);
    const reg = await injectJson(app, "POST", "/v1/auth/register", undefined, {
      email: `uia${TAG}${uid}@test.local`,
      password: PW,
    });
    assert.equal(reg.statusCode, 201, reg.body);
    const c1 = sessionOf(reg);

    const org = await injectJson(app, "POST", "/v1/organizations", c1, {
      name: `UI Org ${TAG} A`,
      slug: `ui-a-${TAG}-${uid}`,
    });
    assert.equal(org.statusCode, 201, org.body);
    ctx.orgId = (JSON.parse(org.body) as { organization: { id: string } }).organization.id;

    const sel = await injectJson(app, "POST", "/v1/auth/select-organization", c1, {
      organizationId: ctx.orgId,
    });
    assert.equal(sel.statusCode, 200, sel.body);
    ctx.cookieA = sessionOf(sel);

    const proj = await injectJson(app, "POST", "/v1/projects", ctx.cookieA, {
      organizationId: ctx.orgId,
      primaryDomain: "audit-fixture.test",
      name: "UI Fixture Project",
    });
    assert.equal(proj.statusCode, 201, proj.body);
    ctx.projectId = (JSON.parse(proj.body) as { project: { id: string } }).project.id;

    const run = await injectJson(
      app,
      "POST",
      `/v1/projects/${ctx.projectId}/crawl-runs`,
      ctx.cookieA,
    );
    assert.equal(run.statusCode, 201, run.body);

    // Wait for FULL persistence: findings AND evidence AND terminal run.
    // Polling findings alone races the worker (findings are inserted before
    // evidence/links) and lets teardown close the pool mid-write.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const f = await injectJson(app, "GET", `/v1/projects/${ctx.projectId}/findings`, ctx.cookieA);
      const rows = (JSON.parse(f.body) as { findings: unknown[] }).findings;
      if (rows.length === 0) continue;
      const ev = await injectJson(
        app,
        "GET",
        `/v1/projects/${ctx.projectId}/evidence`,
        ctx.cookieA,
      );
      if ((JSON.parse(ev.body) as { evidence: unknown[] }).evidence.length === 0) continue;
      const cr = await injectJson(
        app,
        "GET",
        `/v1/projects/${ctx.projectId}/crawl-runs`,
        ctx.cookieA,
      );
      const runs = (JSON.parse(cr.body) as { crawlRuns: { status: string }[] }).crawlRuns;
      if (runs[0]?.status === "completed" || runs[0]?.status === "failed") break;
      if (i === 39) throw new Error("worker did not finish persisting in time");
    }

    // ── Tenant B: minimal (own empty workspace) ──
    const uidB = randomUUID().slice(0, 8);
    const regB = await injectJson(app, "POST", "/v1/auth/register", undefined, {
      email: `uib${TAG}${uidB}@test.local`,
      password: PW,
    });
    assert.equal(regB.statusCode, 201, regB.body);
    const c1B = sessionOf(regB);
    const orgB = await injectJson(app, "POST", "/v1/organizations", c1B, {
      name: `UI Org ${TAG} B`,
      slug: `ui-b-${TAG}-${uidB}`,
    });
    assert.equal(orgB.statusCode, 201, orgB.body);
    const orgBId = (JSON.parse(orgB.body) as { organization: { id: string } }).organization.id;
    const selB = await injectJson(app, "POST", "/v1/auth/select-organization", c1B, {
      organizationId: orgBId,
    });
    ctx.cookieB = sessionOf(selB);
  });

  after(async () => {
    await app.close();
    await withAdmin(async (c) => {
      await c.query(`DELETE FROM organizations WHERE name LIKE $1`, [`UI Org ${TAG}%`]);
      await c.query(`DELETE FROM users WHERE email LIKE $1`, [`ui%${TAG}%@test.local`]);
    });
  });

  void it("GET /v1/projects lists only the active org's projects", async () => {
    const res = await injectJson(app, "GET", "/v1/projects", ctx.cookieA);
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      projects: { id: string; primaryDomain: string }[];
    };
    assert.equal(body.projects.length, 1, "A must see exactly its own project");
    const [project] = body.projects;
    assert.ok(project, "A must see exactly its own project");
    assert.equal(project.id, ctx.projectId);
    assert.equal(project.primaryDomain, "audit-fixture.test");

    // B sees its own (empty) org, never A's project.
    const resB = await injectJson(app, "GET", "/v1/projects", ctx.cookieB);
    const bodyB = JSON.parse(resB.body) as { projects: unknown[] };
    assert.equal(bodyB.projects.length, 0, "B must not see A's projects");
  });

  void it("GET overview aggregates only persisted fixture-derived data", async () => {
    const res = await injectJson(app, "GET", `/v1/projects/${ctx.projectId}/overview`, ctx.cookieA);
    assert.equal(res.statusCode, 200, res.body);
    const o = JSON.parse(res.body) as {
      findings: {
        total: number;
        bySeverity: Record<string, number>;
        latest: unknown;
      };
      evidence: { total: number };
      crawls: { total: number; latest: { status: string } | null };
      interventions: { verified: number; note: string };
      methodVersion: string;
    };

    assert.ok(o.findings.total > 0, "overview must reflect findings from the fixture HTML");
    const severitySum = Object.values(o.findings.bySeverity).reduce((a, b) => a + b, 0);
    assert.equal(severitySum, o.findings.total, "severity buckets must sum to total");
    assert.ok(o.findings.latest, "what-changed needs a latest finding");
    assert.ok(o.evidence.total > 0, "evidence count must be real");
    assert.ok(o.crawls.total >= 1, "crawl history must include the run");
    assert.equal(o.crawls.latest?.status, "completed");
    // Honest emptiness — no invented intervention metrics (§16 no fake scores).
    assert.equal(o.interventions.verified, 0);
    assert.match(o.interventions.note, /No intervention/);
    assert.ok(o.methodVersion, "method version must be exposed");
  });

  void it("GET crawl-runs returns real history newest-first", async () => {
    const res = await injectJson(
      app,
      "GET",
      `/v1/projects/${ctx.projectId}/crawl-runs`,
      ctx.cookieA,
    );
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      crawlRuns: {
        id: string;
        status: string;
        mode: string;
        startedAt: string;
        pageLimit: number | null;
        stopReason: string | null;
      }[];
    };
    assert.ok(body.crawlRuns.length >= 1);
    const [run] = body.crawlRuns;
    assert.ok(run, "crawl run must be exposed");
    assert.equal(run.status, "completed");
    assert.equal(run.mode, "HTTP_FAST");
    assert.ok(run.startedAt, "startedAt must be exposed for the timeline");
    assert.equal(run.pageLimit, 50, "bounded crawl limit must be visible in history");
    assert.equal(run.stopReason, null, "fixture discovery ended without a truncation reason");
  });

  void it("findings expose scope, declared gate, provenance and action state", async () => {
    const res = await injectJson(app, "GET", `/v1/projects/${ctx.projectId}/findings`, ctx.cookieA);
    const body = JSON.parse(res.body) as {
      findings: {
        id: string;
        ruleId: string;
        ruleVersion: string;
        epistemicClass: string;
        affectedUrls: string[];
        verificationGate: string;
        actionState: string | null;
      }[];
    };
    assert.ok(body.findings.length > 0);
    for (const f of body.findings) {
      assert.equal(f.epistemicClass, "OBSERVED", "NEXUS doctrine preserved");
      assert.ok(f.ruleVersion, "provenance: rule version required");
      assert.ok(
        f.affectedUrls.length > 0,
        `finding ${f.ruleId} must carry its affected URL (scope)`,
      );
      assert.ok(f.verificationGate, "rule contract must declare a gate");
      assert.ok(
        ["DETECTED", "PROPOSED", "APPROVED"].includes(f.actionState ?? ""),
        `action state must be tracked, got ${f.actionState}`,
      );
    }
  });

  void it("finding detail links the supporting evidence (hash + source)", async () => {
    const list = await injectJson(
      app,
      "GET",
      `/v1/projects/${ctx.projectId}/findings`,
      ctx.cookieA,
    );
    const [first] = (JSON.parse(list.body) as { findings: { id: string }[] }).findings;
    assert.ok(first, "findings list must contain the seeded finding");

    const res = await injectJson(app, "GET", `/v1/findings/${first.id}`, ctx.cookieA);
    assert.equal(res.statusCode, 200, res.body);
    const detail = JSON.parse(res.body) as {
      finding: {
        id: string;
        affectedUrls: string[];
        verificationGate: string;
        actionState: string | null;
        evidence: {
          id: string;
          contentHash: string;
          sourceRef: string;
          kind: string;
        }[];
      };
    };
    assert.equal(detail.finding.id, first.id);
    assert.ok(detail.finding.evidence.length > 0, "finding must link its supporting evidence");
    for (const e of detail.finding.evidence) {
      assert.match(e.contentHash, /^[0-9a-f]{64}$/, "evidence must carry a real SHA-256 hash");
      assert.ok(e.sourceRef.startsWith("https://"), "evidence must reference the real source URL");
    }
  });

  void it("GET evidence lists project evidence with hashes", async () => {
    const res = await injectJson(app, "GET", `/v1/projects/${ctx.projectId}/evidence`, ctx.cookieA);
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as {
      evidence: {
        contentHash: string;
        kind: string;
        metadata: Record<string, unknown>;
      }[];
    };
    assert.ok(body.evidence.length > 0);
    for (const e of body.evidence) {
      assert.match(e.contentHash, /^[0-9a-f]{64}$/);
      assert.ok(e.metadata.summary ?? e.metadata.finalUrl, "metadata must be preserved");
    }
  });

  void it("cross-tenant: B gets 404 everywhere on A's workspace, 401 unauthenticated", async () => {
    for (const url of [
      `/v1/projects/${ctx.projectId}/overview`,
      `/v1/projects/${ctx.projectId}/crawl-runs`,
      `/v1/projects/${ctx.projectId}/evidence`,
      `/v1/projects/${ctx.projectId}/findings`,
    ]) {
      const res = await injectJson(app, "GET", url, ctx.cookieB);
      assert.equal(res.statusCode, 404, `B must get 404 for ${url}, got ${res.statusCode}`);
    }

    // Finding detail: B cannot fetch A's finding either.
    const listA = await injectJson(
      app,
      "GET",
      `/v1/projects/${ctx.projectId}/findings`,
      ctx.cookieA,
    );
    const [firstFinding] = (JSON.parse(listA.body) as { findings: { id: string }[] }).findings;
    assert.ok(firstFinding, "findings list must contain the seeded finding");
    const findingId = firstFinding.id;
    const detailB = await injectJson(app, "GET", `/v1/findings/${findingId}`, ctx.cookieB);
    assert.equal(detailB.statusCode, 404, "cross-tenant finding detail must be 404");

    // No session at all.
    const anon = await injectJson(app, "GET", "/v1/projects");
    assert.equal(anon.statusCode, 401);

    // POSITIVE CONTROL: data provably exists (admin bypass) — so the 404s
    // above are isolation, not an empty database.
    const control = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT (SELECT count(*)::int FROM findings WHERE project_id = $1) AS f,
                (SELECT count(*)::int FROM finding_evidence) AS fe`,
        [ctx.projectId],
      );
      return r.rows[0] as { f: number; fe: number };
    });
    assert.ok(control.f > 0, "admin must see A's findings (control)");
    assert.ok(control.fe > 0, "admin must see finding_evidence links (control)");
  });
});
