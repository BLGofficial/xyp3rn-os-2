# HANDOFF: the unified OS dashboard (/os) and two-way Obsidian sync

2026-10-06, branch `build/K-os-dashboard` from `main` @ `90c7990`. Decisions: F54, open items: F55 (docs/ARCHITECTURE.md).

## Built

- `/os` (apps/web/app/os/): one page in Brand Kit 2026 (scoped under `.os`) with these panels:
  - a totals strip;
  - Knowledge/Obsidian: the sync preview, Apply by plan hash, the wikilink graph;
  - Research;
  - Import (the existing upload action);
  - Records audio library, with playback;
  - the existing graph sphere;
  - a context view (the Context Engine's vault corpus, bars by similarity).
  - Linked from the shell's More menu.
- `knowledge/obsidian/`:
  - `notes.ts`: vault path, scan, frontmatter, tags, wikilinks, link graph, Windows-safe export names.
  - `plan.ts`: the pure sync plan and its hash.
  - `tools.ts`: `write_obsidian_note`, `record_obsidian_sync`.
  - `agent.ts`: `obsidian-sync`, an Execution agent.
  - `sync.ts`: preview and apply.
- `agents/obsidian-sync.agent.md`.
- Migration `20261006100000_obsidian_sync` and its rollback: the append-only ledger `obsidian_sync_events` and the view `current_obsidian_sync`.
- `apps/web/server/os-loaders.ts` and `os-ops.ts`.
- Fonts `@fontsource/unbounded` and `@fontsource/ibm-plex-sans` 5.3.0, with OFL notices.

## Key decisions (owner)

- Build in one step now (option 3), ahead of the sequence's L7.1.
- No NotebookLM: Google publishes no official API for it.
- Obsidian sync is two-way. The vault is `C:\Users\blago\Desktop\XYP3RN Obsidian Directory`; the given `...\.obsidian` path resolves to its parent.

## Premises corrected

- The configured path pointed at `.obsidian`, which is Obsidian's settings folder, not the vault.
- The META H06 prompt says the vault is read-only. The owner's two-way decision supersedes that, and writes stay confined to `XYP3RN OS/`.

## Verify

- `pnpm exec vitest run knowledge/obsidian tests/obsidian apps/web/server/os.test.ts`: 20 unit, 8 sync DB and 7 loader tests.
- `pnpm agents:validate`, `pnpm typecheck`, web `tsc`, `pnpm web:build`.
- Browser: `docs/proofs/2026-10-06-os/` (desktop before and after Apply, mobile 390 px) and `os-check.txt`.

## Open (why)

- See F55: renamed-song exports, no receipt table (J-14), an in-process lock only, large vaults unmeasured, and no real vault or Windows run yet.
- To use it on the owner's machine:
  1. `pnpm db:up`.
  2. Set `XYP_OBSIDIAN_VAULT=C:\Users\blago\Desktop\XYP3RN Obsidian Directory`.
  3. `pnpm web:build && pnpm web`.
  4. Open `/os`, read the plan, then Apply.
