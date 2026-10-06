#!/usr/bin/env tsx
/**
 * Migration runner — applies packages/db/migrations/*.sql in version order,
 * idempotently, recording each in the schema_migrations ledger.
 *
 * MUST run as an ADMIN role (superuser/DDL-capable), never the runtime role.
 * Local dev: peer-auth unix socket (no password, no committed secret):
 *   node --experimental-strip-types packages/db/src/migrate.ts
 * Or with an explicit admin url:
 *   DATABASE_URL=postgresql://postgres@/serpvera_dev?host=/var/run/postgresql ...
 *
 * The SQL files under migrations/ are the SINGLE SOURCE OF TRUTH for schema.
 * This runner does not embed DDL.
 */
import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

function buildAdminPool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (url) return new pg.Pool({ connectionString: url, max: 1 });
  // Peer-auth socket default (local dev). No password.
  return new pg.Pool({
    host: process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
    database: process.env.PGDATABASE ?? "serpvera_dev",
    max: 1,
  });
}

async function main() {
  const pool = buildAdminPool();
  try {
    const me = await pool.query<{ u: string; rolsuper: boolean }>(
      "SELECT current_user AS u, rolsuper FROM pg_roles WHERE rolname=current_user",
    );
    const admin = me.rows[0];
    if (!admin) {
      throw new Error("Cannot determine the current database role");
    }
    console.log(`Migrating as '${admin.u}' (superuser=${admin.rolsuper})`);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    // Ensure the ledger exists before we consult it (bootstrap chicken-and-egg).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_by TEXT NOT NULL DEFAULT current_user,
        checksum   TEXT
      );
    `);

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const already = await pool.query(
        "SELECT 1 FROM schema_migrations WHERE version=$1",
        [version],
      );
      if ((already.rowCount ?? 0) > 0) {
        console.log(`↷ skip ${version} (already applied)`);
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
      await pool.query(sql);
      // Safety net: migration files self-record in schema_migrations (convention
      // in 0001+). Verify it actually happened — a file that forgets the INSERT
      // would otherwise re-apply on every run while claiming success.
      const recorded = await pool.query(
        "SELECT 1 FROM schema_migrations WHERE version=$1",
        [version],
      );
      if ((recorded.rowCount ?? 0) === 0) {
        await pool.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, 'sha256:pending') ON CONFLICT (version) DO NOTHING",
          [version],
        );
        console.warn(`⚠ ${version} self- recorded ledger entry missing — recorded by runner`);
      }
      console.log(`✓ applied ${version}`);
    }
    console.log("✅ Migrations up to date");
  } catch (err) {
    console.error("❌ Migration failed:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
