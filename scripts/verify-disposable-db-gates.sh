#!/usr/bin/env bash
set -euo pipefail

: "${PG_SOCKET_DIR:?Set PG_SOCKET_DIR to the disposable PostgreSQL socket directory}"
: "${PGPORT:?Set PGPORT to the disposable PostgreSQL port}"
: "${PGUSER:?Set PGUSER to the disposable PostgreSQL role}"
: "${PGDATABASE:?Set PGDATABASE to the disposable PostgreSQL database}"

printf 'GATE_START PostgreSQL identity and migration ledger\n'
psql -h "$PG_SOCKET_DIR" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
  -v ON_ERROR_STOP=1 <<'SQL'
SELECT current_database() AS database,
       current_user AS role,
       current_setting('port') AS port;

DO $migration_gate$
DECLARE
  applied_count INTEGER;
BEGIN
  SELECT count(*)::INTEGER
    INTO applied_count
    FROM schema_migrations
   WHERE version = ANY(ARRAY[
     '0019w_gsc_effective_acl_fence',
     '0019x_gsc_parent_delete_fence',
     '0019y_gsc_sync_write_fence',
     '0019z_gsc_claim_order_preflight',
     '0019zz_gsc_sync_migration_guard',
     '0020_gsc_sync_claim_order',
     '0021_remove_gsc_sync_migration_guard',
     '0022_restore_gsc_runtime_writes',
     '0023_restore_gsc_parent_deletes',
     '0024_restore_gsc_acl_baseline'
   ]);

  IF applied_count <> 10 THEN
    RAISE EXCEPTION 'Expected 10 GSC migration records, found %', applied_count;
  END IF;
END
$migration_gate$;

SELECT string_agg(version, ', ' ORDER BY version) AS gsc_migrations
  FROM schema_migrations
 WHERE version LIKE '0019%gsc%'
    OR version LIKE '002%gsc%';
SQL
printf 'GATE_PASS PostgreSQL identity and migration ledger\n'

printf 'GATE_START format:check\n'
pnpm format:check
printf 'GATE_PASS format:check\n'
printf 'GATE_START git diff --check\n'
git diff --check
printf 'GATE_PASS git diff --check\n'
printf 'GATE_START workspace lint (cache disabled)\n'
pnpm exec turbo lint --force
printf 'GATE_PASS workspace lint (cache disabled)\n'
printf 'GATE_START workspace typecheck (cache disabled)\n'
pnpm exec turbo typecheck --force
printf 'GATE_PASS workspace typecheck (cache disabled)\n'
printf 'GATE_START workspace tests (cache disabled)\n'
env -u DATABASE_URL \
  PG_SOCKET_DIR="$PG_SOCKET_DIR" PGPORT="$PGPORT" PGUSER="$PGUSER" PGDATABASE="$PGDATABASE" \
  pnpm exec turbo test --concurrency=1 --env-mode=loose --force
printf 'GATE_PASS workspace tests (cache disabled)\n'
printf 'GATE_START production build\n'
pnpm exec turbo build --force
printf 'GATE_PASS production build\n'
printf 'GATE_START dependency audit (high severity)\n'
pnpm audit --audit-level=high
printf 'GATE_PASS dependency audit (high severity)\n'
