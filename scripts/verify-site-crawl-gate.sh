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

printf 'GATE_START disposable PostgreSQL migrations with DATABASE_URL unset\n'
env -u DATABASE_URL \
  PG_SOCKET_DIR="$PG_SOCKET_DIR" \
  PGPORT="$PGPORT" \
  PGUSER="$PGUSER" \
  PGDATABASE="$PGDATABASE" \
  pnpm --filter @serpvera/db db:migrate
printf 'GATE_PASS disposable PostgreSQL migrations db=%s port=%s\n' "$PGDATABASE" "$PGPORT"

printf 'GATE_START disposable PostgreSQL migration state\n'
migration_0028=$(psql -X -h "$PG_SOCKET_DIR" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
  -v ON_ERROR_STOP=1 -Atc "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0028_crawl_template_groups')")
if [[ "$migration_0028" != "t" ]]; then
  echo "Required migration 0028_crawl_template_groups is not applied." >&2
  exit 1
fi
migration_0029=$(psql -X -h "$PG_SOCKET_DIR" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
  -v ON_ERROR_STOP=1 -Atc "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = '0029_crawl_template_groups_comment')")
if [[ "$migration_0029" != "t" ]]; then
  echo "Required migration 0029_crawl_template_groups_comment is not applied." >&2
  exit 1
fi
printf 'GATE_PASS disposable PostgreSQL migration state db=%s port=%s migrations=0028,0029\n' "$PGDATABASE" "$PGPORT"
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
