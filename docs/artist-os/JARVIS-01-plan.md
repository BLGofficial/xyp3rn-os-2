# Jarvis Prompt 01 — the Mercury sphere and the eight areas: implementation plan

> **For agentic workers:** execute task by task. Steps use checkbox (`- [ ]`) syntax. Every task commits its failing test before the code that turns it green (house rule since AOS-01).

**Goal:** finish Prompt 01 of the Jarvis Build Sequence on top of what AOS-04 built (current-state map: [JARVIS-00-map.md](JARVIS-00-map.md)):
- **the Mercury graph sphere** on Command, rendered from a new authenticated graph API over Plan C1's `graph_nodes` / `graph_edges`, with selectable nodes, keyboard navigation, reduced motion, and honest empty / loading / populated / error states;
- **a bottom command input** that searches the whole index;
- **the eight areas** in navigation, each opening a real page.

Answer-driven focus, source clusters, the richer filters and connection signals are **Prompt 03**. The sphere is built so they attach to it.

**Architecture:**
- **Overview projection** (`knowledge/knowledge-graph/overview.ts`): a bounded view of the graph (≤ 250 nodes, ≤ 500 edges, §18).
  - **Real entities:** the six domains, registered components (modules), agents, workflows and their steps.
  - **Aggregates:** one per domain (and Shared) per bulky kind: files, lineages, songs, runs, research. Each aggregate discloses its query, member count and member ids; it is a navigation group, never a node the database holds.
  - **Edges:** only rows of `graph_edges` among the drawn nodes, plus `contains` links from an aggregate to its domain, marked as grouping.
- **Graph API:** `GET /api/graph/overview` (JSON, behind the session middleware like `/api/time`, `no-store`) and `GET /api/graph/node?id=` (one-hop neighbourhood from C1's `neighbourhood`).
- **Layout** (`apps/web/lib/sphere.ts`, pure):
  - domain anchors in their §13.2 sectors: Core north, Knowledge north-east, Governance south-east, Records south, Tech south-west, Research north-west; Shared on the far side;
  - members placed on a spherical cap around their anchor, by a hash of their id (deterministic: the same graph gives the same picture);
  - rotation (yaw/pitch), perspective projection, depth to opacity.
- **Renderer** (`apps/web/app/graph/sphere.tsx`, client, SVG, no dependency: S2):
  - a mercury rim, domain sectors, curved edges;
  - screen-space labels for domains, the hovered/focused node and the selected one;
  - 44 px invisible hit targets;
  - selecting a node navigates to `/?node=<id>`, so the inspector rail (C1) opens, and the same URL works without JS.
- **The hub** is the application's identity from configuration (`package.json` name and version), drawn at the centre. It is not an agent, a server or a database row, and it says so on hover.
- **Areas:** Songs & Releases (one item; `/songs` and `/releases` with tabs), Workflow Builder (`/workflows`, read-only), Analytics (`/analytics`, honest), System Admin (`/system`, extended).

**Tech stack:** as Plans B and C1. No new dependency.

**Spec:**
- the Jarvis Build Sequence, Prompt 01 and its global build contract;
- AOS-04 design §§13.1–13.3, 14, 15.1, 16 (bullets 1–2), 18 (the motion rows used here), 20;
- decisions S1–S4 (F46).

## Decisions (operator, 2026-09-28)

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| J1 | Workflow Builder, Analytics, System Admin | **Honest pages.** Workflows lists the real workflow files, steps and recorded runs, labelled "builder: not built (Prompt 14)". Analytics says what's missing and why (connectors: Prompt 11) and shows only real data (recorded platform links). System Admin extends `/system` with the pulse, migration head, roles and registries. | Disabled entries only; a real builder now (Prompt 14's scope) |
| J2 | Songs & Releases | **One area, two tabs.** One nav item opening `/songs`, with Songs \| Releases tabs; both routes keep working. | Two items under one label |
| J3 | The sphere across Prompts 01 and 03 | **Follow the prompts.** 01: the sphere, selection, keyboard, states, reduced motion, and a command input that searches. 03: answers that focus their sources, clusters, status/language/project/date filters, connection signals. | All sphere work now; the sphere without an input |

Contract conflicts (UUID v7, `prm_*`/`skl_*`, the six-state lifecycle, semantic versions, the Anthropic provider) are recorded in the map, §2. The repository's decisions stand; none touches Prompt 01.

## Global constraints

