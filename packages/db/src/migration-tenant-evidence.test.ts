import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { closePool, configurePool, withAdmin } from "./index.ts";

const migrationUrl = new URL("../migrations/0015_finding_evidence_tenant_rls.sql", import.meta.url);
const suffix = `${process.pid}_${Math.random().toString(16).slice(2)}`;
const mismatchSchema = `migration_probe_mismatch_${suffix}`;
const validSchema = `migration_probe_valid_${suffix}`;
const organizationA = "11111111-1111-4111-8111-111111111111";
const organizationB = "22222222-2222-4222-8222-222222222222";
const findingId = "33333333-3333-4333-8333-333333333333";
const evidenceId = "44444444-4444-4444-8444-444444444444";

function quoteGeneratedSchema(schema: string): string {
  if (!/^migration_probe_[a-z0-9_]+$/.test(schema)) {
    throw new Error("Unexpected generated schema name.");
  }
  return `"${schema}"`;
}

async function createLegacyFixture(schema: string, evidenceOrganization: string): Promise<void> {
  const quoted = quoteGeneratedSchema(schema);
  await withAdmin(async (client) => {
    await client.query(`CREATE SCHEMA ${quoted}`);
    await client.query(`SET LOCAL search_path TO ${quoted}, public`);
    await client.query(`
      CREATE TABLE organizations (id uuid PRIMARY KEY);
      CREATE TABLE findings (
        id uuid NOT NULL,
        organization_id uuid NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (organization_id, id)
      );
      CREATE TABLE evidence_items (
        id uuid NOT NULL,
        organization_id uuid NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (organization_id, id)
      );
      CREATE TABLE finding_evidence (
        finding_id uuid NOT NULL,
        evidence_id uuid NOT NULL,
        relation text NOT NULL,
        PRIMARY KEY (finding_id, evidence_id)
      );
      CREATE TABLE schema_migrations (version text PRIMARY KEY, checksum text);
      INSERT INTO organizations (id) VALUES ('${organizationA}'), ('${organizationB}');
      INSERT INTO findings (id, organization_id) VALUES ('${findingId}', '${organizationA}');
      INSERT INTO evidence_items (id, organization_id) VALUES ('${evidenceId}', '${evidenceOrganization}');
      INSERT INTO finding_evidence (finding_id, evidence_id, relation)
      VALUES ('${findingId}', '${evidenceId}', 'supports');
    `);
  });
}

async function applyTenantEvidenceMigration(schema: string, sql: string): Promise<void> {
  const quoted = quoteGeneratedSchema(schema);
  const body = sql.replace(/^\s*BEGIN\s*;/i, "").replace(/COMMIT\s*;\s*$/i, "");
  await withAdmin(async (client) => {
    await client.query(`SET LOCAL search_path TO ${quoted}, public`);
    await client.query(body);
  });
}

async function dropFixture(schema: string): Promise<void> {
  const quoted = quoteGeneratedSchema(schema);
  await withAdmin(async (client) => {
    await client.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
  });
}

void describe("0015 finding evidence tenant migration", () => {
  let migrationSql = "";

  before(async () => {
    configurePool({
      host: process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
      database: process.env.PGDATABASE ?? "serpvera_dev",
      maxPool: 2,
    });
    migrationSql = await readFile(migrationUrl, "utf8");
  });

  after(async () => {
    try {
      await dropFixture(mismatchSchema);
      await dropFixture(validSchema);
    } finally {
      await closePool();
    }
  });

  void it("aborts atomically and preserves a legacy cross-organization relation", async () => {
    await createLegacyFixture(mismatchSchema, organizationB);

    await assert.rejects(
      applyTenantEvidenceMigration(mismatchSchema, migrationSql),
      /existing links cross organizations/i,
    );

    await withAdmin(async (client) => {
      await client.query(
        `SET LOCAL search_path TO ${quoteGeneratedSchema(mismatchSchema)}, public`,
      );
      const result = await client.query<{ organizationColumn: boolean; relations: number }>(`
        SELECT
          EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'finding_evidence'
               AND column_name = 'organization_id'
          ) AS "organizationColumn",
          (SELECT count(*)::int FROM finding_evidence) AS relations
      `);
      assert.deepEqual(result.rows[0], { organizationColumn: false, relations: 1 });
    });
  });

  void it("backfills valid legacy links and applies forced tenant RLS", async () => {
    await createLegacyFixture(validSchema, organizationA);
    await applyTenantEvidenceMigration(validSchema, migrationSql);

    await withAdmin(async (client) => {
      await client.query(`SET LOCAL search_path TO ${quoteGeneratedSchema(validSchema)}, public`);
      const result = await client.query<{
        organizationId: string;
        rlsEnabled: boolean;
        rlsForced: boolean;
        policyCount: number;
      }>(`
        SELECT fe.organization_id::text AS "organizationId",
               c.relrowsecurity AS "rlsEnabled",
               c.relforcerowsecurity AS "rlsForced",
               (SELECT count(*)::int FROM pg_policies p
                 WHERE p.schemaname = current_schema()
                   AND p.tablename = 'finding_evidence'
                   AND p.policyname = 'tenant_isolation'
                   AND p.cmd = 'ALL'
                   AND p.qual IS NOT NULL
                   AND p.with_check IS NOT NULL) AS "policyCount"
          FROM finding_evidence fe
          JOIN pg_class c ON c.oid = 'finding_evidence'::regclass
      `);
      assert.deepEqual(result.rows[0], {
        organizationId: organizationA,
        rlsEnabled: true,
        rlsForced: true,
        policyCount: 1,
      });
    });
  });
});
