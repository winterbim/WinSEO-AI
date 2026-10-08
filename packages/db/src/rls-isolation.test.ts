// ─── DATABASE-LEVEL RLS ISOLATION TEST ───
// P-GAP-02, sections 5-8. This test hits a REAL PostgreSQL instance.
// It is NOT a mock and NOT an API-level test: every query runs as the runtime
// role `serpvera_app` (NOSUPERUSER, NOBYPASSRLS) inside withTenant(), so the
// PostgreSQL policy engine itself enforces isolation.
//
// Connection: unix-socket peer auth (host=/var/run/postgresql) so NO password
// or secret is committed. Runtime role enforced via SET LOCAL ROLE.
//
// Requires serpvera_dev to exist + migration applied. See docs/DEPLOYMENT.md.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  configurePool,
  closePool,
  withAdmin,
  withTenant,
  healthCheck,
  createUser,
  createOrganization,
  createProject,
  addEvidence,
  addFinding,
  getFindingEvidence,
  linkFindingEvidence,
  getProject,
  listProjects,
} from "./index.ts";

// Test-only identifiers; cleaned up in after().
const TAG = `rls_${process.pid}_${Date.now()}`;

const ctx: {
  orgA: string;
  orgB: string;
  projectA: string;
  projectB: string;
  findingA: string;
  findingB: string;
  evidenceA: string;
} = {
  orgA: "",
  orgB: "",
  projectA: "",
  projectB: "",
  findingA: "",
  findingB: "",
  evidenceA: "",
};