- **Nothing fabricated:**
  - every drawn node is a `graph_nodes` row, an aggregate that names its query and members, a domain, or the configured hub;
  - every drawn edge is a `graph_edges` row or an aggregate's `contains`;
  - no decorative stars, no invented activity, no progress rings.
  - Fewer real nodes is a valid sphere.
- **The list stays the accessible equivalent:** the C1 Graph list is still on Command, under the sphere. Anything the sphere shows, the list and the inspector show as text.
- **No motion by default:**
  - no idle drift;
  - rotation happens only on the owner's drag or keys;
  - a focus transition is 450–650 ms eased (`cubic-bezier(0.22, 1, 0.36, 1)`), and immediate under `prefers-reduced-motion`;
  - nothing animates while the document is hidden.
- **Security:** the API routes return only what `xyp_web` reads, behind the session. A 401 without a session is pinned by the smoke. Node ids go into URLs encoded; titles render as text.
- **Existing behaviour stays:** every page, action and smoke line. `/songs` and `/releases` keep their URLs.
- **Gates before each push:**
  - `pnpm typecheck`, `pnpm test`, `pnpm agents:validate`;
  - the migration round trip (no migration in this plan);
  - `pnpm web:build`, `pnpm web:smoke`.
- **Commit messages:** `Jarvis 01 red test: …` / `Jarvis 01: …` / `Jarvis 01 UI: …`, ending with the Co-Authored-By line.

## Review focus

1. **Aggregates are honest.** A group reads "Records · 12 lineages", shows its query, opens its real members, and is visibly a group. The test pins: every non-aggregate id is in `graph_nodes`, and every non-`contains` edge is in `graph_edges`.
2. **Determinism.** The same graph gives the same positions, on the server and the client. There is no `Math.random`; a test pins it.
3. **Keyboard:**
   - Tab reaches the sphere; the arrow keys move between nodes (within the domain, then across);
   - Enter selects (the inspector opens), Escape clears;
   - `+`/`-` zoom, and `R` resets;
   - a visible focus ring is on the focused node.
4. **States:**
   - loading is a labelled skeleton;
   - empty (only the six domains and the hub) says "No entities indexed yet · Scan now on System";
   - an API error says so and points to the list below;
   - populated shows the count drawn against the index's total ("Showing 142 of 752 entities; 610 in groups").

## Tasks

### Task 1: The overview projection and the graph API

**Files:** create `knowledge/knowledge-graph/overview.ts`, `apps/web/app/api/graph/overview/route.ts`, `apps/web/app/api/graph/node/route.ts` and `apps/web/server/overview.test.ts`; extend `apps/web/server/graph-loaders.ts`.

- **Interface:** `overview(tx, { maxNodes = 250, maxEdges = 500 })` returns `{ hub, nodes, groups, edges, counts: { indexed, drawn, grouped }, asOf }`.
  - A group is `{ id: 'group:<domain|shared>:<kind>', kind, domain, label, count, query, memberIds (first 200), membersTruncated }`.
  - If the real entities alone exceed the budget, the least-connected kinds are grouped first (agents before modules), and the counts say so.
- [x] **Red test:**
  - on a fixture graph, every node id is in `graph_nodes`, and every edge except `contains` is in `graph_edges` with its provenance;
  - groups count their real members, and their query text reads back the same members;
  - the budget holds with 400 fixture files;
  - two calls give identical output;
  - an empty workspace gives the six domains, the hub, and no group with zero members;
  - `/api/graph/overview` answers the loader's JSON, `no-store`.
- [x] **Commit(s):** red, then `Jarvis 01: the overview projection and the graph API (bounded, groups disclose members)`.

### Task 2: Sphere geometry

**Files:** create `apps/web/lib/sphere.ts` and `apps/web/lib/sphere.test.ts`.

- **Interface:**
  - `DOMAIN_DIRECTION: Record<Domain | 'shared', Vec3>` (§13.2 sectors);
  - `place(ids, anchor, spread): Map<id, Vec3>` (a hash-seeded spherical cap, unit length);
  - `rotate(v, yaw, pitch)`;
  - `project(v, { width, height, zoom }): { x, y, depth, scale }`;
  - `hitRadius(scale) >= 22` (a 44 px target).
- [x] **Red test:**
  - every placed point has unit length and lies within its cap;
  - positions are identical across calls and independent of input order;
  - distinct ids never collide exactly;
  - Core projects above Records at yaw 0;
  - depth decreases for the far side, and a far-side point is dimmer;
  - the hit radius is never under 22 px.
