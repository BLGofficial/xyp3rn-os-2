# Galaxy to graph migration audit

Date: 2026-10-04. Source plan: `F:\sono-mp3\2\3\GRAPH_LAYOUT_MIGRATION_PLAN (1).md`.

## 01 — Repository and working base

- Branch: `release/official-brand`. Existing uncommitted brand, sphere, HUD, server and viewer edits are preserved. No commit, merge or release is part of this migration.
- pnpm workspace: strict TypeScript core; Next 15.5.27 / React 18.3.1 web app at port 3100. `pnpm-lock.yaml` exists. Root typecheck passes before migration. Root tests are being measured; historical results are not treated as current evidence.
- Migration target: `galaxy/viewer/index.html`, served by Python stdlib `galaxy/server.py` at port 4700. This is a separate plain-JavaScript application, not the Next command-center graph. Existing servers listen on both ports.
- Renderer: CDN `3d-force-graph@1.80.1`, Three 0.186.1, WebGL. Existing geometry already uses a live force simulation, not the radial geometry assumed by the supplied plan. All root-group notes are pinned at the same origin. Decorative logo sphere and starfield are not data entities.
- `agentic-os-galaxy-view.html` and `agentic-os-graph-view.html` are sample-data design references. Neither is the production viewer. Their prototype verification claims do not establish acceptance here.
- No root lint script or `.github/workflows` directory exists. Build gate: `pnpm web:build`; browser harnesses use installed Playwright Core and Chrome. Fresh-clone installation is not yet verified; current worktree contains necessary uncommitted work.

## Real contract and source semantics

`galaxy/build.py` walks repository Markdown into `viewer/graph-data.js` and private `notes.json`. Browser contract:

```ts
type Note = { id: number; label: string; group: string; path: string;
  domain: string; excerpt: string };
type LegacyLink = { source: number; target: number };
type Data = { nodes: Note[]; links: LegacyLink[] };
```

Current snapshot: **134 notes, 641 links, 13 groups; zero missing source files, zero dangling endpoints, two isolated notes**. Isolated notes are real data and must remain visible. Never invent relationships to satisfy the plan's no-orphans assertion.

Links are undirected unions of filename/title mentions, wikilinks and shared wiki references. Original direction and exact evidence are absent from the browser snapshot. They must be labelled `related` (mention/shared-reference index), never `integrates`, `triggers`, `reads` or `writes`. Group membership supports explicit directed `contains` edges. Group nodes represent existing index groups, with their source note paths attached. README is the source-backed core; other notes remain notes. No app or routine entities exist in this contract.

Delta from `galaxy_view_prompts.md` section 2: no angle, radius, app list, routine list or declared cluster geometry. No source-backed app-to-app integration dataset was found on this integration path. Domain assignment comes from Markdown frontmatter or repository directory. Graph migration must adapt the real contract instead of importing sample entities.

## Integration, parity and risks

- Shared viewer contains note inspector, group/domain selection, Ctrl+K search, Jarvis chat, voice, source chips, capture creation, run history and workflow approvals. Keep these controls and backend contracts intact.
- Existing source IDs equal array indexes; runtime capture and source citations rely on this. Do not regenerate the index or renumber it during migration. New graph IDs use stable paths internally and map back to existing note objects.
- No URL persistence exists for selection, filters or camera. Add path-based URL state so rebuilds cannot redirect a deep link to another note.
- Existing reduced-motion handling is partial: several camera transitions and particles remain active. New graph camera uses a 280ms corporate ease-out, direct gestures bypass tweening, reduced motion is immediate, ambient motion is bounded and optional.
- Existing viewer is 93,103 bytes before migration, excluding graph data, logo and CDN runtime. Frame timing and transferred resources need browser measurement; no 60fps claim yet.
- Preserve existing modified logo asset usage. No replacing original artwork or importing sample branding.
- Server only serves flat files within `viewer/`; browser modules must live there. Configuration and private notes stay outside the served directory.

## File-level change list and sequence

02: Add `galaxy/viewer/graph.types.ts`, `build-graph.js`, model unit tests. Browser-native JS with TypeScript contract avoids adding a build pipeline to the Python viewer.

03: Add `graph-layout.js`, seeded settle/freeze layout and committed deterministic fixture. Measure real input before deciding whether a worker is necessary.

04: Add `graph-view.js` and `graph-view.css`; integrate using `?view=graph` while preserving the 3D path. Reuse shared controls and actual data. Add browser acceptance harness and proof artifacts.

05: Verify parity, keyboard navigation, reduced motion, URL reload, real count performance, errors and bundle delta. Flip the default only if acceptance supports it; keep `?view=galaxy` rollback.

06: **Deferred by the supplied plan until one fallback release has shipped.** No release evidence exists. Do not delete Galaxy or close its flag in this change.

## Pre-implementation blockers / explicit deviations

- Real source has isolated notes and no app integration semantics. Preserve and report both; do not fabricate connectivity.
- Repository access is available, so the source document's access blocker is obsolete.
- B1 is the plan's recommended default; user preference requested while audit proceeds.
- Full-suite, fresh-clone, visual and frame-time gates remain unverified until the evidence report records them. Existing tests must be distinguished from migration tests.
