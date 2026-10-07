import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { closePool, configurePool, withAdmin } from "./index.ts";

const migrationUrl = new URL("../migrations/0019z_gsc_claim_order_preflight.sql", import.meta.url);
const effectiveAclFenceMigrationUrl = new URL(
  "../migrations/0019w_gsc_effective_acl_fence.sql",
  import.meta.url,
);
const guardMigrationUrl = new URL(
  "../migrations/0019zz_gsc_sync_migration_guard.sql",
  import.meta.url,
);
const cleanupMigrationUrl = new URL(
  "../migrations/0021_remove_gsc_sync_migration_guard.sql",
  import.meta.url,
);
const writeFenceMigrationUrl = new URL(
  "../migrations/0019y_gsc_sync_write_fence.sql",
  import.meta.url,
);
const restoreWritesMigrationUrl = new URL(
  "../migrations/0022_restore_gsc_runtime_writes.sql",
  import.meta.url,
);
const parentFenceMigrationUrl = new URL(
  "../migrations/0019x_gsc_parent_delete_fence.sql",
  import.meta.url,
);
const restoreParentDeletesMigrationUrl = new URL(
  "../migrations/0023_restore_gsc_parent_deletes.sql",
  import.meta.url,
);
const restoreAclBaselineMigrationUrl = new URL(
  "../migrations/0024_restore_gsc_acl_baseline.sql",
  import.meta.url,
);
const migrationsDirectoryUrl = new URL("../migrations/", import.meta.url);
const suffix = `${process.pid}_${Math.random().toString(16).slice(2)}`;
const conflictSchema = `gsc_claim_probe_conflict_${suffix}`;
const safeSchema = `gsc_claim_probe_safe_${suffix}`;
const guardSchema = `gsc_claim_probe_guard_${suffix}`;
const outOfWindowSchema = `gsc_claim_probe_out_of_window_${suffix}`;
const ownerSchema = `gsc_claim_probe_owner_${suffix}`;
const membershipSchema = `gsc_claim_probe_membership_${suffix}`;
const membershipRole = `gsc_acl_probe_role_${suffix}`;
const organizationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const earlierJobId = "44444444-4444-4444-8444-444444444444";
const laterJobId = "55555555-5555-4555-8555-555555555555";

function quoteGeneratedSchema(schema: string): string {
  if (!/^gsc_claim_probe_[a-z0-9_]+$/.test(schema)) {
    throw new Error("Unexpected generated schema name.");
  }
  return `"${schema}"`;
}

function quoteGeneratedRole(role: string): string {
  if (!/^gsc_acl_probe_role_[a-z0-9_]+$/.test(role)) {
    throw new Error("Unexpected generated role name.");
  }
  return `"${role}"`;
}

async function createFixture(
  schema: string,
  conflictingClock: boolean,
  windows = {
    firstStart: "2026-01-01",
    firstEnd: "2026-01-31",
    secondStart: "2026-01-01",
    secondEnd: "2026-01-31",
    metricDate: "2026-01-15",
  },
): Promise<void> {
  const quoted = quoteGeneratedSchema(schema);
  await withAdmin(async (client) => {
    await client.query(`CREATE SCHEMA ${quoted}`);
    await client.query(`SET LOCAL search_path TO ${quoted}, public`);
    await client.query(`
      CREATE TABLE organizations (id uuid PRIMARY KEY);
      CREATE TABLE projects (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE TABLE gsc_connections (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE gsc_sync_jobs (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        connection_id uuid NOT NULL REFERENCES gsc_connections(id) ON DELETE CASCADE,
        window_start date NOT NULL,
        window_end date NOT NULL,
        status text NOT NULL,
        requested_at timestamptz NOT NULL,
        started_at timestamptz
      );
      CREATE TABLE gsc_query_metrics (
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        sync_job_id uuid NOT NULL REFERENCES gsc_sync_jobs(id) ON DELETE CASCADE,
        metric_date date NOT NULL
      );
      CREATE TABLE schema_migrations (version text PRIMARY KEY, checksum text);
    `);
    await client.query(`INSERT INTO organizations (id) VALUES ($1)`, [organizationId]);
    await client.query(`INSERT INTO projects (id, organization_id) VALUES ($1, $2)`, [
      projectId,
      organizationId,
    ]);
    await client.query(
      `INSERT INTO gsc_connections (id, organization_id, project_id) VALUES ($1, $2, $3)`,
      [connectionId, organizationId, projectId],
    );
    await client.query(
      `INSERT INTO gsc_sync_jobs
         (id, organization_id, project_id, connection_id, window_start, window_end,
          status, requested_at, started_at)
       VALUES
         ($1, $3, $4, $5, $7::date, $8::date, 'COMPLETED',
          '2026-01-01T10:00:00Z', '2026-01-01T11:05:00Z'),
         ($2, $3, $4, $5, $9::date, $10::date, 'COMPLETED',
          '2026-01-01T11:00:00Z', $6::timestamptz)`,
      [
        earlierJobId,
        laterJobId,
        organizationId,
        projectId,
        connectionId,
        conflictingClock ? "2026-01-01T11:01:00Z" : "2026-01-01T11:06:00Z",
        windows.firstStart,
        windows.firstEnd,
        windows.secondStart,
        windows.secondEnd,
      ],
    );
    await client.query(
      `INSERT INTO gsc_query_metrics (organization_id, project_id, sync_job_id, metric_date)
       VALUES ($1, $2, $3, $4::date)`,
      [organizationId, projectId, earlierJobId, windows.metricDate],
    );
  });
}