- [x] **Commit(s):** red, then `Jarvis 01: sphere geometry (sectors, deterministic placement, projection)`.

### Task 3: The sphere on Command

**Files:** create `apps/web/app/graph/sphere.tsx` (client) and `apps/web/app/graph/command-input.tsx`; modify `apps/web/app/page.tsx` and `apps/web/app/globals.css`.

- **The sphere:** a `role="application"` region labelled "Graph sphere", in the centre above the Graph list.
  - It fetches `/api/graph/overview` and renders the rim, sectors, edges (depth-faded), nodes (domain hue rim, kind glyph) and groups (a ring with the count).
  - **Labels:** domains always; the hovered, focused or selected node.
  - **Hover/focus:** reveals the title, kind and domain without moving the camera.
  - **Select:** a click or Enter navigates to `/?node=<id>`; a group opens `/?lens…` or the domain filter with that kind.
  - **The current `?node=`:** highlighted, with its drawn neighbours emphasised (actual edges only).
  - **Toolbar:** Reset view, Zoom in and out, and the coverage line; no Pause, because nothing moves on its own.
  - **States:**
    - loading: a skeleton with "Loading the graph…";
    - empty: the six domains and the hub, with "No entities indexed yet · Scan now";
    - error: "Graph unavailable: <reason>. The list below lists every entity.";
    - populated, with the counts.
- **The command input:** sticky at the bottom of the centre column, a labelled GET form to `/search` ("Search everything: files, songs, agents, decisions…"). It works without JS. A note reads "Answers from your Vault: Prompt 03 · Voice: Prompt 02". No microphone or attachment control is shown.
- **Layout (§13.3):**
  - from `md` up, the sphere takes the centre's width and at least 480 px of height;
  - below `md`, the list shows first and the sphere sits behind a "Show the sphere" disclosure;
  - reduced motion: no transitions.
- [x] **Test:** Task 8's smoke (browser behaviour). The geometry and data are unit-tested in Tasks 1–2.
- [x] **Commit:** `Jarvis 01 UI: the Mercury sphere on Command (selectable, keyboard, reduced motion, states) and the command input`.

### Task 4: The eight areas

**Files:** modify `apps/web/app/shell/nav.tsx`, `apps/web/app/songs/page.tsx` and `apps/web/app/releases/page.tsx`; create `apps/web/app/shell/tabs.tsx`.

- **Primary nav:**
  - Command Center (`/`);
  - Songs & Releases (`/songs`; current on `/songs*` and `/releases*`);
  - Studio, Research, Creative Vault;
  - Workflow Builder (`/workflows`), Analytics (`/analytics`), System Admin (`/system`).
- **More:** Search everything, Tasks, People, Ingest. The domain filters stay.
- **Tabs:** Songs | Releases, as links with `aria-current`, on both pages.
- [x] **Commit:** `Jarvis 01 UI: the eight areas in navigation; Songs & Releases as one area with tabs`.

### Task 5: Workflow Builder (read-only)

**Files:** create `apps/web/server/workflows-loaders.ts`, `apps/web/server/workflows.test.ts` and `apps/web/app/workflows/page.tsx`.

- **The loader lists:**
  - every workflow node, with its file, owner, revision and steps (step → agent, depends on);
  - its recorded runs: count, last status and time, and how many ran the current revision vs earlier ones;
  - recorded runs whose workflow has no definition file (for example `research-specialists`), listed apart as "no definition file".
- **The page** says: "Builder: not built (Prompt 14). These are the workflows that exist, read from their files and runs."
- [x] **Red test:**
  - a fixture workflow with two runs (one of an earlier revision) lists them with the right counts;
  - an undefined workflow's run is listed apart;
  - nothing is listed that has neither a file nor a run.
- [x] **Commit(s):** red, then `Jarvis 01: Workflow Builder, read-only (workflows, steps, runs by revision)`.

### Task 6: Analytics (honest)

**Files:** create `apps/web/server/analytics-loaders.ts` (+ test) and `apps/web/app/analytics/page.tsx`.

- **The page:** "No platform connector is configured. Metrics arrive with Prompt 11; nothing here is a statistic."
- **The one real data point:** the recorded platform links (AOS-02) by platform, labelled "links, not metrics".
- **Platform access:** listed only as "to be verified at Prompt 11", with no claims.
- [x] **Red test:** the loader counts the fixture's platform links by platform, and returns no metric field.
- [x] **Commit(s):** red, then `Jarvis 01: Analytics, honest (links only; connectors are Prompt 11)`.

