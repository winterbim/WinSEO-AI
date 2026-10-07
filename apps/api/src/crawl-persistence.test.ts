// ─── Project crawl → first-class findings/evidence persistence (P-GAP-04) ───
//
// Proves the Evidence Ledger storage path on the REAL production route:
//   authenticated tenant → POST /v1/projects/:id/crawl-runs
//   → audit core over deterministic fixture HTML (no external network)
//   → findings + evidence_items rows in PostgreSQL under RLS (withTenant)
//   → GET /v1/projects/:id/findings reads them back tenant-scoped
//   → a foreign tenant gets 404 and sees zero rows (admin control proves
//     the rows exist — no vacuous assertions)
//
// PostgreSQL and the HTTP route are real; only the HTML fetch is a controlled fixture.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Response } from "light-my-request";
import { buildApp } from "./server.ts";
import { withAdmin } from "@serpvera/db";
import { createFixtureSiteAuditRunner } from "./audit/fixture-audit.ts";

const TAG = `crawl${process.pid}${(Date.now() % 100_000).toString(36)}`;
const PW = "crawl-persist-pw-123";

function sessionOf(res: Response): string {
  const sc = res.headers["set-cookie"];
  const raw = typeof sc === "string" ? sc : Array.isArray(sc) ? sc[0] : undefined;
  const m = /serpvera_session=([^;]+)/.exec(raw ?? "");
  return m?.[1] ?? "";
}

interface Setup {
  cookie: string;
  orgId: string;
  projectId: string;
}

