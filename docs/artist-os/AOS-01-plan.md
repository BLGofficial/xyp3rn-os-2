# AOS-01 — Creative Vault + song schema: implementation plan

Design: [AOS-01-design.md](AOS-01-design.md). Red tests first: each step's tests are committed failing, then turned green.

## Order

0. **Spike (§9):** can Next.js 14 import the OS modules server-side (`.ts` imports, Node type stripping)?
   - Build a throwaway page that calls `dispatch` and `createContextEngine`.
   - Record the result, and choose: direct import, or the local OS API fallback.
   - No UI work starts before this.
1. **Red DB tests** `tests/aos-01/vault-db.test.ts` (§4, §10), then:
   - migration `20260925140000_vault_songs` + rollback;
   - a round-trip on the local DB;
   - `tests/phase-01` snapshot still green.
2. **VaultStore** (§5): red `vault-store.test.ts` → `knowledge/source-registry/vault-store.ts`; `.vault/` gitignored.
3. **Capabilities and tools:**
   - `vault.write` and `vault.read` (code + doc);
   - the tools `register_vault_file`, `write_song`, `link_song`, `unlink_song`, `read_vault_file`;
   - the three agents: `vault-curator`, `records-songs`, `x3lius-lyric-editor`.
4. **Ingestion** (§6): red `vault-ingest.test.ts` → `addToVault`, `importLyricSheet`, the lyric-sheet parser, and `pnpm vault add`.
5. **Approvals** (§4.4): `xyp_decide_artifact`, the `artifact_approvals` view, `pnpm vault approve|reject`.
6. **Search** (§7): red `vault-search.test.ts` → `vault_embeddings` filled by `pnpm embed`, `xyp_match_vault`, Context Engine `corpus`.
7. **Export / import** (§8): red `vault-export.test.ts` → `knowledge/vault-io`, `pnpm vault export|import`.
8. **UI** (§9):
   - the `apps/web` workspace;
   - token session;
   - screens `/vault`, `/vault/files/[id]`, `/vault/lineages/[id]`, `/ingest`, `/songs`, `/songs/[id]`;
   - loader and session unit tests.
9. **Proof** `docs/proofs/AOS-01-vault.txt`:
   - the CLIs on a throwaway DB: add the build guide PDF, an MP3, a lyric sheet; search; approve; export → import → re-export byte-identical;
   - the Playwright smoke test of the UI.
10. **Docs:** SCHEMA, AGENT_CLASSES, ARCHITECTURE (the AOS-01 flags), `docs/handoffs/AOS-01.md`, the README (Artist OS status).

## Gates before each push

`pnpm typecheck`, `pnpm test` (the full suite, `tests/aos-00` included), `pnpm agents:validate`, a migration round-trip, and `pnpm --filter web build` once the app exists.
