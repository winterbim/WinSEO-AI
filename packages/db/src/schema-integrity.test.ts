// ─── SCHEMA INTEGRITY TEST ───
// P-GAP-02 sections 4-5. Proves the expected tables, primary keys, foreign keys,
// unique constraints, organization ownership columns, timestamps, RLS flags and
// policies actually exist — via PostgreSQL catalogs, not exit codes or mocks.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { configurePool, closePool, withAdmin, healthCheck } from "./index.ts";

const EXPECTED_TABLES = [
  "users",
  "organizations",
  "memberships",
  "plans",
  "projects",
  "crawl_runs",
  "findings",
  "evidence_items",
  "actions",
  "action_transitions",
  "gsc_connections",
  "gsc_sync_jobs",
  "gsc_query_metrics",
  "gsc_project_credentials",
  "gsc_oauth_states",
  "patch_proposals",
  "patch_events",
  "schema_migrations",
];

const TENANT_OWNED = [
  "projects",
  "crawl_runs",
  "findings",
  "evidence_items",
  "actions",
  "action_transitions",
  "gsc_connections",
  "gsc_sync_jobs",
  "gsc_query_metrics",
  "gsc_project_credentials",
  "gsc_oauth_states",
  "patch_proposals",
  "patch_events",
];

void describe("DB-02 schema integrity (real PostgreSQL catalogs)", () => {
  before(async () => {
    configurePool({
      host: process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
      database: process.env.PGDATABASE ?? "serpvera_dev",
      runtimeRole: "serpvera_app",
      maxPool: 2,
    });
    assert.ok(await healthCheck(), "database unavailable");
  });

  after(async () => {
    await closePool();
  });

  void it("catalog contains gsc_connections, gsc_sync_jobs, and gsc_query_metrics", async () => {
    const rows = await withAdmin(async (c) => {
      const res = await c.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public'`,
      );
      return res.rows.map((r) => r.tablename);
    });
    for (const t of EXPECTED_TABLES) {
      assert.ok(rows.includes(t), `expected table ${t} missing`);
    }
  });

  void it("migration is recorded in the ledger", async () => {
    const rows = await withAdmin(async (c) => {
      const res = await c.query<{ version: string }>(`SELECT version FROM schema_migrations`);
      return res.rows.map((r) => r.version);
    });
    assert.ok(rows.includes("0001_init_schema"), "0001_init_schema must be in ledger");
    assert.ok(rows.includes("0005_action_center"), "0005_action_center must be in ledger");
    assert.ok(rows.includes("0006_gsc_scaffold"), "0006_gsc_scaffold must be in ledger");
    assert.ok(rows.includes("0007_gsc_live"), "0007_gsc_live must be in ledger");
    assert.ok(rows.includes("0009_reported_manually"), "0009_reported_manually must be in ledger");
    assert.ok(
      rows.includes("0010_manual_report_metadata"),
      "0010_manual_report_metadata must be in ledger",
    );
    assert.ok(
      rows.includes("0014_proven_patch_lifecycle"),
      "0014_proven_patch_lifecycle must be in ledger",
    );
  });

  void it("patch storage accepts the complete lifecycle vocabulary", async () => {
    const definition = await withAdmin(async (c) => {
      const result = await c.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = 'patch_proposals'::regclass
            AND conname = 'patch_proposals_status_check'`,
      );
      return result.rows[0]?.definition ?? "";
    });
    for (const status of [
      "detected",
      "proposed",
      "previewed",
      "approved",
      "deploying",
      "deployed",
      "deployed_manually",
      "live_verified",
      "google_observed",
      "measuring",
      "measured",
      "rolled_back",
      "superseded",
      "drifted",
      "failed",
      "rejected",
    ]) {
      assert.ok(definition.includes(`'${status}'`), `database constraint is missing ${status}`);
    }
  });

  void it("the Action Center no longer accepts an unverified IMPLEMENTED state", async () => {
    const result = await withAdmin(async (c) => {
      const constraint = await c.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = 'actions'::regclass AND conname = 'actions_state_check'`,
      );
      const count = await c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM actions WHERE state = 'IMPLEMENTED'`,
      );
      const metadata = await c.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM actions
          WHERE implementation_json ?| ARRAY['implementedAt', 'implementedBy', 'implementedByEmail']`,
      );
      return {
        definition: constraint.rows[0]?.definition ?? "",
        legacyCount: count.rows[0]?.count,
        legacyMetadataCount: metadata.rows[0]?.count,
      };
    });
    assert.match(result.definition, /REPORTED_MANUALLY/);
    assert.doesNotMatch(result.definition, /'IMPLEMENTED'/);
    assert.equal(result.legacyCount, "0", "legacy rows must be migrated to manual reports");
    assert.equal(
      result.legacyMetadataCount,
      "0",
      "legacy metadata must not claim an implementation time",
    );
  });

  void it("every tenant-owned table has organization_id NOT NULL + its Blueprint timestamp", async () => {
    // Blueprint §11 assigns each tenant table a semantic timestamp column.
    const TIMESTAMP_COL: Record<string, string> = {
      projects: "created_at",
      crawl_runs: "created_at",
      findings: "first_seen_at",
      evidence_items: "captured_at",
      actions: "created_at",
      action_transitions: "created_at",
      gsc_connections: "created_at",
      gsc_sync_jobs: "requested_at",
      gsc_query_metrics: "created_at",
      gsc_project_credentials: "created_at",
      gsc_oauth_states: "created_at",
      patch_proposals: "created_at",
      patch_events: "created_at",
    };
    for (const t of TENANT_OWNED) {
      const cols = await withAdmin(async (c) => {
        const res = await c.query<{ column_name: string; is_nullable: string }>(
          `SELECT column_name, is_nullable
             FROM information_schema.columns
            WHERE table_schema='public' AND table_name=$1`,
          [t],
        );
        return res.rows;
      });
      const orgCol = cols.find((x) => x.column_name === "organization_id");
      assert.ok(orgCol, `${t}.organization_id must exist`);
      assert.equal(orgCol.is_nullable, "NO", `${t}.organization_id must be NOT NULL`);
      assert.ok(
        cols.some((x) => x.column_name === TIMESTAMP_COL[t]),
        `${t} must have its Blueprint timestamp column ${TIMESTAMP_COL[t]}`,
      );
    }
  });

  void it("primary keys exist on core tables", async () => {
    const pkTables = await withAdmin(async (c) => {
      const res = await c.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
          WHERE con.contype = 'p' AND c.relnamespace = 'public'::regnamespace`,
      );
      return res.rows.map((r) => r.relname);
    });
    for (const t of ["users", "organizations", "projects", "memberships", "plans"]) {
      assert.ok(pkTables.includes(t), `${t} must have a primary key`);
    }
  });

  void it("foreign keys enforce organization ownership on tenant tables", async () => {
    for (const t of TENANT_OWNED) {
      const fk = await withAdmin(async (c) => {
        const res = await c.query<{ referenced: string }>(
          `SELECT confrelid::regclass::text AS referenced
             FROM pg_constraint
            WHERE conrelid = $1::regclass AND contype='f'`,
          [t],
        );
        return res.rows.map((r) => r.referenced);
      });
      assert.ok(fk.includes("organizations"), `${t} must have an FK to organizations`);
    }
  });

  void it("unique constraints: users.email, organizations.slug", async () => {
    // Query unique columns via pg_attribute + pg_constraint key arrays reliably.
    const uniqCols = await withAdmin(async (c) => {
      const res = await c.query<{ relname: string; attname: string }>(
        `SELECT c.relname, a.attname
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           CROSS JOIN LATERAL unnest(con.conkey) AS k(attnum)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
          WHERE con.contype = 'u' AND c.relnamespace = 'public'::regnamespace`,
      );
      return res.rows;
    });
    const userEmail = uniqCols.some((u) => u.relname === "users" && u.attname === "email");
    const orgSlug = uniqCols.some((u) => u.relname === "organizations" && u.attname === "slug");
    assert.ok(userEmail, "users.email must be UNIQUE");
    assert.ok(orgSlug, "organizations.slug must be UNIQUE");
  });

  void it("indexes exist on hot columns", async () => {
    const idx = await withAdmin(async (c) => {
      const res = await c.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname='public'`,
      );
      return res.rows.map((r) => r.indexname);
    });
    for (const name of [
      "idx_projects_org",
      "idx_findings_org",
      "idx_memberships_user",
      "idx_action_transitions_org",
      "idx_gsc_metrics_project_date",
      "idx_gsc_credentials_org",
      "idx_gsc_oauth_states_project",
      "uq_gsc_jobs_idempotency",
    ]) {
      assert.ok(idx.includes(name), `index ${name} must exist`);
    }
  });

  void it("gsc_connections, gsc_sync_jobs, and gsc_query_metrics have ENABLED and FORCED RLS", async () => {
    const rows = await withAdmin(async (c) => {
      const res = await c.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE relnamespace='public'::regnamespace AND relname = ANY($1)`,
        [TENANT_OWNED],
      );
      return res.rows;
    });
    assert.equal(rows.length, TENANT_OWNED.length);
    for (const r of rows) {
      assert.equal(r.relrowsecurity, true, `${r.relname} RLS must be enabled`);
      assert.equal(r.relforcerowsecurity, true, `${r.relname} RLS must be forced`);
    }
  });

  void it("gsc_connections, gsc_sync_jobs, and gsc_query_metrics have tenant_isolation policies", async () => {
    const rows = await withAdmin(async (c) => {
      const res = await c.query<{ tablename: string }>(
        `SELECT tablename FROM pg_policies WHERE policyname='tenant_isolation'`,
      );
      return res.rows.map((r) => r.tablename);
    });
    for (const t of TENANT_OWNED) {
      assert.ok(rows.includes(t), `${t} must have tenant_isolation policy`);
    }
  });

  void it("runtime role is non-superuser and non-bypassrls", async () => {
    const role = await withAdmin(async (c) => {
      const res = await c.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
      }>(`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='serpvera_app'`);
      return res.rows[0];
    });
    assert.ok(role, "runtime role row must exist");
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
    // NOLOGIN locally (SET ROLE path); production grants LOGIN via vault secret.
    assert.equal(
      role.rolcanlogin,
      false,
      "local runtime role should be NOLOGIN (no committed password)",
    );
  });
});
