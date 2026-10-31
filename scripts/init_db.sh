#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$repo_root/data"

for db in market user institutional; do
  (
    cd "$repo_root/crates/db/$db"
    cargo sqlx database setup
  )
done