async function applyPreflight(schema: string, sql: string): Promise<void> {
  const quoted = quoteGeneratedSchema(schema);
  const body = sql
    .replace(/^\s*BEGIN\s*;/i, "")
    .replace(/COMMIT\s*;\s*$/i, "")
    .replace("INSERT INTO public.schema_migrations", "INSERT INTO schema_migrations");
  await withAdmin(async (client) => {
    await client.query(`SET LOCAL search_path TO ${quoted}, public`);
    await client.query(body);
  });
}

async function applySchemaMigration(schema: string, sql: string): Promise<void> {
  const quoted = quoteGeneratedSchema(schema);
  const body = sql
    .replace(/^\s*BEGIN\s*;/i, "")
    .replace(/COMMIT\s*;\s*$/i, "")
    .replace(/\bpublic\b/g, schema);
  await withAdmin(async (client) => {
    await client.query(`SET LOCAL search_path TO ${quoted}, public`);
    await client.query(body);
  });
}

async function dropFixture(schema: string): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteGeneratedSchema(schema)} CASCADE`);
  });
}

async function assertAclFenceNotRecorded(schema: string): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(`SET LOCAL search_path TO ${quoteGeneratedSchema(schema)}, public`);
    const result = await client.query<{ migrationRecorded: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM schema_migrations
         WHERE version = '0019w_gsc_effective_acl_fence'
      ) AS "migrationRecorded"
    `);
    assert.equal(result.rows[0]?.migrationRecorded, false);
  });
}

