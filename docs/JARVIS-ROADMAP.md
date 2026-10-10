# Jarvis roadmap

Sorted from the owner's four design notes (2026-10-11) against the repo as of PR #33. "Verified" means checked in the code or the live database; "unverified" means taken from the notes and not yet checked.

## Rules every item must keep

- Nothing auto-approves (F35 D2). Jarvis prepares, the owner decides in `approval_queue`.
- Canonical knowledge is written only by the Promotion Gate (`xyp_promotion`).
- Rights splits are append-only and every version sums to 100 (deferred trigger). A "fix" is a new full version, never an edit.
- Prose and voice are for commands; data-dense editing (splits, calendars) stays in grids.

## Built (verified)

| Item | Where |
|---|---|
| Jarvis Core front door, approval invariant (`PENDING_HUMAN_APPROVAL`), `pnpm jarvis` | `core/src/jarvis`, `core/src/cli` |
| `monday-review` sweep (Obsidian inbox, splits at 100, TRACE, queue), voice route | `core/src/playbooks`, `galaxy/jarvis_brain.py` |
| Obsidian staging (`obsidian_findings`), watcher, parser, lyric exporter (`0444`) | `knowledge/obsidian`, `core/obsidian` |
| `Cmd+K` command bar in the layout, mic toggle, Kokoro read-back | `apps/web/components/JarvisCommandBar.tsx` |
| Unified graph explorer on `/vault` (Obsidian clusters + live HUD pulses) | `apps/web/components/UnifiedGraphExplorer.tsx` |
| Append-only triggers on `knowledge_versions`, `research_evidence`, `research_findings` | migration `20261011100000` |
| One-command startup | `pnpm start:os` |
| Command bar tries `JarvisCore` first for playbooks (works with Galaxy down); chat and anything that would start a run stays with the Python Jarvis and its confirm step | `apps/web/server/jarvis-core.ts`, `app/api/jarvis/command` |
| Approval-gated split fix: `propose-split` queues the next full set (DB checks sum = 100), `pnpm gate decide` approves, `apply-split` writes it through `records-catalog`, once, only if the version has not moved | migration `20261011110000`, `core/src/jarvis` |

## Next, in order

1. **Route plan runs from the bar through `JarvisCore`.** Deliberately not done with the hybrid: a keyword in ordinary chat must not start a workflow by itself. Needs an explicit confirm step in the bar (a card, like the Python Jarvis's "do it") and the job tracking in `server/ask-ops.ts`.
2. **Owner UI for split proposals.** Today the owner decides with `pnpm gate decide` and applies with `pnpm jarvis apply-split`; show both as buttons beside the queue in the Command Center, and add the voice phrasing.
3. **README and decision housekeeping.** README Phases 15 to 17 should point at F35 D3 (absorbed into AOS-07/08); the AOS checklist stops at AOS-04; ARCHITECTURE runs F1 to F55.
4. **`audit_log`.** Documented as append-only at the grant level but the table does not exist. Planned under AOS-07/08 (F35 D3).

## Later (needs a decision first)

- **Merge `/hud` into the Command Center as a drawer.** `/hud` is still its own route; the explorer already listens to the same stream. Decide whether to keep the full-screen globe.
- **Fold Galaxy (Python) into the web stack, or keep it as a background daemon.** Today Galaxy owns chat, `remember`, calendar and phone; moving it is a large rewrite for little daily benefit.
- **3D explorer.** The explorer is Canvas 2D; `three` and `@react-three/fiber` are installed and unused.
- **Export approved Suno packages and catalog entries** to `obsidian/canonical/suno_packages/` and `catalog/` (only lyrics export today).
- **Wikilinks into the knowledge graph.** Links are stored on the staged row (`extracted_links`); whether they become graph edges is unverified.

## Not doing

- **Jarvis writing splits or canonical rows directly.** It would bypass the approval rule and the append-only design.
- **Python calling the web app over HTTP.** Every route sits behind the owner's session; a machine path would be a second way in. Galaxy runs the `JarvisCore` CLI instead.
- **A "House Reserve" or null-payee placeholder to unblock a release.** The sum-to-100 rule exists to prevent exactly that; the owner assigns the percentage.

## Unverified claims from the notes

TRACE engine on `127.0.0.1:8787`; "51" specialist agents (the repo has 52 plus a template); the briefing scene where a split sits at 92% (the database cannot hold it).
