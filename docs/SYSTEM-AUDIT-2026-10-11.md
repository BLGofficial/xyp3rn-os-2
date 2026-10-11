# System audit, 2026-10-11

What exists, what is kept, what was deliberately not built. Every line was checked in the repo or the running system on 2026-10-11 unless marked unverified. Supersedes an informal matrix that carried several wrong claims; the corrections are listed at the end.

## Running system

| Piece | Where | Notes |
|---|---|---|
| Web app (Next.js 15.5) | `http://127.0.0.1:3100` | Behind `XYP_WEB_TOKEN`. Start everything with `pnpm start:os`. |
| Galaxy (Python, standard library) | `http://127.0.0.1:4700` | Chat, `remember`, calendar, phone, voice routes. Runs the `JarvisCore` CLI for playbooks. |
| Postgres 16 + pgvector | `127.0.0.1:5433`, database `xyp3rn_engine_preview` | Container `xyp3rn-pg`. **Port 5432 is a different container (`xyp-pg`) with no project data.** `apps/web/.env.local` sets `XYP_DATABASE_URL`. |
| Kokoro (read-back voice) | `http://127.0.0.1:8880` | Container `xyp3rn-kokoro`. |
| Obsidian watcher | `pnpm obsidian:watch` | Stages edits from `obsidian/{inbox,research,creative}` as `pending_approval` in `obsidian_findings`. |
| Whisper | not configured | Dictation is Wispr Flow into the command bar (external; the app cannot control it). |

Port 5432 stays in `core/db/client.ts` (`DEFAULT_LOCAL_URL`) and in CI's Postgres service on purpose: it is the default for a plain local or CI database. Only this machine's `.env.local` points at 5433. Do not purge it.

## Schema invariants (verified against the live database)

- Append-only by trigger (`*_immutable`, `xyp_vault_immutable()`): about 35 tables, plus `knowledge_versions`, `research_evidence` and `research_findings` since migration `20261011100000`. The same three also have no UPDATE/DELETE/TRUNCATE grant for any non-owner role.
- `audit_log` is documented as append-only but **does not exist**; planned under AOS-07/08 (F35 D3).
- Rights splits: append-only, each version sums to exactly 100 (deferred constraint trigger), an unassigned share blocks a scheduled release. A fix is a new full version.
- Canonical knowledge is written only by the Promotion Gate (`xyp_promotion`); nothing auto-approves (F35 D2).
- 27 migrations, 27 matching rollbacks. Rollbacks never drop roles (roles are cluster-wide).

## Kept (do not remove)

| Item | Path | Function |
|---|---|---|
| Obsidian surface | `obsidian/` | The owner's visual vault: `inbox/`, `research/`, `creative/`, `canonical/` (read-only exports, lyrics only so far). |
| Vault graph | `apps/web/components/UnifiedGraphExplorer.tsx` on `/vault` | Obsidian note clusters plus live agent pulses from `/api/v1/hud/stream`. Canvas 2D. |
| HUD | `apps/web/app/hud/page.tsx` | Separate route; merging it into the Command Center is an open decision (`docs/JARVIS-ROADMAP.md`). |
| Jarvis Core | `core/src/jarvis/`, `pnpm jarvis` | One front door over ask, dispatch, workflow; `PENDING_HUMAN_APPROVAL` for anything canonical. |
| Approvals | `/approvals`, `apps/web/server/approvals-ops.ts` | Approve or reject, then apply, a Jarvis split proposal. Approving never writes the splits. |
| Command bar | `apps/web/components/JarvisCommandBar.tsx` | `Ctrl/⌘ K` **focuses** the bar. Speech never sends by itself. Playbooks go to `JarvisCore` in-process; chat and anything that would start a run go to the Python Jarvis, which asks first. |

## Built in this cycle

- Jarvis Core, the `monday-review` sweep, approval-gated split proposals (PR #33, #34).
- The local voice orb (SVG and CSS, no remote code); `components/orbs/VoiceOrbContainer` is an alias for it (PR #34).
- Obsidian staging, watcher, parser, lyric exporter (read-only `0444` files).
- CI workflow tracked, now building `galaxy/viewer/graph-data.js` before the tests.
- README: AOS-05 to AOS-08 and the F35 D3 notes on Phases 15 to 17 (PR #35).
- 52 agent files plus a template, 7 workflow YAMLs under `core/`, `records/`, `tech/`.

## Deliberately not done

- **Click-to-run on graph nodes.** Does not exist; if added, it must go through `JarvisCore` with a confirmation.
- **A third-party orb script** (`aqualang89.github.io/shipnotes-components`). It would run remote code inside the owner's session and the app has no Content-Security-Policy. The file was read (18 KB, no network or storage calls, defines only `<voice-orb>`, no clear licence) and not adopted.
- **`obsidian-jarvis-ui` sandbox** (`Prompt-Surfer`, AGPL-3.0). Its Express server binds all interfaces, allows any origin, lets `POST /api/config` change the vault path and `POST /api/note` write files without authentication, and its path check uses `startsWith`. Cloned, read and deleted; nothing was installed or run. Do not copy its code into this repo (AGPL).
- **Python calling the web app over HTTP.** Every route sits behind the owner's session; a machine path would be a second way in.
- **Jarvis writing splits or canonical rows directly.**

## Corrections to the informal matrix

| Claim | Fact |
|---|---|
| `VoiceOrbContainer` loads Aqualang's `voice-orb`, `speaking-orb`, `signal-orb` | It is an alias over the local orb. The remote script defines only `voice-orb`. |
| Database `…:5433/xyp3rn` | The database is `xyp3rn_engine_preview`. |
| Immutability triggers protect "vault history tables" | Those already had them; the new ones cover `knowledge_versions`, `research_evidence`, `research_findings`. |
| `Cmd+K` opens an input modal / starts audio capture | It focuses the bar. |
| "Purge port 5432 references" | Would break the repo default and CI. |
| Orb is a WebGL particle effect | It is SVG and CSS. |
| 51 specialist agents | 52 plus a template. |
| Decisions F1 to F53 | `docs/ARCHITECTURE.md` runs F1 to F55. |