void describe("0019z GSC claim-order migration preflight", () => {
  let migrationSql = "";
  let effectiveAclFenceSql = "";

  before(async () => {
    configurePool({
      host: process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
      database: process.env.PGDATABASE ?? "serpvera_dev",
      maxPool: 2,
    });
    migrationSql = await readFile(migrationUrl, "utf8");
    effectiveAclFenceSql = await readFile(effectiveAclFenceMigrationUrl, "utf8");
  });

  after(async () => {
    try {
      await dropFixture(conflictSchema);
      await dropFixture(safeSchema);
      await dropFixture(guardSchema);
      await dropFixture(outOfWindowSchema);
      await dropFixture(ownerSchema);
      await dropFixture(membershipSchema);
    } finally {
      await closePool();
    }
  });

  void it("sorts before 0020 so the guard runs before destructive cleanup", async () => {
    const migrations = (await readdir(migrationsDirectoryUrl))
      .filter((filename) => filename.endsWith(".sql"))
      .sort();
    assert.ok(
      migrations.indexOf("0019x_gsc_parent_delete_fence.sql") <
        migrations.indexOf("0019y_gsc_sync_write_fence.sql") &&
        migrations.indexOf("0019w_gsc_effective_acl_fence.sql") <
          migrations.indexOf("0019x_gsc_parent_delete_fence.sql") &&
        migrations.indexOf("0019y_gsc_sync_write_fence.sql") <
          migrations.indexOf("0019z_gsc_claim_order_preflight.sql") &&
        migrations.indexOf("0019z_gsc_claim_order_preflight.sql") <
          migrations.indexOf("0019zz_gsc_sync_migration_guard.sql") &&
        migrations.indexOf("0019zz_gsc_sync_migration_guard.sql") <
          migrations.indexOf("0020_gsc_sync_claim_order.sql") &&
        migrations.indexOf("0020_gsc_sync_claim_order.sql") <
          migrations.indexOf("0021_remove_gsc_sync_migration_guard.sql") &&
        migrations.indexOf("0021_remove_gsc_sync_migration_guard.sql") <
          migrations.indexOf("0022_restore_gsc_runtime_writes.sql") &&
        migrations.indexOf("0022_restore_gsc_runtime_writes.sql") <
          migrations.indexOf("0023_restore_gsc_parent_deletes.sql") &&
        migrations.indexOf("0023_restore_gsc_parent_deletes.sql") <
          migrations.indexOf("0024_restore_gsc_acl_baseline.sql"),
    );
  });

  void it("fails closed if the runtime role owns any protected table", async () => {
    await createFixture(ownerSchema, false);
    await withAdmin(async (client) => {
      await client.query(
        `ALTER TABLE ${quoteGeneratedSchema(ownerSchema)}.gsc_sync_jobs OWNER TO serpvera_app`,
      );
    });

    await assert.rejects(
      applySchemaMigration(ownerSchema, effectiveAclFenceSql),
      /serpvera_app must not own GSC tables or cascade parents/i,
    );
    await assertAclFenceNotRecorded(ownerSchema);
  });

  void it("fails closed if the runtime role inherits another role", async () => {
    await createFixture(membershipSchema, false);
    const quotedRole = quoteGeneratedRole(membershipRole);
    await withAdmin(async (client) => {
      await client.query(`CREATE ROLE ${quotedRole}`);
      await client.query(`GRANT ${quotedRole} TO serpvera_app`);
    });

    try {
      await assert.rejects(
        applySchemaMigration(membershipSchema, effectiveAclFenceSql),
        /serpvera_app must not be a member of another role/i,
      );
      await assertAclFenceNotRecorded(membershipSchema);
    } finally {
      await withAdmin(async (client) => {
        await client.query(`REVOKE ${quotedRole} FROM serpvera_app`);
        await client.query(`DROP ROLE ${quotedRole}`);
      });
    }
  });

  void it("aborts and preserves metrics when client-clock order conflicts with DB order", async () => {
    await createFixture(conflictSchema, true);

    await assert.rejects(
      applyPreflight(conflictSchema, migrationSql),
      /client-clock order that conflicts with database request order/i,
    );

    await withAdmin(async (client) => {
      await client.query(
        `SET LOCAL search_path TO ${quoteGeneratedSchema(conflictSchema)}, public`,
      );
      const result = await client.query<{ metrics: number; migrationRecorded: boolean }>(`
        SELECT (SELECT count(*)::int FROM gsc_query_metrics) AS metrics,
               EXISTS (
                 SELECT 1 FROM schema_migrations
                  WHERE version = '0019z_gsc_claim_order_preflight'
               ) AS "migrationRecorded"
      `);
      assert.deepEqual(result.rows[0], { metrics: 1, migrationRecorded: false });
    });
  });

  void it("allows ordered histories and records the preflight migration", async () => {
    await createFixture(safeSchema, false);
    await applyPreflight(safeSchema, migrationSql);

    await withAdmin(async (client) => {
      await client.query(`SET LOCAL search_path TO ${quoteGeneratedSchema(safeSchema)}, public`);
      const result = await client.query<{ metrics: number; migrationRecorded: boolean }>(`
        SELECT (SELECT count(*)::int FROM gsc_query_metrics) AS metrics,
               EXISTS (
                 SELECT 1 FROM schema_migrations
                  WHERE version = '0019z_gsc_claim_order_preflight'
               ) AS "migrationRecorded"
      `);
      assert.deepEqual(result.rows[0], { metrics: 1, migrationRecorded: true });
    });
  });

  void it("blocks runtime writes until cleanup and resumes them after 0021", async () => {
    await createFixture(guardSchema, false);
    const guardSql = await readFile(guardMigrationUrl, "utf8");
    const cleanupSql = await readFile(cleanupMigrationUrl, "utf8");
    const writeFenceSql = await readFile(writeFenceMigrationUrl, "utf8");
    const restoreWritesSql = await readFile(restoreWritesMigrationUrl, "utf8");
    const parentFenceSql = await readFile(parentFenceMigrationUrl, "utf8");
    const restoreParentDeletesSql = await readFile(restoreParentDeletesMigrationUrl, "utf8");
    const effectiveAclFenceSql = await readFile(effectiveAclFenceMigrationUrl, "utf8");
    const restoreAclBaselineSql = await readFile(restoreAclBaselineMigrationUrl, "utf8");
    await withAdmin(async (client) => {
      await client.query(
        `GRANT USAGE ON SCHEMA ${quoteGeneratedSchema(guardSchema)} TO serpvera_app`,
      );
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${quoteGeneratedSchema(guardSchema)}.organizations,
         ${quoteGeneratedSchema(guardSchema)}.projects,
         ${quoteGeneratedSchema(guardSchema)}.gsc_connections,
         ${quoteGeneratedSchema(guardSchema)}.gsc_sync_jobs,
         ${quoteGeneratedSchema(guardSchema)}.gsc_query_metrics TO serpvera_app`,
      );
      await client.query(
        `GRANT INSERT (id, organization_id, project_id, connection_id, window_start,
                       window_end, status, requested_at, started_at),
                UPDATE (status)
           ON ${quoteGeneratedSchema(guardSchema)}.gsc_sync_jobs TO PUBLIC`,
      );
    });
    await applySchemaMigration(guardSchema, effectiveAclFenceSql);
    await applySchemaMigration(guardSchema, parentFenceSql);
    await applySchemaMigration(guardSchema, writeFenceSql);
    await applySchemaMigration(guardSchema, guardSql);

    const privileges = await withAdmin(async (client) => {
      const result = await client.query<{
        canUpdate: boolean;
        canDeleteMetrics: boolean;
        canDeleteConnection: boolean;
        canDeleteProject: boolean;
        canDeleteOrganization: boolean;
        canUpdateAnyColumn: boolean;
        canInsertAnyColumn: boolean;
      }>(
        `SELECT has_table_privilege('serpvera_app', $1, 'UPDATE') AS "canUpdate",
                has_table_privilege('serpvera_app', $2, 'DELETE') AS "canDeleteMetrics",
                has_table_privilege('serpvera_app', $3, 'DELETE') AS "canDeleteConnection",
                has_table_privilege('serpvera_app', $4, 'DELETE') AS "canDeleteProject",
                has_table_privilege('serpvera_app', $5, 'DELETE') AS "canDeleteOrganization",
                has_any_column_privilege('serpvera_app', $1, 'UPDATE') AS "canUpdateAnyColumn",
                has_any_column_privilege('serpvera_app', $1, 'INSERT') AS "canInsertAnyColumn"`,
        [
          `${guardSchema}.gsc_sync_jobs`,
          `${guardSchema}.gsc_query_metrics`,
          `${guardSchema}.gsc_connections`,
          `${guardSchema}.projects`,
          `${guardSchema}.organizations`,
        ],
      );
      return result.rows[0];
    });
    assert.deepEqual(privileges, {
      canUpdate: false,
      canDeleteMetrics: false,
      canDeleteConnection: false,
      canDeleteProject: false,
      canDeleteOrganization: false,
      canUpdateAnyColumn: false,
      canInsertAnyColumn: false,
    });

    await assert.rejects(
      withAdmin(async (client) => {
        await client.query(`SET LOCAL search_path TO ${quoteGeneratedSchema(guardSchema)}, public`);
        await client.query("SET LOCAL ROLE serpvera_app");
        // Custom GUCs are user-settable; the write fence must remain effective.
        await client.query("SELECT set_config('app.winseo_gsc_migration', 'on', TRUE)");
        await client.query(`UPDATE gsc_sync_jobs SET status = 'FAILED' WHERE id = $1`, [
          earlierJobId,
        ]);
      }),
      /permission denied for table gsc_sync_jobs/i,
    );
    await assert.rejects(
      withAdmin(async (client) => {
        await client.query(`SET LOCAL search_path TO ${quoteGeneratedSchema(guardSchema)}, public`);
        await client.query("SET LOCAL ROLE serpvera_app");
        await client.query("SELECT set_config('app.winseo_gsc_migration', 'on', TRUE)");
        await client.query(
          `INSERT INTO gsc_sync_jobs
             (id, organization_id, project_id, connection_id, window_start, window_end,
              status, requested_at, started_at)
           VALUES ($1, $2, $3, $4, '2026-01-01', '2026-01-31', 'FAILED', now(), now())`,
          ["66666666-6666-4666-8666-666666666666", organizationId, projectId, connectionId],
        );
      }),
      /permission denied for table gsc_sync_jobs/i,
    );

    for (const [table, targetId] of [
      ["gsc_connections", connectionId],
      ["projects", projectId],
      ["organizations", organizationId],
    ] as const) {
      await assert.rejects(
        withAdmin(async (client) => {
          await client.query(
            `SET LOCAL search_path TO ${quoteGeneratedSchema(guardSchema)}, public`,
          );
          await client.query("SET LOCAL ROLE serpvera_app");
          await client.query("SELECT set_config('app.winseo_gsc_migration', 'on', TRUE)");
          await client.query(`DELETE FROM ${table} WHERE id = $1`, [targetId]);
        }),
        new RegExp(`permission denied for table ${table}`, "i"),
      );
      const remainingMetrics = await withAdmin(async (client) => {
        await client.query(`SET LOCAL search_path TO ${quoteGeneratedSchema(guardSchema)}, public`);
        const result = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM gsc_query_metrics",
        );
        return result.rows[0]?.count ?? -1;
      });
      assert.equal(remainingMetrics, 1, `${table} deletion must not cascade to metrics`);
    }

    await withAdmin(async (client) => {
      await client.query(`SET LOCAL search_path TO ${quoteGeneratedSchema(guardSchema)}, public`);
      await client.query("SELECT set_config('app.winseo_gsc_migration', 'on', TRUE)");
      await client.query(`UPDATE gsc_sync_jobs SET status = 'COMPLETED' WHERE id = $1`, [
        earlierJobId,
      ]);
      await client.query(`DELETE FROM gsc_query_metrics WHERE sync_job_id = $1`, [earlierJobId]);
    });

    await applySchemaMigration(guardSchema, cleanupSql);
    await applySchemaMigration(guardSchema, restoreWritesSql);
    await applySchemaMigration(guardSchema, restoreParentDeletesSql);
    await applySchemaMigration(guardSchema, restoreAclBaselineSql);

    await withAdmin(async (client) => {
      await client.query(`SET LOCAL search_path TO ${quoteGeneratedSchema(guardSchema)}, public`);
      await client.query("SET LOCAL ROLE serpvera_app");
      await client.query(`UPDATE gsc_sync_jobs SET status = 'FAILED' WHERE id = $1`, [
        earlierJobId,
      ]);
      const result = await client.query<{ guardTable: string | null; triggerCount: number }>(`
        SELECT to_regclass('${guardSchema}.gsc_migration_guard')::text AS "guardTable",
               (SELECT count(*)::int FROM pg_trigger
                 WHERE tgrelid IN ('${guardSchema}.gsc_sync_jobs'::regclass,
                                   '${guardSchema}.gsc_query_metrics'::regclass)
                   AND tgname IN ('gsc_sync_jobs_migration_guard',
                                  'gsc_query_metrics_migration_guard')) AS "triggerCount"
      `);
      assert.deepEqual(result.rows[0], { guardTable: null, triggerCount: 0 });
    });
  });

  void it("blocks a client-clock conflict even when a historical metric falls outside its source window", async () => {
    await createFixture(outOfWindowSchema, true, {
      firstStart: "2026-01-01",
      firstEnd: "2026-01-10",
      secondStart: "2026-01-11",
      secondEnd: "2026-01-20",
      metricDate: "2026-01-15",
    });
    const preflightSql = await readFile(migrationUrl, "utf8");
    const guardSql = await readFile(guardMigrationUrl, "utf8");
    await applyPreflight(outOfWindowSchema, preflightSql);

    await assert.rejects(
      applySchemaMigration(outOfWindowSchema, guardSql),
      /client-clock order that conflicts with database request order/i,
    );

    await withAdmin(async (client) => {
      await client.query(
        `SET LOCAL search_path TO ${quoteGeneratedSchema(outOfWindowSchema)}, public`,
      );
      const result = await client.query<{ metrics: number; guardTable: string | null }>(`
        SELECT (SELECT count(*)::int FROM gsc_query_metrics) AS metrics,
               to_regclass('${outOfWindowSchema}.gsc_migration_guard')::text AS "guardTable"
      `);
      assert.deepEqual(result.rows[0], { metrics: 1, guardTable: null });
    });
  });
});