### Task 7: System Admin

**Files:** extend `apps/web/app/system/page.tsx`; create `apps/web/server/admin-loaders.ts` (+ test).

- **Adds to `/system`:**
  - the system pulse (Plan B's rows);
  - the migration head and applied count;
  - registries: agents, tools, capabilities, workflows, modules, from the live registry and DB;
  - DB roles (`xyp_*`, from `pg_roles`: names only);
  - index coverage (C1, unchanged).
- Secrets: the page shows "Configured" or "Not configured" only, never a value.
- [x] **Red test:**
  - the registry counts equal the registry's and the DB's;
  - the roles list includes `xyp_web` and `xyp_indexer`;
  - with a provider key set in the injected env, its value appears nowhere in the output.
- [x] **Commit(s):** red, then `Jarvis 01: System Admin (pulse, migrations, registries, roles, index)`.

### Task 8: The browser journey

**Files:** modify `apps/web/e2e/smoke.ts`.

- **The eight areas:** each nav link opens a page (200) with its heading.
- **The sphere:**
  - loads: after a delayed API response, the skeleton shows first;
  - draws as many nodes as `/api/graph/overview` returns;
  - selecting the Records domain node by keyboard (Tab, arrows, Enter) opens the inspector for `domain:RECORDS`;
  - `R` resets;
  - an API failure (route intercepted to 500) shows the error state and the list still renders.
- **The API:** `/api/graph/overview` answers 401 without a session.
- **The command input:** submits to `/search` and finds a file.
- **Reduced motion:** a node's transition duration is 0.
- **Logs:** no console error on `/` and the eight areas, and no error line in the `next start` log.
- **Layout:** 390 px with no sideways scroll on the new pages.
- **Screenshots:** Command with the sphere at four viewports + 200%.
- **Recorded, not gated:** LCP and CLS on `/` (PerformanceObserver), with device and dataset, for the proof.
- [x] **Commit:** `Jarvis 01: web:smoke drives the sphere and the eight areas`.

### Task 9: Proof, docs, handoff

- **`docs/proofs/JARVIS-01.txt`:**
  - the overview's counts on the dev DB (drawn, grouped, indexed);
  - the determinism check;
  - the smoke lines;
  - the recorded LCP/CLS with the method;
  - the gates.
- **ARCHITECTURE:** **F48** (J1–J3; the overview's grouping rule; the hub as configuration) and **F49** (open: Prompt 03's answers, clusters and filters; fps not measured; the contract conflicts in the map's §2).
- The map's §5 gaps are marked closed; the handoff and README are updated.
- [x] **Commit:** `Jarvis 01 proof and docs (F48 decided, F49 open)`.

## As built (2026-09-28)

All nine tasks are done; proof `docs/proofs/JARVIS-01.txt`, decisions F48, open items F49. Where the build differs from the text above:
- **Budget floor:** the six domains and the groups are always drawn, even when they alone exceed `maxNodes`; the response names the demoted kinds (`demoted`). Workflows give way last, after modules.
- **Overview nodes** carry only what the sphere draws (id, kind, title, owner, availability, the inspector link); the inspector loads the rest through `?node=`.
- **The focus transition** runs only when the selection is out of view (the far side or past the rim); a selection in view doesn't move the camera. Shift+arrows turn the sphere, so the far side is reachable without a pointer.
- **Geometry** also exports `facing` and `ease` (red-tested on their own), and `arcControl` for the curved links.
- **The sphere's height** is CSS (340 px; 520 px from 960 px), so the server-rendered skeleton and the drawing take the same box.
- **Command** gained a `kind` filter (`/?kind=<kind>&domain=<D>`), which a group opens.

## Prompt 01's verify list, mapped

| Prompt 01 asks | Where |
|---|---|
| Run existing checks | every gate, before each push |
| Load the main route | smoke (`/`, the sphere populated) |
| All eight navigation areas render | smoke (Task 8) |
| Graph handles empty, loading and populated states | Task 1 (empty data), smoke (loading via a delayed route, populated; error via a failed route) |
| Browser console and server logs | smoke: no console error on `/` and the eight areas, no error line in the `next start` log |
| The current-state map and all gaps | [JARVIS-00-map.md](JARVIS-00-map.md) (written first), closed out in Task 9 |
