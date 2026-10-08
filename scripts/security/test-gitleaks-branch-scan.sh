#!/usr/bin/env bash
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "Gitleaks binary is unavailable; cannot verify branch-graph coverage."
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
repo="$tmp_dir/repo"
mkdir -p "$repo"
git -C "$repo" init --quiet --initial-branch=base
git -C "$repo" config user.name "WinSEO Security Test"
git -C "$repo" config user.email "security-test@example.invalid"

printf 'baseline fixture\n' >"$repo/baseline.txt"
git -C "$repo" add baseline.txt
git -C "$repo" commit --quiet -m "base"
base_sha="$(git -C "$repo" rev-parse HEAD)"

git -C "$repo" switch --quiet -c side-branch
fixture_suffix="$(printf '%s' "${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}" | sha256sum | cut -c1-12 | tr '[:lower:]' '[:upper:]')"
printf 'WINSEO_FIXTURE_SECRET_%s\n' "$fixture_suffix" >"$repo/side-branch.txt"
git -C "$repo" add side-branch.txt
git -C "$repo" commit --quiet -m "side branch fixture"

git -C "$repo" switch --quiet base
git -C "$repo" merge --quiet --no-ff side-branch -m "merge side branch"
head_sha="$(git -C "$repo" rev-parse HEAD)"

cat >"$tmp_dir/gitleaks-fixture.toml" <<'EOF'
title = "WinSEO branch graph fixture"

[[rules]]
id = "winseo-branch-coverage-fixture"
description = "Synthetic token used only in an ephemeral Git test repository"
regex = '''WINSEO_FIXTURE_SECRET_[A-F0-9]{12}'''
secretGroup = 0
entropy = 0.0
EOF

if gitleaks git \
  --config "$tmp_dir/gitleaks-fixture.toml" \
  --redact \
  --exit-code 2 \
  --log-opts="$head_sha ^$base_sha" \
  "$repo" >"$tmp_dir/gitleaks.log" 2>&1; then
  echo "Gitleaks missed a synthetic secret in a merged side-branch commit."
  exit 1
else
  scan_status=$?
fi

if [[ "$scan_status" -ne 2 ]]; then
  echo "Gitleaks branch-graph fixture failed with status $scan_status."
  exit 1
fi

echo "Gitleaks detected the synthetic side-branch secret in the complete commit range."