void describe("project crawl persists fixture-derived findings/evidence (real PostgreSQL)", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({
      driver: "postgres",
      auditSite: createFixtureSiteAuditRunner(),
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
    // Organizations cascade to projects/crawl_runs/findings/evidence.
    await withAdmin(async (c) => {
      await c.query(`DELETE FROM organizations WHERE name LIKE $1`, [`Crawl Org ${TAG}%`]);
      await c.query(`DELETE FROM users WHERE email LIKE $1`, [`crawl%${TAG}%@test.local`]);
    });
  });

  async function setup(tag: "a" | "b", domain: string): Promise<Setup> {
    // Unique per invocation: this helper is called multiple times per suite and
    // email/slug constraints are global (a reused TAG would 409 on the 2nd call).
    const uid = randomUUID().slice(0, 8);
    const email = `crawl${tag}${TAG}${uid}@test.local`;
    const reg = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password: PW },
    });
    assert.equal(reg.statusCode, 201, reg.body);
    const cookie1 = sessionOf(reg);

    const org = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      payload: {
        name: `Crawl Org ${TAG} ${tag.toUpperCase()}`,
        slug: `crawl-${tag}-${TAG}-${uid}`,
      },
      headers: { cookie: `serpvera_session=${cookie1}` },
    });
    assert.equal(org.statusCode, 201, org.body);
    const orgId = (JSON.parse(org.body) as { organization: { id: string } }).organization.id;

    // Rotation: select-organization issues a fresh token carrying the tenant.
    const sel = await app.inject({
      method: "POST",
      url: "/v1/auth/select-organization",
      payload: { organizationId: orgId },
      headers: { cookie: `serpvera_session=${cookie1}` },
    });
    assert.equal(sel.statusCode, 200, sel.body);
    const cookie = sessionOf(sel);

    const proj = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { organizationId: orgId, primaryDomain: domain },
      headers: { cookie: `serpvera_session=${cookie}` },
    });
    assert.equal(proj.statusCode, 201, proj.body);
    const projectId = (JSON.parse(proj.body) as { project: { id: string } }).project.id;

    return { cookie, orgId, projectId };
  }

  /** Wait until the worker has FULLY persisted: findings AND evidence AND the
   *  run terminal. Polling findings alone races the worker (findings are
   *  inserted before evidence) and lets teardown close the pool mid-write. */
  async function waitUntilPersisted(cookie: string, projectId: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const f = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/findings`,
        headers: { cookie: `serpvera_session=${cookie}` },
      });
      const findings = (JSON.parse(f.body) as { findings: unknown[] }).findings;
      if (findings.length === 0) continue;
      const e = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/evidence`,
        headers: { cookie: `serpvera_session=${cookie}` },
      });
      const evidence = (JSON.parse(e.body) as { evidence: unknown[] }).evidence;
      if (evidence.length === 0) continue;
      const r = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/crawl-runs`,
        headers: { cookie: `serpvera_session=${cookie}` },
      });
      const runs = (JSON.parse(r.body) as { crawlRuns: { status: string }[] }).crawlRuns;
      if (runs[0]?.status === "completed" || runs[0]?.status === "failed") return;
    }
    throw new Error("worker did not finish persisting within the time budget");
  }

  void it("crawl run writes findings + evidence rows, and GET /findings returns them (tenant-scoped)", async () => {
    const a = await setup("a", "audit-fixture.test");

    // Trigger the real authenticated route; only its fetched document is fixture-controlled.
    const run = await app.inject({
      method: "POST",
      url: `/v1/projects/${a.projectId}/crawl-runs`,
      headers: { cookie: `serpvera_session=${a.cookie}` },
    });
    assert.equal(run.statusCode, 201, run.body);
    const runId = (JSON.parse(run.body) as { crawlRun: { id: string } }).crawlRun.id;
    assert.ok(runId, "crawl run id must be returned");

    // Wait for the FULL persistence (findings + evidence + terminal run).
    await waitUntilPersisted(a.cookie, a.projectId);

    const historyResponse = await app.inject({
      method: "GET",
      url: `/v1/projects/${a.projectId}/crawl-runs`,
      headers: { cookie: `serpvera_session=${a.cookie}` },
    });
    assert.equal(historyResponse.statusCode, 200, historyResponse.body);
    const history = JSON.parse(historyResponse.body) as {
      crawlRuns: {
        id: string;
        templateGroups: { pageCount: number; sampleUrls: string[] }[] | null;
      }[];
    };
    const observedRun = history.crawlRuns.find((item) => item.id === runId);
    assert.ok(observedRun?.templateGroups?.length, "API history returns observed page groups");
    assert.equal(
      observedRun.templateGroups.reduce((total, group) => total + group.pageCount, 0),
      2,
    );
    assert.ok(
      observedRun.templateGroups
        .flatMap((group) => group.sampleUrls)
        .every((url) => !/[?#]/.test(url)),
      "sample paths exclude query parameters and fragments",
    );

    const res = await app.inject({
      method: "GET",
      url: `/v1/projects/${a.projectId}/findings`,
      headers: { cookie: `serpvera_session=${a.cookie}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    const findings = (JSON.parse(res.body) as { findings: unknown[] }).findings;
    assert.ok(findings.length > 0, "worker must persist at least one finding");
    const f0 = findings[0] as Record<string, unknown>;
    assert.ok(f0.ruleId, "finding must carry ruleId");
    assert.equal(f0.epistemicClass, "OBSERVED", "findings are OBSERVED (no invented certainty)");
    assert.ok(f0.ruleVersion, "finding must carry ruleVersion for reproducibility");

    // ── SQL-level proof (admin bypass control): rows really exist with the
    // tenant's organization_id, and evidence carries a content hash. ──
    const fRows = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n, min(organization_id::text) AS org, min(rule_version) AS rv
           FROM findings WHERE project_id = $1`,
        [a.projectId],
      );
      return r.rows[0] as { n: number; org: string; rv: string | null };
    });
    assert.ok(fRows.n > 0, "findings rows must exist in PostgreSQL");
    assert.equal(fRows.org, a.orgId, "findings must be owned by the tenant org");
    assert.ok(fRows.rv, "persisted findings must carry rule_version");

    const eRows = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE content_hash <> '')::int AS hashed,
                min(organization_id::text) AS org
           FROM evidence_items WHERE project_id = $1`,
        [a.projectId],
      );
      return r.rows[0] as { n: number; hashed: number; org: string };
    });
    assert.ok(eRows.n > 0, "evidence_items rows must exist");
    assert.equal(eRows.hashed, eRows.n, "every evidence row must carry a content hash");
    assert.equal(eRows.org, a.orgId, "evidence must be owned by the tenant org");
    assert.equal(
      eRows.n,
      2,
      "fixture site crawl must persist one evidence item for each observed URL",
    );

    const relationRows = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE e.source_ref = ANY(f.affected_urls))::int AS same_url
           FROM finding_evidence fe
           JOIN findings f ON f.id = fe.finding_id
           JOIN evidence_items e ON e.id = fe.evidence_id
          WHERE f.project_id = $1`,
        [a.projectId],
      );
      return r.rows[0] as { n: number; same_url: number };
    });
    assert.ok(relationRows.n > 0, "findings must link to page evidence");
    assert.equal(
      relationRows.same_url,
      relationRows.n,
      "each page finding must link only to evidence from that same URL",
    );

    // Crawl run reached a terminal state.
    const runRow = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT status, pages_crawled, page_limit, stop_reason, template_groups
           FROM crawl_runs WHERE id = $1`,
        [runId],
      );
      return r.rows[0] as
        | {
            status: string;
            pages_crawled: number;
            page_limit: number | null;
            stop_reason: string | null;
            template_groups: { id: string; pageCount: number }[] | null;
          }
        | undefined;
    });
    assert.ok(runRow, "crawl run should be persisted");
    assert.equal(runRow.status, "completed", "crawl run must complete");
    assert.equal(runRow.pages_crawled, 2, "run totals must report every observed page");
    assert.equal(runRow.page_limit, 50, "the applied crawl cap must be persisted");
    assert.equal(runRow.stop_reason, null, "an exhausted fixture queue has no stop condition");
    assert.ok(runRow.template_groups?.length, "observed structure groups must be persisted");
    assert.equal(
      runRow.template_groups.reduce((total, group) => total + group.pageCount, 0),
      2,
      "group support must account for observed pages",
    );
  });

  void it("admits only one active crawl for a project across concurrent requests", async () => {
    const tenant = await setup("a", "audit-fixture.test");
    const runClaims = await Promise.all([
      app.stores.crawl.createCrawlRun(tenant.orgId, tenant.projectId, "HTTP_FAST"),
      app.stores.crawl.createCrawlRun(tenant.orgId, tenant.projectId, "HTTP_FAST"),
    ]);
    assert.equal(runClaims.filter(Boolean).length, 1);
    assert.equal(runClaims.filter((run) => run === null).length, 1);

    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${tenant.projectId}/crawl-runs`,
      headers: { cookie: `serpvera_session=${tenant.cookie}` },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(
      (JSON.parse(response.body) as { error: { code: string } }).error.code,
      "CRAWL_ALREADY_RUNNING",
    );
  });

  void it("returns the organization quota unit when active-run admission rejects", async () => {
    const tenant = await setup("b", "rejected-admission-fixture.test");
    const activeRun = await app.stores.crawl.createCrawlRun(
      tenant.orgId,
      tenant.projectId,
      "HTTP_FAST",
    );
    assert.ok(activeRun);

    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${tenant.projectId}/crawl-runs`,
      headers: { cookie: `serpvera_session=${tenant.cookie}` },
    });
    assert.equal(response.statusCode, 409, response.body);

    const reservations = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.stores.rateLimits.hit(tenant.orgId, 10, "project-crawl-org"),
      ),
    );
    assert.ok(reservations.every((reservation) => reservation.allowed));
  });

  void it("enforces a shared per-organization crawl quota before creating a run", async () => {
    const tenant = await setup("b", "quota-fixture.test");
    for (let attempt = 0; attempt < 10; attempt++) {
      const decision = await app.stores.rateLimits.hit(tenant.orgId, 10, "project-crawl-org");
      assert.equal(decision.allowed, true);
    }

    const response = await app.inject({
      method: "POST",
      url: `/v1/projects/${tenant.projectId}/crawl-runs`,
      headers: { cookie: `serpvera_session=${tenant.cookie}` },
    });
    assert.equal(response.statusCode, 429, response.body);
    assert.equal(
      (JSON.parse(response.body) as { error: { code: string } }).error.code,
      "CRAWL_RATE_LIMITED",
    );
    assert.equal(
      (await app.stores.crawl.listCrawlRuns(tenant.orgId, tenant.projectId)).length,
      0,
      "rate-limited requests must not create crawl runs",
    );
  });

  void it("a foreign tenant gets 404 for the crawl/findings routes (no existence leak)", async () => {
    const a = await setup("a", "audit-fixture.test");
    const b = await setup("b", "other-fixture.test");

    // A must have persisted rows first — otherwise "B sees nothing" could be vacuous
    // (no data at all) instead of proving isolation.
    const run = await app.inject({
      method: "POST",
      url: `/v1/projects/${a.projectId}/crawl-runs`,
      headers: { cookie: `serpvera_session=${a.cookie}` },
    });
    assert.equal(run.statusCode, 201, run.body);

    let aCount = 0;
    for (let i = 0; i < 40 && aCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const res = await app.inject({
        method: "GET",
        url: `/v1/projects/${a.projectId}/findings`,
        headers: { cookie: `serpvera_session=${a.cookie}` },
      });
      aCount = (JSON.parse(res.body) as { findings: unknown[] }).findings.length;
    }
    assert.ok(aCount > 0, "tenant A must have persisted findings before the negative checks");
    // Let the worker finish evidence + links before any teardown closes the pool.
    await waitUntilPersisted(a.cookie, a.projectId);

    const cross = await app.inject({
      method: "GET",
      url: `/v1/projects/${a.projectId}/findings`,
      headers: { cookie: `serpvera_session=${b.cookie}` },
    });
    assert.equal(cross.statusCode, 404, "cross-tenant findings read must be 404");

    const crossRun = await app.inject({
      method: "POST",
      url: `/v1/projects/${a.projectId}/crawl-runs`,
      headers: { cookie: `serpvera_session=${b.cookie}` },
    });
    assert.equal(crossRun.statusCode, 404, "cross-tenant crawl trigger must be 404");

    const crossHistory = await app.inject({
      method: "GET",
      url: `/v1/projects/${a.projectId}/crawl-runs`,
      headers: { cookie: `serpvera_session=${b.cookie}` },
    });
    assert.equal(
      crossHistory.statusCode,
      404,
      "cross-tenant history and structure groups must be 404",
    );

    // B's own project query returns zero rows (its own, empty ledger).
    const own = await app.inject({
      method: "GET",
      url: `/v1/projects/${b.projectId}/findings`,
      headers: { cookie: `serpvera_session=${b.cookie}` },
    });
    assert.equal(own.statusCode, 200);
    const body = JSON.parse(own.body) as { findings: unknown[] };
    assert.equal(body.findings.length, 0, "B must see no A findings");

    // POSITIVE CONTROL (admin bypass): A's rows DO exist — so B's 404/0 above
    // is genuine isolation, not absence of data.
    const visible = await withAdmin(async (c) => {
      const r = await c.query(`SELECT count(*)::int AS n FROM findings WHERE project_id = $1`, [
        a.projectId,
      ]);
      return (r.rows[0] as { n: number }).n;
    });
    assert.ok(visible > 0, "admin must see A's findings rows (control — data exists)");
  });
});
