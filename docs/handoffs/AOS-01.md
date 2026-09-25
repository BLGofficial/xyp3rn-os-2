HANDOFF — Artist OS AOS-01 (Creative Vault + song schema) complete; AOS-02 (Command Center) next

- **Built** (design `docs/artist-os/AOS-01-design.md`, decisions A1–A4 in ARCHITECTURE F36; proof `docs/proofs/AOS-01-vault.txt`):
  - **Data:** migration `20260925140000_vault_songs` (+ rollback) adds songs with derived revisions, typed `song_links` with retractions, Vault columns on `sources`, `source_texts` and `source_tags`, version approvals (`xyp_decide_artifact`, `artifact_approvals`), the vault index (`vault_embeddings`, `xyp_match_vault`), `knowledge_sources`, and the roles `xyp_vault` and `xyp_web`.
  - **Bytes:** `VaultStore` (`.vault/<sha256>`, `XYP_VAULT_DIR`) writes atomically and verifies on every read.
  - **Agents** (A2, all `model: none`):
    - `vault-curator` (Execution, KNOWLEDGE);
    - `records-songs` (Execution, RECORDS);
    - `x3lius-lyric-editor` (Creative, RECORDS): lyric sheets and owner edits → `x3lius.lyrics/v2`, draft until approved.
  - **Tools and capabilities:** 5 tools: `register_vault_file`, `read_vault_file`, `write_song`, `link_song`, `unlink_song`. 2 capabilities: `vault.write` (Execution) and `vault.read` (Knowledge, Creative, Execution).
  - **CLIs:**
    - `pnpm vault add|edit|approve|reject|song …|export|import`;
    - `pnpm embed` now also fills the vault index;
    - `pnpm context "<q>" --vault`.
  - **Search** (A3): `retrieve(q, { corpus: 'vault' })`. The knowledge corpus is pinned unchanged. `pnpm embed` would have leaked Vault files into it; `knowledge_sources` fixed that, and a red test caught it first.
  - **Export:** `xyp-vault-export/v1` (`knowledge/vault-io`). The A → B → re-export round trip is byte-identical, re-import is a no-op, and a conflict, a tampered file, a corrupt blob or a foreign table refuses the import.
  - **UI** (A4): `apps/web` has the screens `/vault` (browse + search), `/vault/files/[id]`, `/vault/lineages/[id]` (versions, diff, approve/reject, edit), `/ingest`, `/songs` and `/songs/[id]`.
    - Token session: HMAC cookie from `XYP_WEB_TOKEN`, at least 16 characters.
    - Reads run as `xyp_web`, read only.
    - A real-Chromium smoke test runs with `pnpm web:smoke`.
- **Numbers:** 48 agents (+3), 26 tools (+5), 21 capabilities (+2), 44 tables (+7) plus 4 views, and 1127 tests (up from 1012 at AOS-00).
  - Gates on every push: typecheck, the full suite, `agents:validate`, and a migration down/up/down/up on the dev DB. `web:build` since the UI landed.
- **Differs from the design** (the "as built" notes in §6 and §8):
  - An import's provenance is in `contextRefs`, because v2 `sources` only allows `structure`.
  - An instrumental section's directions come back as warnings.
  - Knowledge sources with the same bytes are promoted, once.
  - The UI can also edit lyrics (a small addition, flagged in F36).
  - An unauthenticated GET gets a 401 plus a relative refresh, not a redirect: Next rewrites `127.0.0.1` → `localhost`, and the session cookie belongs to a host.
- **Open** (F37):
  - A restore can't recreate a non-draft release, so the export refuses one (release history is AOS-08).
  - Ids are never remapped on import.
  - Two single-owner concurrency gaps are not guarded.
  - Owner identity/RBAC is AOS-07/08.
  - `pnpm embed` is manual; `/ingest` shows the backlog.
  - Not proven live: an MP3 upload (no MP3 in the repo; a WAV exercised the same path).
- **Next phase needs (AOS-02, the Command Center: G8, and G7's catalog dashboard + song workspace):**
  1. **Decisions from the operator:** the credits-by-role model (`song_credits`, or rows on `rights_splits`); what a "task" is (its own table, or approval-queue items); and which platform links are kept (URL per platform per release/track).
  2. **Building on AOS-01:** releases and tracks (Phase 13) are linked to songs already. AOS-02 adds the dashboard, statuses across song → release, credits, tasks and platform links on the `/songs/[id]` workspace.
