// ─── Store factory ───
// Selects the backing store explicitly. Production uses PostgreSQL (RLS-enforced);
// memory is test-only. The choice is driven by STORE_DRIVER env so the production
// dependency is explicit and never silently falls back to memory.

import type { ApiStores } from "./types.ts";
import { createMemoryStores } from "./memory.ts";
import { createDbStores, initDbStores } from "./db.ts";
import { parseNodeEnv } from "@serpvera/config";

export type StoreDriver = "postgres" | "memory";

export function resolveStoreDriver(env: NodeJS.ProcessEnv = process.env): StoreDriver {
  const raw = (env.STORE_DRIVER ?? "").toLowerCase();
  const nodeEnv = parseNodeEnv(env.NODE_ENV);

  if (raw && raw !== "memory" && raw !== "postgres") {
    throw new Error("STORE_DRIVER must be postgres or memory.");
  }

  const driver = raw ? (raw as StoreDriver) : nodeEnv === "production" ? "postgres" : "memory";
  assertStoreDriverAllowed(driver, nodeEnv);
  return driver;
}

export function assertStoreDriverAllowed(driver: StoreDriver, nodeEnv: string): void {
  const validatedNodeEnv = parseNodeEnv(nodeEnv);
  if (validatedNodeEnv === "production" && driver !== "postgres") {
    throw new Error("The memory store is not allowed in production.");
  }
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
  const nodeEnv = parseNodeEnv(process.env.NODE_ENV);
  const driver = opts.driver ?? resolveStoreDriver();
  assertStoreDriverAllowed(driver, nodeEnv);
  if (driver === "postgres") {
    const connectionString = opts.pgConnectionString ?? process.env.DATABASE_URL;
    // Local dev/CI: no DATABASE_URL → unix-socket peer auth (no password, so no
    // secret is ever committed). Production supplies DATABASE_URL pointing at the
    // LOGIN-enabled serpvera_app role (password from the secret manager).
    initDbStores({
      connectionString,
      host: opts.pgSocketDir ?? process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
      database: opts.pgDatabase ?? process.env.PGDATABASE ?? "serpvera_dev",
      runtimeRole: opts.runtimeRole ?? process.env.DB_RUNTIME_ROLE ?? "serpvera_app",
      maxPool: opts.maxPool ?? 10,
    });
    return createDbStores();
  }
  return createMemoryStores();
}

export { createMemoryStores } from "./memory.ts";
export { createDbStores, initDbStores, closeDbStores } from "./db.ts";
export * from "./types.ts";
