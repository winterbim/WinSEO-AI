import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  closePool,
  configurePool,
  createAiVisibilityImport,
  AiVisibilityPermissionError,
  createOrganization,
  createProject,
  createUser,
  getAiVisibilityImport,
  healthCheck,
  listAiVisibilityCaptures,
  listAiVisibilityImports,
  listAiVisibilityStats,
  withAdmin,
  withTenant,
} from "./index.ts";

const TAG = `aivisrls${process.pid}_${randomUUID().slice(0, 8)}`;
const HASH = "1".repeat(64);

void describe("AI visibility persistence and forced tenant RLS (real PostgreSQL)", () => {
  let orgA = "";
  let orgB = "";
  let projectA = "";
  let otherProjectA = "";
  let projectB = "";
  let importA = "";
  let viewerUserId = "";

  before(async () => {
    configurePool({
      host: process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
      database: process.env.PGDATABASE ?? "serpvera_dev",
      runtimeRole: "serpvera_app",
      maxPool: 4,
    });
    assert.ok(await healthCheck(), "PostgreSQL must be available for the RLS test");

    const userA = await createUser(`${TAG}-a@test.local`, "test-hash-a");
    const userB = await createUser(`${TAG}-b@test.local`, "test-hash-b");
    const viewer = await createUser(`${TAG}-viewer@test.local`, "test-hash-viewer");
    const tenantA = await createOrganization(userA.id, `AI Visibility A ${TAG}`, `aivis-a-${TAG}`);
    const tenantB = await createOrganization(userB.id, `AI Visibility B ${TAG}`, `aivis-b-${TAG}`);
    orgA = tenantA.id;
    orgB = tenantB.id;
    viewerUserId = viewer.id;
    await withAdmin(async (client) => {
      await client.query(
        "INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, 'VIEWER')",
        [viewerUserId, orgA],
      );
    });
    const projA = await createProject(orgA, "AI Visibility project A", "aivis-a.example.com");
    const projA2 = await createProject(orgA, "AI Visibility project A2", "aivis-a2.example.com");
    const projB = await createProject(orgB, "AI Visibility project B", "aivis-b.example.com");
    projectA = projA.id;
    otherProjectA = projA2.id;
    projectB = projB.id;

    const imported = await createAiVisibilityImport({
      organizationId: orgA,
      projectId: projectA,
      uploadedBy: userA.id,
      csvSha256: HASH,
      captures: [
        {
          engine: "ChatGPT",
          promptId: "comparison-1",
          brandMentioned: true,
          clientCited: true,
          citationDomains: ["example.com", "source.org"],
          sampledAt: "2026-10-01T08:30:00.000Z",
        },
        {
          engine: "ChatGPT",
          promptId: "comparison-1",
          brandMentioned: false,
          clientCited: false,
          citationDomains: ["source.org"],
        },
        {
          engine: "Claude",
          promptId: "comparison-1",
          brandMentioned: true,
          clientCited: false,
          citationDomains: [],
        },
      ],
    });
    importA = imported.id;
  });

  after(async () => {
    try {
      await withAdmin(async (client) => {
        if (orgA) await client.query("DELETE FROM organizations WHERE id = $1", [orgA]);
        if (orgB) await client.query("DELETE FROM organizations WHERE id = $1", [orgB]);
        await client.query("DELETE FROM users WHERE email LIKE $1", [`${TAG}%@test.local`]);
      });
    } finally {
      await closePool();
    }
  });

  void it("stores provenance, captures, and aggregate stats from persisted rows", async () => {
    const imported = await getAiVisibilityImport(orgA, projectA, importA);
    assert.ok(imported);
    assert.equal(imported.row_count, 3);
    assert.equal(imported.provenance, "USER_SUPPLIED");
    assert.equal(imported.epistemic_class, "DOCUMENTED");
    assert.equal(imported.unverified_by_provider, true);

    const captures = await listAiVisibilityCaptures(orgA, projectA, importA);
    assert.equal(captures.length, 3);
    assert.equal(captures[0]?.row_number, 1);
    assert.equal(captures[1]?.sampled_at.toISOString(), imported.created_at.toISOString());

    const stats = await listAiVisibilityStats(orgA, projectA, importA);
    assert.deepEqual(
      stats.map(({ engine, promptId, runs, mentionRate, citationRate, uniqueCitationDomains }) => ({
        engine,
        promptId,
        runs,
        mentionRate,
        citationRate,
        uniqueCitationDomains,
      })),
      [
        {
          engine: "ChatGPT",
          promptId: "comparison-1",
          runs: 2,
          mentionRate: 0.5,
          citationRate: 0.5,
          uniqueCitationDomains: 2,
        },
        {
          engine: "Claude",
          promptId: "comparison-1",
          runs: 1,
          mentionRate: 1,
          citationRate: 0,
          uniqueCitationDomains: 0,
        },
      ],
    );
  });

  void it("checks evidence.write inside the persistence transaction", async () => {
    await assert.rejects(
      () =>
        createAiVisibilityImport({
          organizationId: orgA,
          projectId: otherProjectA,
          uploadedBy: viewerUserId,
          csvSha256: "2".repeat(64),
          captures: [
            {
              engine: "ChatGPT",
              promptId: "unauthorized",
              brandMentioned: false,
              clientCited: false,
              citationDomains: [],
            },
          ],
        }),
      AiVisibilityPermissionError,
    );
  });

  void it("hides tenant A rows from tenant B even without application predicates", async () => {
    const counts = await withTenant(orgB, async (client) => {
      const result = await client.query<{ imports: number; captures: number }>(
        `SELECT (SELECT count(*)::int FROM ai_visibility_imports) AS imports,
                (SELECT count(*)::int FROM ai_visibility_captures) AS captures`,
      );
      return result.rows[0];
    });
    assert.deepEqual(counts, { imports: 0, captures: 0 });
    assert.equal(
      await listAiVisibilityImports(orgB, projectB, 50, 0).then((rows) => rows.length),
      0,
    );
    assert.equal(await getAiVisibilityImport(orgB, projectB, importA), null);
    assert.deepEqual(await listAiVisibilityStats(orgB, projectB, importA), []);
  });

  void it("enforces RLS WITH CHECK and composite project/import integrity", async () => {
    await assert.rejects(
      withTenant(orgB, async (client) =>
        client.query(
          `INSERT INTO ai_visibility_imports
             (organization_id, project_id, uploaded_by, csv_sha256, row_count)
           VALUES ($1, $2, NULL, $3, 1)`,
          [orgA, projectA, "2".repeat(64)],
        ),
      ),
      /row-level security|policy/i,
    );

    await assert.rejects(
      withTenant(orgA, async (client) =>
        client.query(
          `INSERT INTO ai_visibility_captures
             (organization_id, project_id, import_id, row_number, engine, prompt_id,
              brand_mentioned, client_cited, sampled_at)
           VALUES ($1, $2, $3, 1, 'ChatGPT', 'cross-project', FALSE, FALSE, now())`,
          [orgA, otherProjectA, importA],
        ),
      ),
      /foreign key|violates/i,
    );

    const rlsFlags = await withAdmin(async (client) => {
      const res = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c
          WHERE c.oid = 'ai_visibility_imports'::regclass`,
      );
      return res.rows[0];
    });
    assert.deepEqual(rlsFlags, { relrowsecurity: true, relforcerowsecurity: true });
  });
});
