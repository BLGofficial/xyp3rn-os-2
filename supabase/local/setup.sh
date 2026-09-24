#!/usr/bin/env bash
# Local Postgres 16 + pgvector for Debian/Ubuntu containers (the Claude Code cloud env).
# Idempotent: safe to run at the start of every session. The container is ephemeral, so
# the DB is rebuilt from migrations each time — nothing here is precious.
# On a machine with the Supabase CLI, `supabase start` replaces this script; point
# XYP_DATABASE_URL at postgres://postgres:postgres@127.0.0.1:54322/postgres instead.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f /usr/share/postgresql/16/extension/vector.control ]; then
  apt-get install -y -q postgresql-16 postgresql-16-pgvector >/dev/null \
    || { apt-get update -q >/dev/null && apt-get install -y -q postgresql-16 postgresql-16-pgvector >/dev/null; }
fi

pg_ctlcluster 16 main start 2>/dev/null || true
until pg_isready -q -h 127.0.0.1 -p 5432; do sleep 0.2; done

# Local-only credentials; never used against a remote project.
su postgres -c "psql -q -v ON_ERROR_STOP=1 -c \"alter role postgres password 'postgres'\""
su postgres -c "psql -q -v ON_ERROR_STOP=1 -f -" < supabase-roles.sql
# template1 carries the default privileges into every test database created later.
su postgres -c "psql -q -v ON_ERROR_STOP=1 -d template1 -f -" < supabase-roles.sql

echo "local db ready: postgres://postgres:postgres@127.0.0.1:5432/postgres"