void describe("RLS isolation (real PostgreSQL)", () => {
  before(async () => {
    // Peer socket path: non-TCP => no password => no secret in repo.
    configurePool({
      host: process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
      database: process.env.PGDATABASE ?? "serpvera_dev",
      runtimeRole: "serpvera_app",
      maxPool: 4,
    });

    assert.ok(await healthCheck(), "database health check failed — is Postgres up?");

    // Verify the runtime role exists and is non-bypass BEFORE relying on it.
    const roleChecks = await withAdmin(async (c) => {
      const res = await c.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
      }>(
        `SELECT rolsuper, rolbypassrls, rolcanlogin
           FROM pg_roles WHERE rolname = 'serpvera_app'`,
      );
      return res.rows[0];
    });
    assert.ok(roleChecks, "runtime role serpvera_app must exist (run bootstrap.sql)");
    assert.equal(roleChecks.rolsuper, false, "runtime role must NOT be superuser");
    assert.equal(roleChecks.rolbypassrls, false, "runtime role must NOT bypass RLS");

    // Build two independent tenants with one project each (admin bootstrap).
    const userA = await createUser(`a_${TAG}@test.local`, "hash-a-not-real");
    const userB = await createUser(`b_${TAG}@test.local`, "hash-b-not-real");

    const orgRowA = await createOrganization(userA.id, `Alpha ${TAG}`, `alpha-${TAG}`);
    const orgRowB = await createOrganization(userB.id, `Beta ${TAG}`, `beta-${TAG}`);
    ctx.orgA = orgRowA.id;
    ctx.orgB = orgRowB.id;

    const projA = await createProject(ctx.orgA, "Alpha Site", "alpha.example.com");
    const projB = await createProject(ctx.orgB, "Beta Site", "beta.example.com");
    ctx.projectA = projA.id;
    ctx.projectB = projB.id;

    const finding = await addFinding({
      organization_id: ctx.orgA,
      project_id: ctx.projectA,
      rule_id: "TEST-LINK",
      rule_version: "1.0.0",
      title: "Alpha finding",
      epistemic_class: "OBSERVED",
      severity: "low",
    });
    const foreignTenantFinding = await addFinding({
      organization_id: ctx.orgB,
      project_id: ctx.projectB,
      rule_id: "TEST-LINK-B",
      rule_version: "1.0.0",
      title: "Beta finding",
      epistemic_class: "OBSERVED",
      severity: "low",
    });
    const evidence = await addEvidence({
      organization_id: ctx.orgA,
      project_id: ctx.projectA,
      kind: "http_response",
      source_ref: "https://alpha.example.com/",
      content_hash: "sha256:test-link-alpha",
      object_key: `${ctx.orgA}/${ctx.projectA}/test-link-alpha`,
    });
    ctx.findingA = finding.id;
    ctx.findingB = foreignTenantFinding.id;
    ctx.evidenceA = evidence.id;
    await linkFindingEvidence(ctx.orgA, finding.id, evidence.id);
  });

  after(async () => {
    // Clean up test tenants. organizations cascade to projects/memberships.
    try {
      await withAdmin(async (c) => {
        await c.query(`DELETE FROM users WHERE email LIKE $1`, [`%${TAG}@test.local`]);
        if (ctx.orgA) await c.query(`DELETE FROM organizations WHERE id = $1`, [ctx.orgA]);
        if (ctx.orgB) await c.query(`DELETE FROM organizations WHERE id = $1`, [ctx.orgB]);
      });
    } finally {
      await closePool();
    }
  });

  void it("DB-03a: tenant A sees exactly its own project", async () => {
    const list = await listProjects(ctx.orgA);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, ctx.projectA);
    // Narrowed by the element check above; plain access keeps both tsc and
    // eslint in agreement (noUncheckedIndexedAccess already proved the shape).
    assert.equal(list[0].organization_id, ctx.orgA);
  });

  void it("DB-03b: tenant A can read project A by id", async () => {
    const p = await getProject(ctx.orgA, ctx.projectA);
    assert.ok(p, "tenant A must see its own project");
    assert.equal(p.id, ctx.projectA);
  });

  void it("DB-03c: tenant A CANNOT read tenant B's project by id (RLS returns nothing)", async () => {
    // Under RLS, a foreign-tenant read is not an error — it simply yields 0 rows,
    // which is safer than a permission error (no existence leak).
    const p = await getProject(ctx.orgA, ctx.projectB);
    assert.equal(p, null, "tenant A must NOT see tenant B's project");
  });

  void it("DB-03d: tenant B CANNOT read tenant A's project (reverse direction)", async () => {
    const p = await getProject(ctx.orgB, ctx.projectA);
    assert.equal(p, null, "tenant B must NOT see tenant A's project");
  });

  void it("DB-03e: tenant B sees only its own project", async () => {
    const list = await listProjects(ctx.orgB);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, ctx.projectB);
  });

  void it("DB-03f: tenant A CANNOT INSERT a project into tenant B (WITH CHECK violation)", async () => {
    await assert.rejects(
      async () => {
        await withTenant(ctx.orgA, async (client) => {
          await client.query(
            `INSERT INTO projects (organization_id, name, primary_domain)
             VALUES ($1, $2, $3)`,
            [ctx.orgB, "Hostile", "hostile.example.com"],
          );
        });
      },
      /row-level security|violates row-level/i,
      "inserting another tenant's org_id must be rejected by RLS WITH CHECK",
    );
  });

  void it("DB-03g: tenant A CANNOT UPDATE tenant B's project", async () => {
    const updated = await withTenant(ctx.orgA, async (client) => {
      const res = await client.query(
        `UPDATE projects SET name = 'PWNED' WHERE id = $1 RETURNING id`,
        [ctx.projectB],
      );
      return res.rowCount;
    });
    assert.equal(updated, 0, "cross-tenant UPDATE must affect 0 rows under RLS");

    // Confirm B's project name is unchanged.
    const check = await withTenant(ctx.orgB, async (client) => {
      const res = await client.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [
        ctx.projectB,
      ]);
      return res.rows[0]?.name;
    });
    assert.equal(check, "Beta Site", "tenant B project must be untouched");
  });

  void it("DB-03h: tenant A CANNOT DELETE tenant B's project", async () => {
    const deleted = await withTenant(ctx.orgA, async (client) => {
      const res = await client.query(`DELETE FROM projects WHERE id = $1 RETURNING id`, [
        ctx.projectB,
      ]);
      return res.rowCount;
    });
    assert.equal(deleted, 0, "cross-tenant DELETE must affect 0 rows under RLS");
  });

  void it("DB-03h2: the legacy evidence-link insert derives its tenant under RLS", async () => {
    const evidence = await addEvidence({
      organization_id: ctx.orgA,
      project_id: ctx.projectA,
      kind: "http_response",
      source_ref: "https://alpha.example.com/legacy-insert",
      content_hash: "sha256:test-legacy-link-alpha",
      object_key: `${ctx.orgA}/${ctx.projectA}/test-legacy-link-alpha`,
    });
    const inserted = await withTenant(ctx.orgA, async (client) => {
      const result = await client.query<{ organization_id: string }>(
        `INSERT INTO finding_evidence (finding_id, evidence_id, relation)
         VALUES ($1, $2, 'supports')
         RETURNING organization_id::text`,
        [ctx.findingA, evidence.id],
      );
      return result.rows[0]?.organization_id;
    });
    assert.equal(inserted, ctx.orgA);
  });

  void it("DB-03i: cross-tenant foreign-key INSERT fails even for a known org id", async () => {
    await assert.rejects(
      async () => {
        await withTenant(ctx.orgA, async (client) => {
          await client.query(
            `INSERT INTO findings (organization_id, project_id, rule_id, rule_version, title, epistemic_class, severity)
             VALUES ($1, $2, 'X', '1.0.0', 'cross tenant', 'OBSERVED', 'low')`,
            [ctx.orgB, ctx.projectB],
          );
        });
      },
      /row-level security|violates row-level/i,
      "inserting a finding scoped to tenant B must be blocked by RLS",
    );
  });

  void it("DB-07: tenant B cannot read tenant A's finding-evidence link", async () => {
    const visibleLinks = await withTenant(ctx.orgB, async (client) => {
      const result = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM finding_evidence`,
      );
      return result.rows[0]?.n ?? -1;
    });
    assert.equal(visibleLinks, 0, "RLS must hide finding-evidence rows belonging to tenant A");
  });

  void it("DB-08: tenant B cannot stamp a link with tenant A's organization id", async () => {
    await assert.rejects(
      withTenant(ctx.orgB, async (client) =>
        client.query(
          `INSERT INTO finding_evidence (organization_id, finding_id, evidence_id, relation)
           VALUES ($1, $2, $3, 'supports')`,
          [ctx.orgA, ctx.findingA, ctx.evidenceA],
        ),
      ),
      /row-level security|policy/i,
    );
  });

  void it("DB-09: composite foreign keys reject a tenant B link to tenant A endpoints", async () => {
    await assert.rejects(
      withTenant(ctx.orgB, async (client) =>
        client.query(
          `INSERT INTO finding_evidence (organization_id, finding_id, evidence_id, relation)
           VALUES ($1, $2, $3, 'supports')`,
          [ctx.orgB, ctx.findingB, ctx.evidenceA],
        ),
      ),
      /foreign key/i,
    );
  });

  void it("DB-10: repository linking and evidence reads remain tenant-scoped", async () => {
    await linkFindingEvidence(ctx.orgB, ctx.findingA, ctx.evidenceA);

    const ownEvidence = await getFindingEvidence(ctx.orgA, ctx.findingA);
    const foreignEvidence = await getFindingEvidence(ctx.orgB, ctx.findingA);
    assert.equal(
      ownEvidence.length,
      2,
      "tenant A should read its original and legacy linked evidence",
    );
    assert.ok(
      ownEvidence.some((evidence) => evidence.id === ctx.evidenceA),
      "the original evidence relation remains visible to its tenant",
    );
    assert.deepEqual(
      foreignEvidence,
      [],
      "tenant B must not read evidence linked to tenant A's finding",
    );

    const counts = await withAdmin(async (client) => {
      const result = await client.query<{ organization_id: string; n: number }>(
        `SELECT organization_id, count(*)::int AS n
           FROM finding_evidence
          GROUP BY organization_id
          ORDER BY organization_id`,
      );
      return Object.fromEntries(result.rows.map((row) => [row.organization_id, row.n]));
    });
    assert.equal(counts[ctx.orgA], 2);
    assert.equal(counts[ctx.orgB] ?? 0, 0, "repository must not create a cross-tenant link");
  });

  void it("DB-04: runtime role cannot bypass RLS to see all projects", async () => {
    // Query projects with NO tenant GUC set (simulating a leaked/unset context).
    // nullif('')::uuid -> NULL -> matches zero rows. Must NOT return both tenants.
    const allVisible = await withAdmin(async (client) => {
      await client.query("SET LOCAL ROLE serpvera_app");
      const res = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM projects
         WHERE id IN ($1, $2)`,
        [ctx.projectA, ctx.projectB],
      );
      return res.rows[0]?.n;
    });
    assert.equal(allVisible, 0, "with no/empty tenant GUC, runtime role sees zero tenant rows");
  });

  void it("DB-06: POSITIVE CONTROL — bypass-capable role DOES see both tenants (proves isolation is RLS-caused, not missing data)", async () => {
    // Skeptic guard: the negative results above are only meaningful if the same
    // rows ARE visible to a role that bypasses RLS. The login user (wina) is a
    // superuser, so withAdmin (no SET ROLE) sees everything. If this returned 0,
    // the "cannot see" tests would be vacuous (data never inserted / bad ids).
    const visibleToBypass = await withAdmin(async (client) => {
      const res = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM projects WHERE id IN ($1, $2)`,
        [ctx.projectA, ctx.projectB],
      );
      return res.rows[0]?.n;
    });
    assert.equal(
      visibleToBypass,
      2,
      "positive control: superuser (no SET ROLE) must see BOTH tenant projects — data exists",
    );

    // And confirm the bypass role really is bypass-capable (superuser OR bypassrls).
    const bypassFlags = await withAdmin(async (client) => {
      const res = await client.query<{ can_bypass: boolean }>(
        `SELECT rolsuper OR rolbypassrls AS can_bypass FROM pg_roles WHERE rolname = current_user`,
      );
      return res.rows[0];
    });
    assert.ok(bypassFlags, "bypass role flags must be readable");
    assert.equal(
      bypassFlags.can_bypass,
      true,
      "control must actually run as a bypass-capable role for this test to be meaningful",
    );
  });

  void it("DB-05: tenant context does NOT leak across pooled connections", async () => {
    // including a request with no explicit tenant (empty GUC) in between.
    // If SET LOCAL leaked, a later query would wrongly see an earlier tenant.
    const aSeen = await listProjects(ctx.orgA);
    const bSeen = await listProjects(ctx.orgB);
    const aSeenAgain = await listProjects(ctx.orgA);

    assert.equal(
      aSeen.find((p) => p.id === ctx.projectB),
      undefined,
    );
    assert.equal(
      bSeen.find((p) => p.id === ctx.projectA),
      undefined,
    );
    assert.deepEqual(
      aSeenAgain.map((p) => p.id),
      [ctx.projectA],
      "tenant A must still see only its project after interleaving",
    );

    // A transaction that sets tenant A, then a subsequent withAdmin (no role/GUC
    // set to a tenant) must not inherit tenant A visibility for other tenants.
    await withTenant(ctx.orgA, async () => {
      /* just sets + commits */
    });
    const emptyContextSeesNothing = await withAdmin(async (client) => {
      await client.query("SET LOCAL ROLE serpvera_app");
      const res = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM projects WHERE id = $1`,
        [ctx.projectA],
      );
      return res.rows[0]?.n;
    });
    assert.equal(
      emptyContextSeesNothing,
      0,
      "SET LOCAL must be transaction-scoped: no leakage into a later empty-context txn",
    );
  });
});
