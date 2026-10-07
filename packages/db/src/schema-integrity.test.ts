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
  "finding_evidence",
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
  "finding_evidence",
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

  void it("catalog contains all expected tables, including finding_evidence", async () => {
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
    assert.ok(
      rows.includes("0015_finding_evidence_tenant_rls"),
      "0015_finding_evidence_tenant_rls must be in ledger",
    );
    assert.ok(
      rows.includes("0019w_gsc_effective_acl_fence"),
      "0019w_gsc_effective_acl_fence must be in ledger",
    );
    assert.ok(
      rows.includes("0019x_gsc_parent_delete_fence"),
      "0019x_gsc_parent_delete_fence must be in ledger",
    );
    assert.ok(
      rows.includes("0019y_gsc_sync_write_fence"),
      "0019y_gsc_sync_write_fence must be in ledger",
    );
    assert.ok(
      rows.includes("0019z_gsc_claim_order_preflight"),
      "0019z_gsc_claim_order_preflight must be in ledger",
    );
    assert.ok(
      rows.includes("0019zz_gsc_sync_migration_guard"),
      "0019zz_gsc_sync_migration_guard must be in ledger",
    );
    assert.ok(
      rows.includes("0016_runtime_schema_readiness_view"),
      "0016_runtime_schema_readiness_view must be in ledger",
    );
    assert.ok(
      rows.includes("0017_project_create_idempotency"),
      "0017_project_create_idempotency must be in ledger",
    );
    assert.ok(
      rows.includes("0018_runtime_readiness_and_legacy_evidence_compat"),
      "0018_runtime_readiness_and_legacy_evidence_compat must be in ledger",
    );
    assert.ok(
      rows.includes("0019_gsc_property_scoped_measurements"),
      "0019_gsc_property_scoped_measurements must be in ledger",
    );
    assert.ok(rows.includes("0020_gsc_sync_claim_order"), "0020 GSC claim order must be in ledger");
    assert.ok(
      rows.includes("0021_remove_gsc_sync_migration_guard"),
      "0021_remove_gsc_sync_migration_guard must be in ledger",
    );
    assert.ok(
      rows.includes("0022_restore_gsc_runtime_writes"),
      "0022_restore_gsc_runtime_writes must be in ledger",
    );
    assert.ok(
      rows.includes("0023_restore_gsc_parent_deletes"),
      "0023_restore_gsc_parent_deletes must be in ledger",
    );
    assert.ok(
      rows.includes("0024_restore_gsc_acl_baseline"),
      "0024_restore_gsc_acl_baseline must be in ledger",
    );
  });

  void it("removes the temporary GSC migration guard after the migration chain", async () => {
    const result = await withAdmin(async (client) => {
      const guard = await client.query<{ guardTable: string | null; triggerCount: number }>(`
        SELECT to_regclass('public.gsc_migration_guard')::text AS "guardTable",
               (SELECT count(*)::int FROM pg_trigger
                 WHERE tgrelid IN ('public.gsc_sync_jobs'::regclass,
                                   'public.gsc_query_metrics'::regclass)
                   AND tgname IN ('gsc_sync_jobs_migration_guard',
                                  'gsc_query_metrics_migration_guard')) AS "triggerCount"
      `);
      return guard.rows[0];
    });
    assert.deepEqual(result, { guardTable: null, triggerCount: 0 });
  });

  void it("restores runtime GSC writes only after the migration guard is removed", async () => {
    const result = await withAdmin(async (client) => {
      const privileges = await client.query<{
        jobsInsert: boolean;
        jobsUpdate: boolean;
        metricsInsert: boolean;
        metricsDelete: boolean;
        guardTable: string | null;
      }>(`
        SELECT has_table_privilege('serpvera_app', 'public.gsc_sync_jobs', 'INSERT') AS "jobsInsert",
               has_table_privilege('serpvera_app', 'public.gsc_sync_jobs', 'UPDATE') AS "jobsUpdate",
               has_table_privilege('serpvera_app', 'public.gsc_query_metrics', 'INSERT') AS "metricsInsert",
               has_table_privilege('serpvera_app', 'public.gsc_query_metrics', 'DELETE') AS "metricsDelete",
               to_regclass('public.gsc_migration_guard')::text AS "guardTable"
      `);
      return privileges.rows[0];
    });
    assert.deepEqual(result, {
      jobsInsert: true,
      jobsUpdate: true,
      metricsInsert: true,
      metricsDelete: true,
      guardTable: null,
    });
  });

  void it("restores scoped parent deletes after the GSC cascade fence is removed", async () => {
    const result = await withAdmin(async (client) => {
      const privileges = await client.query<{
        connectionsDelete: boolean;
        projectsDelete: boolean;
        organizationsDelete: boolean;
        connectionsTruncate: boolean;
        projectsTruncate: boolean;
        organizationsTruncate: boolean;
      }>(`
        SELECT has_table_privilege('serpvera_app', 'public.gsc_connections', 'DELETE') AS "connectionsDelete",
               has_table_privilege('serpvera_app', 'public.projects', 'DELETE') AS "projectsDelete",
               has_table_privilege('serpvera_app', 'public.organizations', 'DELETE') AS "organizationsDelete",
               has_table_privilege('serpvera_app', 'public.gsc_connections', 'TRUNCATE') AS "connectionsTruncate",
               has_table_privilege('serpvera_app', 'public.projects', 'TRUNCATE') AS "projectsTruncate",
               has_table_privilege('serpvera_app', 'public.organizations', 'TRUNCATE') AS "organizationsTruncate"
      `);
      return privileges.rows[0];
    });
    assert.deepEqual(result, {
      connectionsDelete: true,
      projectsDelete: true,
      organizationsDelete: true,
      connectionsTruncate: false,
      projectsTruncate: false,
      organizationsTruncate: false,
    });
  });

  void it("restores app DML without leaving PUBLIC table or column write grants", async () => {
    const result = await withAdmin(async (client) => {
      const privileges = await client.query<{
        appOrgInsert: boolean;
        appProjectUpdate: boolean;
        appConnectionDelete: boolean;
        appJobsInsert: boolean;
        appMetricsUpdate: boolean;
        publicTableWrites: number;
        publicColumnWrites: number;
      }>(`
        WITH target_tables AS (
          SELECT unnest(ARRAY[
            'public.organizations'::regclass,
            'public.projects'::regclass,
            'public.gsc_connections'::regclass,
            'public.gsc_sync_jobs'::regclass,
            'public.gsc_query_metrics'::regclass
          ]) AS oid
        )
        SELECT has_table_privilege('serpvera_app', 'public.organizations', 'INSERT') AS "appOrgInsert",
               has_table_privilege('serpvera_app', 'public.projects', 'UPDATE') AS "appProjectUpdate",
               has_table_privilege('serpvera_app', 'public.gsc_connections', 'DELETE') AS "appConnectionDelete",
               has_table_privilege('serpvera_app', 'public.gsc_sync_jobs', 'INSERT') AS "appJobsInsert",
               has_table_privilege('serpvera_app', 'public.gsc_query_metrics', 'UPDATE') AS "appMetricsUpdate",
               (SELECT count(*)::int
                  FROM target_tables t
                  JOIN pg_class c ON c.oid = t.oid
                  CROSS JOIN LATERAL aclexplode(c.relacl) acl
                 WHERE acl.grantee = 0
                   AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) AS "publicTableWrites",
               (SELECT count(*)::int
                  FROM pg_attribute attr
                  CROSS JOIN LATERAL aclexplode(attr.attacl) acl
                 WHERE attr.attrelid IN (SELECT oid FROM target_tables)
                   AND attr.attnum > 0
                   AND NOT attr.attisdropped
                   AND acl.grantee = 0
                   AND acl.privilege_type IN ('INSERT', 'UPDATE')) AS "publicColumnWrites"
      `);
      return privileges.rows[0];
    });
    assert.deepEqual(result, {
      appOrgInsert: true,
      appProjectUpdate: true,
      appConnectionDelete: true,
      appJobsInsert: true,
      appMetricsUpdate: true,
      publicTableWrites: 0,
      publicColumnWrites: 0,
    });
  });

  void it("uses a monotonic per-property GSC claim order", async () => {
    const result = await withAdmin(async (client) => {
      const column = await client.query<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(`
        SELECT data_type, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'gsc_sync_jobs'
           AND column_name = 'claim_order'
      `);
      const index = await client.query<{ definition: string }>(`
        SELECT pg_get_indexdef(indexrelid) AS definition
          FROM pg_index
         WHERE indexrelid = 'public.gsc_sync_jobs_claim_order_uq'::regclass
      `);
      return { column: column.rows[0], index: index.rows[0]?.definition ?? "" };
    });
    assert.deepEqual(result.column, {
      data_type: "bigint",
      is_nullable: "NO",
      column_default: "0",
    });
    assert.match(result.index, /UNIQUE INDEX/);
    assert.match(result.index, /organization_id, project_id, connection_id, claim_order/);
    assert.match(result.index, /WHERE \(claim_order > 0\)/);
  });

  void it("allows at most one connected Search Console property per project", async () => {
    const indexes = await withAdmin(async (client) => {
      const result = await client.query<{ definition: string }>(`
        SELECT pg_get_indexdef(indexrelid) AS definition
          FROM pg_index
         WHERE indexrelid = 'public.gsc_connections_one_connected_per_project_uq'::regclass
      `);
      return result.rows[0]?.definition ?? "";
    });
    assert.match(indexes, /UNIQUE INDEX/);
    assert.match(indexes, /organization_id, project_id/);
    assert.match(indexes, /status = 'CONNECTED'/);
  });

  void it("legacy evidence-link tenant trigger is installed and least-privileged", async () => {
    const row = await withAdmin(async (client) => {
      const result = await client.query<{
        triggerExists: boolean;
        functionSecurityDefiner: boolean;
        publicCanExecute: boolean;
        runtimeCanExecute: boolean;
      }>(`
        SELECT
          EXISTS (
            SELECT 1 FROM pg_trigger
             WHERE tgrelid = 'public.finding_evidence'::regclass
               AND tgname = 'finding_evidence_fill_organization'
               AND NOT tgisinternal
          ) AS "triggerExists",
          p.prosecdef AS "functionSecurityDefiner",
          EXISTS (
            SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
             WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
          ) AS "publicCanExecute",
          has_function_privilege('serpvera_app', p.oid, 'EXECUTE') AS "runtimeCanExecute"
        FROM pg_proc p
        WHERE p.oid = 'public.populate_finding_evidence_organization()'::regprocedure
      `);
      return result.rows[0];
    });
    assert.deepEqual(row, {
      triggerExists: true,
      functionSecurityDefiner: false,
      publicCanExecute: false,
      runtimeCanExecute: true,
    });
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

  void it("every tenant-owned table has organization_id NOT NULL and its declared timestamp", async () => {
    // Blueprint §11 assigns semantic timestamps where the table contract defines one.
    const TIMESTAMP_COL: Partial<Record<(typeof TENANT_OWNED)[number], string>> = {
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
      const timestampColumn = TIMESTAMP_COL[t];
      if (timestampColumn) {
        assert.ok(
          cols.some((x) => x.column_name === timestampColumn),
          `${t} must have its Blueprint timestamp column ${timestampColumn}`,
        );
      }
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

  void it("every tenant-owned table has ENABLED and FORCED RLS", async () => {
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

  void it("every tenant-owned table has a tenant_isolation policy", async () => {
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

  void it("finding_evidence has composite tenant foreign keys to both endpoints", async () => {
    const definitions = await withAdmin(async (c) => {
      const res = await c.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = 'finding_evidence'::regclass AND contype = 'f'`,
      );
      return res.rows.map((row) => row.definition);
    });
    assert.ok(
      definitions.some((definition) =>
        definition.includes(
          "FOREIGN KEY (organization_id, finding_id) REFERENCES findings(organization_id, id)",
        ),
      ),
      "finding_evidence must reference a finding in the same organization",
    );
    assert.ok(
      definitions.some((definition) =>
        definition.includes(
          "FOREIGN KEY (organization_id, evidence_id) REFERENCES evidence_items(organization_id, id)",
        ),
      ),
      "finding_evidence must reference evidence in the same organization",
    );
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
