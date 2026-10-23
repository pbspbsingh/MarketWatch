#!/usr/bin/env bash
# Fixed verification entry point for Trade Logs work. Safe to approve by path:
# no command arguments, dependency installation, app startup, or database changes.
set -euo pipefail

if (( $# != 0 )); then
  printf 'Usage: %s (no arguments)\n' "$0" >&2
  exit 2
fi

readonly project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_dir"

for required_command in node npm cargo; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$required_command" >&2
    exit 1
  fi
done

if [[ ! -d frontend/node_modules ]]; then
  printf 'Install frontend dependencies before running this check.\n' >&2
  exit 1
fi

printf '\nChecking Rust formatting…\n'
cargo fmt --all -- --check

printf '\nRunning frontend regression tests…\n'
node --test frontend/scripts/*.test.mjs

printf '\nChecking TypeScript and lint…\n'
npm --prefix frontend run check

printf '\nBuilding the frontend…\n'
npm --prefix frontend run build

printf '\nChecking statistics interactions and viewport layouts in Chrome…\n'
node frontend/scripts/trade-statistics-browser.mjs

printf '\nRunning Rust tests with cached SQL validation…\n'
SQLX_OFFLINE=true cargo test --locked --offline

printf '\nAll Trade Logs checks passed.\n'
