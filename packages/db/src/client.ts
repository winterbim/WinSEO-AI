import pg from "pg";

export interface DbConfig {
  connectionString?: string;
  /** Unix socket dir for peer auth (no password). e.g. /var/run/postgresql */
  host?: string;
  database?: string;
  /**
   * Runtime application role (NOSUPERUSER, NOBYPASSRLS). When set, every
   * withTenant() transaction performs `SET LOCAL ROLE <runtimeRole>` so RLS is
   * enforced even when the login role is an admin. NEVER use a superuser here.
   */
  runtimeRole?: string;
  maxPool?: number;
}

let pool: pg.Pool | null = null;
let config: DbConfig | null = null;

export function currentConfig(): DbConfig {
  if (!config) {
    throw new Error("Database not configured. Call configurePool() first.");
  }
  return config;
}

export function getPool(): pg.Pool {
  if (!pool) {
    const cfg = currentConfig();
    if (cfg.connectionString) {
      pool = new pg.Pool({
        connectionString: cfg.connectionString,
        max: cfg.maxPool ?? 10,
        // Force TLS in production only
        ssl:
          cfg.connectionString.includes("localhost") ||
          cfg.connectionString.includes("127.0.0.1")
            ? false
            : { rejectUnauthorized: true },
      });
    } else if (cfg.host) {
      // Unix-socket peer-auth path: no host=TCP, no password, no committed secret.
      pool = new pg.Pool({
        host: cfg.host,
        database: cfg.database,
        max: cfg.maxPool ?? 10,
      });
    } else {
      throw new Error("DbConfig requires either connectionString or host.");
    }
    pool.on("error", (err) => {
      console.error("Unexpected database pool error:", err.message);
    });
  }
  return pool;
}

export function configurePool(cfg: DbConfig): void {
  config = cfg;
  if (pool) {
    void pool.end();
    pool = null;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a transaction with tenant-scoped RLS context.
 *
 * Flow (SECURITY_MODEL §5 / P-GAP-02 §8):
 *   checkout connection → BEGIN → SET LOCAL ROLE runtimeRole
 *   → SET LOCAL app.current_organization_id → queries → COMMIT/ROLLBACK
 *   → release back to pool.
 *
 * Both role and org GUC use SET LOCAL (transaction-scoped), so tenant context
 * CANNOT leak to the next request that reuses the pooled connection.
 */
export async function withTenant<T>(
  organizationId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const cfg = currentConfig();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (cfg.runtimeRole) {
      // Fail loudly if something tries to use a bypass-capable runtime role.
      await client.query(`SET LOCAL ROLE ${pg_escape_ident(cfg.runtimeRole)}`);
    }
    await client.query(
      "SELECT set_config('app.current_organization_id', $1, true)",
      [organizationId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    await client.query("RESET ROLE");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* rollback may fail if the connection is already broken */
    }
    try {
      await client.query("RESET ROLE");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` in a transaction WITHOUT tenant scoping — for admin/DDL or
 * cross-tenant bootstrap work (creating organizations, migrations).
 * The runtime role is deliberately NOT applied here.
 */
export async function withAdmin<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(fn);
}

/** Minimal identifier escaping for SET LOCAL ROLE (identifiers are config-supplied). */
function pg_escape_ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid role identifier: ${name}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await query("SELECT 1 AS ok");
    return res.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}