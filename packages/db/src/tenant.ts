import type pg from "pg";

/**
 * Set the current tenant organization for RLS enforcement.
 * Must be called at the start of every tenant-scoped request transaction.
 *
 * @param clientOrPool - the query executor (pool or transaction client)
 * @param organizationId - UUID of the tenant organization
 */
export async function setTenant(
  clientOrPool: pg.Pool | pg.PoolClient,
  organizationId: string,
): Promise<void> {
  // SET LOCAL scopes the setting to the current transaction/session
  // The RLS policy reads this via current_setting('app.current_organization_id')
  await clientOrPool.query("SELECT set_config('app.current_organization_id', $1, true)", [
    organizationId,
  ]);
}

/**
 * Clear tenant context (for public requests).
 */
export async function clearTenant(clientOrPool: pg.Pool | pg.PoolClient): Promise<void> {
  await clientOrPool.query("SELECT set_config('app.current_organization_id', '', true)");
}
