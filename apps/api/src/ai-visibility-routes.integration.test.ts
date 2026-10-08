import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Response } from "light-my-request";
import { withAdmin } from "@serpvera/db";
import { buildApp } from "./server.ts";

const TAG = `aivis${process.pid}_${randomUUID().slice(0, 8)}`;
const PASSWORD = "ai-visibility-test-password";
const CSV = [
  "engine,prompt_id,brand_mentioned,client_cited,citation_domains,sampled_at",
  "ChatGPT,brand-comparison,true,true,example.com;source.org,2026-10-01T10:30:00+02:00",
  "ChatGPT,brand-comparison,false,false,source.org,",
  "Claude,brand-comparison,true,false,example.com,",
].join("\n");

function csvPayload(csvText: string): { csvText: string; csvSha256: string } {
  return {
    csvText,
    csvSha256: createHash("sha256").update(csvText, "utf8").digest("hex"),
  };
}

function sessionOf(res: Response): string {
  const header = res.headers["set-cookie"];
  const raw = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
  return /serpvera_session=([^;]+)/.exec(raw ?? "")?.[1] ?? "";
}

void describe("AI visibility imports (authenticated API + PostgreSQL)", () => {
  let app: FastifyInstance;
  const ctx: {
    orgA?: string;
    orgB?: string;
    projectA?: string;
    projectB?: string;
    cookieA?: string;
    cookieB?: string;
    viewerCookie?: string;
    billingCookie?: string;
    analystCookie?: string;
    analystUserId?: string;
    importId?: string;
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

  async function createTenant(tag: "a" | "b"): Promise<{ organizationId: string; cookie: string }> {
    const suffix = randomUUID().slice(0, 8);
    const registration = await inject("POST", "/v1/auth/register", undefined, {
      email: `${tag}-${TAG}-${suffix}@test.local`,
      password: PASSWORD,
    });
    assert.equal(registration.statusCode, 201, registration.body);
    const baseCookie = sessionOf(registration);
    const organization = await inject("POST", "/v1/organizations", baseCookie, {
      name: `AI Visibility ${TAG} ${tag}`,
      slug: `aivis-${TAG.replaceAll("_", "-")}-${tag}-${suffix}`,
    });
    assert.equal(organization.statusCode, 201, organization.body);
    const organizationId = (JSON.parse(organization.body) as { organization: { id: string } })
      .organization.id;
    const selected = await inject("POST", "/v1/auth/select-organization", baseCookie, {
      organizationId,
    });
    assert.equal(selected.statusCode, 200, selected.body);
    return { organizationId, cookie: sessionOf(selected) };
  }

  async function createProject(cookie: string, organizationId: string, suffix: string) {
    const response = await inject("POST", "/v1/projects", cookie, {
      organizationId,
      name: `AI Visibility Project ${suffix}`,
      primaryDomain: `${suffix}.example.com`,
    });
    assert.equal(response.statusCode, 201, response.body);
    return (JSON.parse(response.body) as { project: { id: string } }).project.id;
  }

  async function createMemberCookie(
    organizationId: string,
    role: "VIEWER" | "BILLING" | "ANALYST",
  ): Promise<{ cookie: string; userId: string }> {
    const suffix = randomUUID().slice(0, 8);
    const registration = await inject("POST", "/v1/auth/register", undefined, {
      email: `${role.toLowerCase()}-${TAG}-${suffix}@test.local`,
      password: PASSWORD,
    });
    assert.equal(registration.statusCode, 201, registration.body);
    const userId = (JSON.parse(registration.body) as { user: { id: string } }).user.id;
    await withAdmin(async (client) => {
      await client.query(
        "INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, $3)",
        [userId, organizationId, role],
      );
    });
    const selected = await inject("POST", "/v1/auth/select-organization", sessionOf(registration), {
      organizationId,
    });
    assert.equal(selected.statusCode, 200, selected.body);
    return { cookie: sessionOf(selected), userId };
  }

  before(async () => {
    app = await buildApp({ driver: "postgres", maxPool: 6 });
    await app.ready();
    const a = await createTenant("a");
    const b = await createTenant("b");
    ctx.orgA = a.organizationId;
    ctx.orgB = b.organizationId;
    ctx.cookieA = a.cookie;
    ctx.cookieB = b.cookie;
    ctx.projectA = await createProject(a.cookie, a.organizationId, "capture-a");
    ctx.projectB = await createProject(b.cookie, b.organizationId, "capture-b");
    ctx.viewerCookie = (await createMemberCookie(a.organizationId, "VIEWER")).cookie;
    ctx.billingCookie = (await createMemberCookie(a.organizationId, "BILLING")).cookie;
    const analyst = await createMemberCookie(a.organizationId, "ANALYST");
    ctx.analystCookie = analyst.cookie;
    ctx.analystUserId = analyst.userId;
  });

  after(async () => {
    try {
      await withAdmin(async (client) => {
        if (ctx.orgA) await client.query("DELETE FROM organizations WHERE id = $1", [ctx.orgA]);
        if (ctx.orgB) await client.query("DELETE FROM organizations WHERE id = $1", [ctx.orgB]);
        await client.query("DELETE FROM users WHERE email LIKE $1", [`%${TAG}%@test.local`]);
      });
    } finally {
      await app.close();
    }
  });

  void it("returns a genuine empty stats-only history without raw capture rows", async () => {
    assert.ok(ctx.projectA && ctx.cookieA);
    const response = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports?includeStats=true`,
      ctx.cookieA,
    );
    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body) as {
      imports: unknown[];
      dataAvailability: { source: string; promptPanelCompleteness: string };
    };
    assert.deepEqual(body.imports, []);
    assert.equal(body.dataAvailability.source, "USER_SUPPLIED");
    assert.equal(body.dataAvailability.promptPanelCompleteness, "UNKNOWN");
  });

  void it("persists the exact CSV hash and returns stored per-engine/prompt statistics", async () => {
    assert.ok(ctx.projectA && ctx.cookieA);
    const response = await inject(
      "POST",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports`,
      ctx.cookieA,
      csvPayload(CSV),
    );
    assert.equal(response.statusCode, 201, response.body);
    const body = JSON.parse(response.body) as {
      import: {
        id: string;
        csvSha256: string;
        hashVerified: boolean;
        rowCount: number;
        provenance: string;
        epistemicClass: string;
        unverified_by_provider: boolean;
      };
      stats: {
        engine: string;
        promptId: string;
        promptsObserved: number;
        runs: number;
        mentionCount: number;
        citationCount: number;
        mentionRate: number;
        mentionWilson95: [number, number];
        citationRate: number;
        citationWilson95: [number, number];
        uniqueCitationDomains: number;
        topCitationDomains: [string, number][];
      }[];
      dataAvailability: { promptPanelCompleteness: string; unverified_by_provider: boolean };
    };
    ctx.importId = body.import.id;
    assert.equal(body.import.csvSha256, createHash("sha256").update(CSV).digest("hex"));
    assert.equal(body.import.hashVerified, true);
    assert.equal(body.import.rowCount, 3);
    assert.equal(body.import.provenance, "USER_SUPPLIED");
    assert.equal(body.import.epistemicClass, "DOCUMENTED");
    assert.equal(body.import.unverified_by_provider, true);
    assert.deepEqual(body.stats, [
      {
        engine: "ChatGPT",
        promptId: "brand-comparison",
        runs: 2,
        mentionCount: 1,
        citationCount: 1,
        promptsObserved: 1,
        mentionRate: 0.5,
        mentionWilson95: [0.09452865480086614, 0.9054713451991339],
        citationRate: 0.5,
        citationWilson95: [0.09452865480086614, 0.9054713451991339],
        uniqueCitationDomains: 2,
        topCitationDomains: [
          ["source.org", 2],
          ["example.com", 1],
        ],
      },
      {
        engine: "Claude",
        promptId: "brand-comparison",
        runs: 1,
        mentionCount: 1,
        citationCount: 0,
        promptsObserved: 1,
        mentionRate: 1,
        mentionWilson95: [0.20654329147389294, 1],
        citationRate: 0,
        citationWilson95: [0, 0.7934567085261071],
        uniqueCitationDomains: 1,
        topCitationDomains: [["example.com", 1]],
      },
    ]);
    assert.equal(body.dataAvailability.promptPanelCompleteness, "UNKNOWN");
    assert.equal(body.dataAvailability.unverified_by_provider, true);

    const history = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports`,
      ctx.cookieA,
    );
    assert.equal(history.statusCode, 200, history.body);
    const historyBody = JSON.parse(history.body) as {
      imports: { id: string }[];
      dataAvailability: { promptPanelCompleteness: string };
    };
    assert.deepEqual(
      historyBody.imports.map((item) => item.id),
      [ctx.importId],
    );
    assert.equal(historyBody.dataAvailability.promptPanelCompleteness, "UNKNOWN");

    const reportHistory = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports?includeStats=true&limit=5`,
      ctx.cookieA,
    );
    assert.equal(reportHistory.statusCode, 200, reportHistory.body);
    const reportHistoryBody = JSON.parse(reportHistory.body) as {
      imports: {
        id: string;
        csvSha256: string;
        rowCount: number;
        createdAt: string;
        stats: { engine: string; promptId: string; runs: number; mentionCount: number }[];
        captures?: unknown[];
      }[];
      dataAvailability: {
        source: string;
        epistemicClass: string;
        unverified_by_provider: boolean;
        promptPanelCompleteness: string;
        basis: string;
      };
    };
    assert.equal(reportHistoryBody.imports.length, 1);
    const reportImport = reportHistoryBody.imports[0];
    assert.ok(reportImport);
    assert.equal(reportImport.id, ctx.importId);
    assert.equal(reportImport.csvSha256, body.import.csvSha256);
    assert.equal(reportImport.rowCount, 3);
    assert.ok(reportImport.createdAt);
    assert.deepEqual(
      reportImport.stats.map(({ engine, promptId, runs, mentionCount }) => ({
        engine,
        promptId,
        runs,
        mentionCount,
      })),
      [
        { engine: "ChatGPT", promptId: "brand-comparison", runs: 2, mentionCount: 1 },
        { engine: "Claude", promptId: "brand-comparison", runs: 1, mentionCount: 1 },
      ],
    );
    assert.equal(reportImport.captures, undefined);
    assert.deepEqual(reportHistoryBody.dataAvailability, {
      source: "USER_SUPPLIED",
      epistemicClass: "DOCUMENTED",
      unverified_by_provider: true,
      promptPanelCompleteness: "UNKNOWN",
      basis: "persisted imported captures only",
    });
    const oversizedReportHistory = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports?includeStats=true&limit=6`,
      ctx.cookieA,
    );
    assert.equal(oversizedReportHistory.statusCode, 400);

    const detail = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports/${ctx.importId}`,
      ctx.cookieA,
    );
    assert.equal(detail.statusCode, 200, detail.body);
    const detailBody = JSON.parse(detail.body) as { captures: { rowNumber: number }[] };
    assert.deepEqual(
      detailBody.captures.map((capture) => capture.rowNumber),
      [1, 2, 3],
    );

    const csv2 = CSV.replace("true,true,example.com", "false,true,example.com");
    const secondImport = await inject(
      "POST",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports`,
      ctx.cookieA,
      csvPayload(csv2),
    );
    assert.equal(secondImport.statusCode, 201, secondImport.body);
    const secondId = (JSON.parse(secondImport.body) as { import: { id: string } }).import.id;
    const comparison = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports?compare=${ctx.importId},${secondId}`,
      ctx.cookieA,
    );
    assert.equal(comparison.statusCode, 200, comparison.body);
    const comparisonBody = JSON.parse(comparison.body) as {
      comparisons: {
        import: { id: string; createdAt: string };
        stats: { engine: string; mentionCount: number; runs: number }[];
      }[];
    };
    assert.equal(comparisonBody.comparisons.length, 2);
    const [first, second] = comparisonBody.comparisons;
    assert.ok(first);
    assert.ok(second);
    assert.deepEqual(
      comparisonBody.comparisons.map(({ import: batch }) => batch.id).sort(),
      [ctx.importId, secondId].sort(),
    );
    assert.ok(first.import.createdAt <= second.import.createdAt);
    const firstStat = first.stats.find((stat) => stat.engine === "ChatGPT");
    const secondStat = second.stats.find((stat) => stat.engine === "ChatGPT");
    assert.ok(firstStat);
    assert.ok(secondStat);
    assert.equal(firstStat.runs, 2);
    assert.equal(secondStat.runs, 2);
    assert.notEqual(firstStat.mentionCount, secondStat.mentionCount);

    const ambiguousComparison = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports?compare=${ctx.importId},${secondId}&includeStats=true`,
      ctx.cookieA,
    );
    assert.equal(ambiguousComparison.statusCode, 400, ambiguousComparison.body);
  });

  void it("denies evidence imports to same-tenant VIEWER and BILLING roles", async () => {
    assert.ok(ctx.projectA && ctx.viewerCookie && ctx.billingCookie);
    for (const cookie of [ctx.viewerCookie, ctx.billingCookie]) {
      const response = await inject(
        "POST",
        `/v1/projects/${ctx.projectA}/ai-visibility/imports`,
        cookie,
        { ...csvPayload(CSV), csvSha256: "0".repeat(64) },
      );
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(
        (JSON.parse(response.body) as { error: { code: string } }).error.code,
        "FORBIDDEN",
      );
    }
  });

  void it("uses the current membership role after a session role is downgraded", async () => {
    assert.ok(ctx.projectA && ctx.orgA && ctx.analystCookie && ctx.analystUserId);
    await withAdmin(async (client) => {
      await client.query(
        "UPDATE memberships SET role = 'VIEWER' WHERE user_id = $1 AND organization_id = $2",
        [ctx.analystUserId, ctx.orgA],
      );
    });

    const response = await inject(
      "POST",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports`,
      ctx.analystCookie,
      csvPayload(CSV),
    );
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(
      (JSON.parse(response.body) as { error: { code: string } }).error.code,
      "FORBIDDEN",
    );
  });

  void it("rejects a false hash, malformed CSV, oversized CSV, and duplicate file", async () => {
    assert.ok(ctx.projectA && ctx.cookieA);
    const wrongHash = await inject(
      "POST",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports`,
      ctx.cookieA,
      { ...csvPayload(CSV), csvSha256: "0".repeat(64) },
    );
    assert.equal(wrongHash.statusCode, 400);
    assert.equal(
      (JSON.parse(wrongHash.body) as { error: { code: string } }).error.code,
      "CSV_HASH_MISMATCH",
    );

    const invalidCsv = "engine,prompt_id,brand_mentioned,client_cited\nChatGPT,p1,maybe,no";
    const invalid = await inject(
      "POST",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports`,
      ctx.cookieA,
      csvPayload(invalidCsv),
    );
    assert.equal(invalid.statusCode, 400);
    assert.equal(
      (JSON.parse(invalid.body) as { error: { code: string } }).error.code,
      "INVALID_CSV",
    );

    const oversizedCsv = "x".repeat(1_048_577);
    const oversized = await inject(
      "POST",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports`,
      ctx.cookieA,
      csvPayload(oversizedCsv),
    );
    assert.equal(oversized.statusCode, 413);

    const duplicate = await inject(
      "POST",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports`,
      ctx.cookieA,
      csvPayload(CSV),
    );
    assert.equal(duplicate.statusCode, 409);
  });

  void it("requires a session and hides project/import IDs across tenants", async () => {
    assert.ok(ctx.projectA && ctx.projectB && ctx.cookieA && ctx.cookieB && ctx.importId);
    const unauthenticated = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports`,
    );
    assert.equal(unauthenticated.statusCode, 401);

    const foreignProject = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports`,
      ctx.cookieB,
    );
    assert.equal(foreignProject.statusCode, 404);

    const foreignImport = await inject(
      "GET",
      `/v1/projects/${ctx.projectB}/ai-visibility/imports/${ctx.importId}`,
      ctx.cookieB,
    );
    assert.equal(foreignImport.statusCode, 404);

    const foreignReportHistory = await inject(
      "GET",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports?includeStats=true`,
      ctx.cookieB,
    );
    assert.equal(foreignReportHistory.statusCode, 404);

    const foreignWrite = await inject(
      "POST",
      `/v1/projects/${ctx.projectA}/ai-visibility/imports`,
      ctx.cookieB,
      csvPayload(CSV),
    );
    assert.equal(foreignWrite.statusCode, 404);
  });
});
