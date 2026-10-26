#!/usr/bin/env bash
# Run from the crate directory. SQLx reads its .env and sqlx.toml, creates the
# configured local database if missing, and applies that crate's migrations.
set -euo pipefail
cargo sqlx database setup "$@"
