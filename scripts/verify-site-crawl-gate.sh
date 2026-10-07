#!/usr/bin/env bash
set -euo pipefail

: "${PG_SOCKET_DIR:?Set PG_SOCKET_DIR to the disposable PostgreSQL socket directory}"
: "${PGPORT:?Set PGPORT to the disposable PostgreSQL port}"
: "${PGUSER:?Set PGUSER to the disposable PostgreSQL role}"
: "${PGDATABASE:?Set PGDATABASE to the disposable PostgreSQL database}"

case "$PGDATABASE" in
  *_dev|*_test) ;;
  *) echo "Refusing to run the site crawl gate against non-development database '$PGDATABASE'." >&2; exit 2 ;;
esac
case "$PG_SOCKET_DIR" in
  /tmp/*) ;;
  *) echo "Refusing to run the site crawl gate outside a local temporary PostgreSQL socket." >&2; exit 2 ;;
esac

printf 'GATE_START disposable PostgreSQL migration state\n'
migration_0027=$(psql -X -h "$PG_SOCKET_DIR" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
  -v ON_ERROR_STOP=1 -Atc "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0027_crawl_run_coverage')")
if [[ "$migration_0027" != "t" ]]; then
  echo "Required migration 0027_crawl_run_coverage is not applied." >&2
  exit 1
fi
printf 'GATE_PASS disposable PostgreSQL migration state db=%s port=%s migration=0027\n' "$PGDATABASE" "$PGPORT"
printf 'GATE_START workspace tests with DATABASE_URL unset; PostgreSQL socket/database explicitly pinned\n'

pnpm format:check
git diff --check
pnpm lint
pnpm build
pnpm typecheck
env -u DATABASE_URL \
  PG_SOCKET_DIR="$PG_SOCKET_DIR" \
  PGPORT="$PGPORT" \
  PGUSER="$PGUSER" \
  PGDATABASE="$PGDATABASE" \
  pnpm exec turbo test --concurrency=1 --env-mode=loose --force
