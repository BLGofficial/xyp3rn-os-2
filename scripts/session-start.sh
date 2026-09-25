#!/usr/bin/env bash
# SessionStart hook (.claude/settings.json): rebuilds the local dev database in a fresh cloud
# container — Postgres 16 + pgvector, migrations, the build guide and the X3LIUS manifest
# admitted through the gate, embeddings. The container is ephemeral, so without this every new
# session starts with no DB.
# Cloud sessions only (CLAUDE_CODE_REMOTE=true): on a developer machine it does nothing, so it
# can never touch a local database you didn't ask it to.
# Idempotent: on a warm container every step is a no-op (noop ingests, nothing to embed).
# Never fails the session: errors are summarized on stdout, details in .local-db/session-start.log.
set -uo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$(dirname "$0")/.."
mkdir -p .local-db
LOG=.local-db/session-start.log
: > "$LOG"
failed=()
step() {
  local name=$1; shift
  echo "== $name" >> "$LOG"
  "$@" >> "$LOG" 2>&1 || failed+=("$name")
}

[ -d node_modules ] || step install pnpm install --frozen-lockfile
step db:setup ./supabase/local/setup.sh
step db:up pnpm -s db:up
step ingest:guide pnpm -s ingest --file XYP3RN_Agentic_OS_Build_Sequence.pdf --origin first_party
step ingest:x3lius pnpm -s ingest --file records/x3lius/music-system.manifest.yaml --origin first_party
step ingest:tech pnpm -s ingest --file tech/tech.manifest.yaml --origin first_party
step embed pnpm -s embed

if [ ${#failed[@]} -eq 0 ]; then
  echo "session-start: local DB ready (migrations applied, build guide + X3LIUS manifest admitted, embeddings current); log: $LOG"
else
  echo "session-start: FAILED steps: ${failed[*]} — see $LOG"
fi
exit 0
