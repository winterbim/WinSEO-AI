import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { closePool, configurePool, withAdmin } from "./index.ts";

const migrationUrl = new URL("../migrations/0032_gsc_trust_reset.sql", import.meta.url);
const schema = `gsc_trust_reset_${process.pid}_${Math.random().toString(16).slice(2)}`;

function quotedSchema(): string {
  if (!/^gsc_trust_reset_[a-z0-9_]+$/.test(schema)) {
    throw new Error("Unexpected generated schema name.");
  }
  return `"${schema}"`;
}

void describe("0032 GSC trust reset migration", () => {
  let migrationSql = "";

  before(async () => {
    configurePool({
      host: process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
      port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
      user: process.env.PGUSER,
      database: process.env.PGDATABASE ?? "serpvera_dev",
      maxPool: 2,
    });
    migrationSql = await readFile(migrationUrl, "utf8");
  });

  after(async () => {
    try {
      await withAdmin(async (client) => {
        await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema()} CASCADE`);
      });
    } finally {
      await closePool();
    }
  });

  void it("resets every preexisting trusted marker and defaults future jobs to unverified", async () => {
    await withAdmin(async (client) => {
      await client.query(`CREATE SCHEMA ${quotedSchema()}`);
      await client.query(`SET LOCAL search_path TO ${quotedSchema()}, public`);
      await client.query(`
        CREATE TABLE gsc_sync_jobs (
          id integer PRIMARY KEY,
          status text NOT NULL,
          ingestion_version integer NOT NULL DEFAULT 1
        );
        CREATE TABLE schema_migrations (version text PRIMARY KEY, checksum text);
        INSERT INTO gsc_sync_jobs (id, status, ingestion_version)
        VALUES (1, 'COMPLETED', 1), (2, 'RUNNING', 1), (3, 'COMPLETED', 0);
      `);
    });

    const body = migrationSql.replace(/^\s*BEGIN\s*;/i, "").replace(/COMMIT\s*;\s*$/i, "");
    await withAdmin(async (client) => {
      await client.query(`SET LOCAL search_path TO ${quotedSchema()}, public`);
      await client.query(body);
      const result = await client.query<{
        id: number;
        status: string;
        ingestionVersion: number;
      }>(`
        SELECT id, status, ingestion_version AS "ingestionVersion"
          FROM gsc_sync_jobs
         ORDER BY id
      `);
      const column = await client.query<{ columnDefault: string | null }>(`
        SELECT column_default AS "columnDefault"
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'gsc_sync_jobs'
           AND column_name = 'ingestion_version'
      `);
      const ledger = await client.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = '0032_gsc_trust_reset'",
      );

      assert.deepEqual(result.rows, [
        { id: 1, status: "COMPLETED", ingestionVersion: 0 },
        { id: 2, status: "RUNNING", ingestionVersion: 0 },
        { id: 3, status: "COMPLETED", ingestionVersion: 0 },
      ]);
      assert.match(column.rows[0]?.columnDefault ?? "", /0/);
      assert.deepEqual(ledger.rows, [{ version: "0032_gsc_trust_reset" }]);
    });
  });
});
