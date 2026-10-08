#!/usr/bin/env bash
set -euo pipefail

umask 077
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/winseo-oauth-log-privacy.XXXXXXXX")"
log_path="$temp_dir/routes.log"
leak_path="$temp_dir/leak.log"
trap 'rm -f -- "$log_path" "$leak_path"; rmdir -- "$temp_dir" 2>/dev/null || true' EXIT

if [ "$(stat -c '%a' "$temp_dir")" != "700" ]; then
  printf 'OAUTH_QUERY_TEMP_PERMISSIONS_FAILED\n'
  exit 1
fi

node --test scripts/oauth-log-privacy-check.test.mjs scripts/disposable-db-url.test.mjs

run_gsc_route_tests() {
  if [ -n "${DATABASE_URL:-}" ]; then
    node scripts/assert-disposable-db-url.mjs
    pnpm --filter @serpvera/api exec node --import ./src/test-env.ts \
      --experimental-strip-types --test --test-concurrency=1 src/gsc-live-routes.test.ts
  else
    env -u DATABASE_URL \
      PG_SOCKET_DIR="${PG_SOCKET_DIR:-/tmp/winseo-pgsocket}" \
      PGPORT="${PGPORT:-55432}" \
      PGUSER="${PGUSER:-wina}" \
      PGDATABASE="${PGDATABASE:-serpvera_dev}" \
      pnpm --filter @serpvera/api exec node --import ./src/test-env.ts \
        --experimental-strip-types --test --test-concurrency=1 src/gsc-live-routes.test.ts
  fi
}

if run_gsc_route_tests >"$log_path" 2>&1; then
  test_status=0
else
  test_status=$?
fi

if [ "$test_status" -ne 0 ]; then
  printf 'GSC_ROUTE_TESTS_FAILED exit=%s\n' "$test_status"
  exit "$test_status"
fi

node scripts/check-oauth-log-privacy.mjs "$log_path"

set +e
error_output="$(node scripts/check-oauth-log-privacy.mjs "${log_path}.missing" 2>&1)"
error_status=$?
set -e
if [ "$error_status" -ne 2 ] || [ "$error_output" != "OAUTH_QUERY_SCAN_ERROR" ]; then
  printf 'OAUTH_QUERY_SCAN_ERROR_GATE_FAILED\n'
  exit 1
fi

printf 'GET /v1/gsc/oauth/callback?code=fixture-secret\n' >"$leak_path"
set +e
leak_output="$(node scripts/check-oauth-log-privacy.mjs "$leak_path" 2>&1)"
leak_status=$?
set -e
if [ "$leak_status" -ne 1 ] || [ "$leak_output" != "OAUTH_QUERY_LEAK_FOUND" ]; then
  printf 'OAUTH_QUERY_LEAK_GATE_FAILED\n'
  exit 1
fi

printf 'GSC_ROUTE_TESTS_OK\n'
