// ─── Store factory ───
// Selects the backing store explicitly. Production uses PostgreSQL (RLS-enforced);
// memory is test-only. The choice is driven by STORE_DRIVER env so the production
// dependency is explicit and never silently falls back to memory.

import type { ApiStores } from "./types.ts";
import { createMemoryStores } from "./memory.ts";
import { createDbStores, initDbStores } from "./db.ts";

export type StoreDriver = "postgres" | "memory";

export function resolveStoreDriver(): StoreDriver {
  const raw = (process.env.STORE_DRIVER ?? "").toLowerCase();
  if (raw === "memory") return "memory";
  if (raw === "postgres") return "postgres";
  // Default: if a real DB is reachable config exists, use postgres in production.
  return process.env.NODE_ENV === "production" ? "postgres" : "memory";
}

export interface CreateStoresOptions {
  driver?: StoreDriver;
  /** For local dev peer-socket connection (no password). */
  pgSocketDir?: string;
  pgDatabase?: string;
  pgConnectionString?: string;
  runtimeRole?: string;
  maxPool?: number;
}

export function createStores(opts: CreateStoresOptions = {}): ApiStores {
  const driver = opts.driver ?? resolveStoreDriver();
  if (driver === "postgres") {
    const connectionString = opts.pgConnectionString ?? process.env.DATABASE_URL;
    // Local dev/CI: no DATABASE_URL → unix-socket peer auth (no password, so no
    // secret is ever committed). Production supplies DATABASE_URL pointing at the
    // LOGIN-enabled serpvera_app role (password from the secret manager).
    initDbStores({
      connectionString,
      host: opts.pgSocketDir ?? process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
      database: opts.pgDatabase ?? process.env.PGDATABASE ?? "serpvera_dev",
      runtimeRole:
        opts.runtimeRole ?? process.env.DB_RUNTIME_ROLE ?? "serpvera_app",
      maxPool: opts.maxPool ?? 10,
    });
    return createDbStores();
  }
  return createMemoryStores();
}

export { createMemoryStores } from "./memory.ts";
export { createDbStores, initDbStores, closeDbStores } from "./db.ts";
export * from "./types.ts";
