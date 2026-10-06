// Action Center production gate: real Fastify routes + real PostgreSQL/RLS.
// Fixture setup uses the same tenant-scoped stores as production; only the
// post-measurement crawl completion is inserted as an admin control so the
// deterministic recrawl gate can be exercised without doing network I/O.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Response } from "light-my-request";
import { buildApp } from "./server.ts";
import { withAdmin } from "@serpvera/db";

const TAG = `action${process.pid}${(Date.now() % 100_000).toString(36)}`;
const PW = "action-center-pw-123";

function sessionOf(res: Response): string {
  const header = res.headers["set-cookie"];
  const raw = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
  return /serpvera_session=([^;]+)/.exec(raw ?? "")?.[1] ?? "";
}

void describe("Action Center API + verification loop (real PostgreSQL)", () => {
  let app: FastifyInstance;
  const ctx: {
    orgA?: string;
    projectA?: string;
    cookieA?: string;
    cookieB?: string;
    action?: string;
    actionNoEvidence?: string;
    concurrentAction?: string;
  } = {};

  async function inject(method: "GET" | "POST", url: string, cookie?: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      ...(cookie ? { headers: { cookie: `serpvera_session=${cookie}` } } : {}),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  }

  async function tenant(tag: "a" | "b") {
    const suffix = randomUUID().slice(0, 8);
    const reg = await inject("POST", "/v1/auth/register", undefined, {
      email: `${tag}${TAG}${suffix}@test.local`,
      password: PW,
    });
    assert.equal(reg.statusCode, 201, reg.body);
    const baseCookie = sessionOf(reg);
    const org = await inject("POST", "/v1/organizations", baseCookie, {
      name: `Action Org ${TAG} ${tag}`,
      slug: `action-${TAG}-${tag}-${suffix}`,
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

  async function fixtureAction(withEvidence: boolean): Promise<string> {
    assert.ok(ctx.orgA, "org A must be seeded before creating actions");
    assert.ok(ctx.projectA, "project A must be seeded before creating actions");
    const organizationId = ctx.orgA;
    const projectId = ctx.projectA;
    const finding = await app.stores.crawl.addFinding(organizationId, projectId, {
      ruleId: `TEST.ACTION.${randomUUID()}`,
      ruleVersion: "1.0.0",
      title: withEvidence ? "Evidence-backed action" : "Action missing evidence",
      epistemicClass: "OBSERVED",
      severity: "high",
      explanation: "Deterministic test observation.",
      recommendation: "Apply the deterministic fixture correction.",
      affectedUrls: ["https://example.com/fixture"],
      verificationGate: "recrawl_rule_absent",
    });
    if (withEvidence) {
      const evidence = await app.stores.crawl.addEvidence(organizationId, projectId, {
        kind: "html_snapshot",
        sourceRef: "https://example.com/fixture",
        contentHash: "a".repeat(64),
        objectKey: `${organizationId}/${projectId}/fixture/${randomUUID()}`,
        metadata: { summary: "Fixture evidence" },
      });
      await app.stores.crawl.linkFindingEvidence(organizationId, finding.id, evidence.id);
    }
    return (await app.stores.crawl.createDetectedAction(organizationId, projectId, finding.id)).id;
  }

  before(async () => {
    app = await buildApp({ driver: "postgres", maxPool: 6 });
    await app.ready();
    const a = await tenant("a");
    const b = await tenant("b");
    ctx.orgA = a.organizationId;
    ctx.cookieA = a.cookie;
    ctx.cookieB = b.cookie;
    const project = await inject("POST", "/v1/projects", a.cookie, {
      organizationId: a.organizationId,
      name: "Action Center Fixture",
      primaryDomain: "example.com",
    });
    assert.equal(project.statusCode, 201, project.body);
    ctx.projectA = (JSON.parse(project.body) as { project: { id: string } }).project.id;
    ctx.action = await fixtureAction(true);
    ctx.actionNoEvidence = await fixtureAction(false);
    ctx.concurrentAction = await fixtureAction(true);
  });

  after(async () => {
    await withAdmin(async (client) => {
      await client.query(`DELETE FROM organizations WHERE name LIKE $1`, [`Action Org ${TAG}%`]);
      await client.query(`DELETE FROM users WHERE email LIKE $1`, [`%${TAG}%@test.local`]);
    });
    await app.close();
  });

  void it("rejects an action without evidence", async () => {
    const res = await inject(
      "POST",
      `/v1/actions/${ctx.actionNoEvidence}/transitions`,
      ctx.cookieA,
      { expectedVersion: 1, toState: "EVIDENCED" },
    );
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(
      (JSON.parse(res.body) as { error: { code: string } }).error.code,
      "EVIDENCE_REQUIRED",
    );
  });

  void it("rejects the former IMPLEMENTED label because it did not prove a site write", async () => {
    const res = await inject(
      "POST",
      `/v1/actions/${ctx.action}/transitions`,
      ctx.cookieA,
      { expectedVersion: 1, toState: "IMPLEMENTED" },
    );
    assert.equal(res.statusCode, 400, res.body);
  });

  void it("protects concurrent transitions and audits explicit recommendation rejection", async () => {
    const [first, second] = await Promise.all([
      inject("POST", `/v1/actions/${ctx.concurrentAction}/transitions`, ctx.cookieA, {
        expectedVersion: 1,
        toState: "EVIDENCED",
      }),
      inject("POST", `/v1/actions/${ctx.concurrentAction}/transitions`, ctx.cookieA, {
        expectedVersion: 1,
        toState: "EVIDENCED",
      }),
    ]);
    assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 409]);
    const conflict = first.statusCode === 409 ? first : second;
    assert.equal(
      (JSON.parse(conflict.body) as { error: { code: string } }).error.code,
      "VERSION_CONFLICT",
    );

    const proposed = await inject(
      "POST",
      `/v1/actions/${ctx.concurrentAction}/transitions`,
      ctx.cookieA,
      {
        expectedVersion: 2,
        toState: "PROPOSED",
        recommendation: {
          summary: "A recommendation that requires human review.",
          verificationGate: { type: "recrawl_rule_absent", spec: {} },
        },
      },
    );
    assert.equal(proposed.statusCode, 200, proposed.body);

    const rejectedProposal = await inject(
      "POST",
      `/v1/actions/${ctx.concurrentAction}/transitions`,
      ctx.cookieA,
      {
        expectedVersion: 3,
        toState: "REJECT_PROPOSAL",
        approvalDecision: "REJECT",
        note: "The proposed change is too broad; refine its scope.",
      },
    );
    assert.equal(rejectedProposal.statusCode, 200, rejectedProposal.body);
    const rejectedAction = (
      JSON.parse(rejectedProposal.body) as {
        action: { state: string; history: { payload: Record<string, unknown> }[] };
      }
    ).action;
    assert.equal(rejectedAction.state, "EVIDENCED");
    assert.equal(rejectedAction.history.at(-1)?.payload.approvalDecision, "REJECT");
    assert.equal(
      rejectedAction.history.at(-1)?.payload.note,
      "The proposed change is too broad; refine its scope.",
    );
  });

  void it("rejects implementation without approval, rejects verification without measurement, and computes VERIFIED from the declared gate", async () => {
    const evidenced = await inject("POST", `/v1/actions/${ctx.action}/transitions`, ctx.cookieA, {
      expectedVersion: 1,
      toState: "EVIDENCED",
    });
    assert.equal(evidenced.statusCode, 200, evidenced.body);

    const manualInconclusive = await inject(
      "POST",
      `/v1/actions/${ctx.action}/transitions`,
      ctx.cookieA,
      { expectedVersion: 2, toState: "INCONCLUSIVE" },
    );
    assert.equal(manualInconclusive.statusCode, 409, manualInconclusive.body);
    assert.equal(
      (JSON.parse(manualInconclusive.body) as { error: { code: string } }).error.code,
      "INVALID_TRANSITION",
    );

    const proposed = await inject("POST", `/v1/actions/${ctx.action}/transitions`, ctx.cookieA, {
      expectedVersion: 2,
      toState: "PROPOSED",
      recommendation: {
        summary: "Correct the observed markup defect.",
        rationale: "The persisted HTML evidence demonstrates the defect.",
        verificationGate: { type: "recrawl_rule_absent", spec: {} },
      },
    });
    assert.equal(proposed.statusCode, 200, proposed.body);

    const skippedApproval = await inject(
      "POST",
      `/v1/actions/${ctx.action}/transitions`,
      ctx.cookieA,
      {
        expectedVersion: 3,
        toState: "REPORTED_MANUALLY",
        implementation: { whatChanged: "x", how: "y" },
        rollback: { strategy: "revert" },
      },
    );
    assert.equal(skippedApproval.statusCode, 409, skippedApproval.body);
    assert.equal(
      (JSON.parse(skippedApproval.body) as { error: { code: string } }).error.code,
      "INVALID_TRANSITION",
    );

    const approved = await inject("POST", `/v1/actions/${ctx.action}/transitions`, ctx.cookieA, {
      expectedVersion: 3,
      toState: "APPROVED",
      approvalDecision: "APPROVE",
    });
    assert.equal(approved.statusCode, 200, approved.body);

    const reported = await inject("POST", `/v1/actions/${ctx.action}/transitions`, ctx.cookieA, {
      expectedVersion: 4,
      toState: "REPORTED_MANUALLY",
      implementation: {
        whatChanged: "Added the missing deterministic markup.",
        how: "Production deployment release-42.",
        references: ["release-42"],
      },
      rollback: {
        strategy: "Revert release-42.",
        trigger: "Regression detected by the same crawl rule.",
      },
    });
    assert.equal(reported.statusCode, 200, reported.body);
    const reportedAction = (
      JSON.parse(reported.body) as {
        action: { state: string; rollback: unknown; implementation: Record<string, unknown> };
      }
    ).action;
    assert.equal(reportedAction.state, "REPORTED_MANUALLY");
    assert.ok(reportedAction.rollback, "manual rollback instructions must round-trip");
    assert.ok("reportedAt" in reportedAction.implementation, "report time is explicit");

    const verificationWithoutMeasurement = await inject(
      "POST",
      `/v1/actions/${ctx.action}/transitions`,
      ctx.cookieA,
      { expectedVersion: 5, toState: "VERIFIED" },
    );
    assert.equal(verificationWithoutMeasurement.statusCode, 409);
    assert.equal(
      (JSON.parse(verificationWithoutMeasurement.body) as { error: { code: string } }).error.code,
      "INVALID_TRANSITION",
    );

    const startsAt = new Date(Date.now() - 1_000).toISOString();
    const endsAt = new Date(Date.now() + 60_000).toISOString();
    const measuring = await inject("POST", `/v1/actions/${ctx.action}/transitions`, ctx.cookieA, {
      expectedVersion: 5,
      toState: "MEASURING",
      baselineSnapshot: { matchingFindingCount: 1, capturedFrom: "initial crawl" },
      comparisonWindow: { startsAt, endsAt },
    });
    assert.equal(measuring.statusCode, 200, measuring.body);

    // A completed comparison crawl with no occurrence of this action's rule.
    await withAdmin(async (client) => {
      await client.query(
        `INSERT INTO crawl_runs
           (organization_id, project_id, mode, seed_strategy, status, started_at, completed_at)
         VALUES ($1, $2, 'HTTP_FAST', 'SITEMAP', 'completed', now(), now())`,
        [ctx.orgA, ctx.projectA],
      );
    });

    const verified = await inject("POST", `/v1/actions/${ctx.action}/transitions`, ctx.cookieA, {
      expectedVersion: 6,
      toState: "EVALUATE",
    });
    assert.equal(verified.statusCode, 200, verified.body);
    const verifiedAction = (
      JSON.parse(verified.body) as {
        action: {
          state: string;
          verification: { verdict: string; matchingFindingCount: number };
          history: unknown[];
        };
      }
    ).action;
    assert.equal(verifiedAction.state, "VERIFIED");
    assert.equal(verifiedAction.verification.verdict, "PASS");
    assert.equal(verifiedAction.verification.matchingFindingCount, 0);
    assert.equal(
      verifiedAction.history.length,
      6,
      "every accepted transition is immutable history",
    );

    const closed = await inject("POST", `/v1/actions/${ctx.action}/transitions`, ctx.cookieA, {
      expectedVersion: 7,
      toState: "CLOSED",
      note: "Outcome reviewed and closed.",
    });
    assert.equal(closed.statusCode, 200, closed.body);
  });

  void it("returns uniform 404 for cross-tenant action reads and writes", async () => {
    const read = await inject("GET", `/v1/actions/${ctx.action}`, ctx.cookieB);
    assert.equal(read.statusCode, 404, read.body);
    const write = await inject("POST", `/v1/actions/${ctx.action}/transitions`, ctx.cookieB, {
      expectedVersion: 8,
      toState: "CLOSED",
    });
    assert.equal(write.statusCode, 404, write.body);
  });

  void it("keeps audit history append-only at the database boundary", async () => {
    const historyId = await withAdmin(async (client) => {
      const row = await client.query<{ id: string }>(
        `SELECT id FROM action_transitions WHERE action_id = $1 ORDER BY action_version LIMIT 1`,
        [ctx.action],
      );
      return row.rows[0]?.id;
    });
    assert.ok(historyId, "positive control: transition history exists");
    await assert.rejects(
      () =>
        withAdmin(async (client) => {
          await client.query(`UPDATE action_transitions SET payload = '{}' WHERE id = $1`, [
            historyId,
          ]);
        }),
      /append-only|forbidden/i,
    );
  });
});
