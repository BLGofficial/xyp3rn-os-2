# Handoff — Jarvis Prompt 01 (the Mercury sphere and the eight areas)

HANDOFF — Jarvis Prompt 01 complete; Prompt 02 (the voice loop) next in the sequence

- **Built** (plan `docs/artist-os/JARVIS-01-plan.md`; decisions J1–J3 and the overview's rules in ARCHITECTURE F48; open items F49; map `docs/artist-os/JARVIS-00-map.md`; proof `docs/proofs/JARVIS-01.txt`):
  - **The overview** (`knowledge/knowledge-graph/overview.ts`): a bounded view of C1's graph.
    - Domains, workflows, modules, agents and workflow steps are drawn one by one.
    - Every other kind becomes a group per owner domain (or Shared) that names its query and its members.
    - Edges are `graph_edges` rows between drawn nodes, plus grouping-marked `contains` links.
    - Over the budget, registered kinds give way in a fixed order.
    - The hub comes from `package.json`.
  - **The graph API:** `GET /api/graph/overview` and `/api/graph/node?id=`. Both sit behind the session (401 without one), read as `xyp_web`, and are `no-store`.
  - **The geometry** (`apps/web/lib/sphere.ts`, pure):
    - sectors;
    - hash-seeded placement;
    - rotation and projection;
    - 44 px targets;
    - the keyboard order;
    - facing a node, and the focus easing.
  - **The sphere** (`apps/web/app/graph/sphere.tsx`, SVG, no dependency):
    - **What it draws:** sectors, depth-faded curved links, a glyph per kind with the domain hue as its rim, and dashed rings for groups.
    - **Selecting** opens the inspector (`?node=`); a group opens its members in the list (a new `kind` filter).
    - **Keyboard:** Tab to reach it, arrows to move, Enter to open, Esc to clear, Shift+arrows to turn, +/− to zoom, R to reset.
    - **States:** loading, error, empty and populated.
    - **Below 960 px** the sphere sits behind a disclosure; its height is fixed in CSS, so loading shifts nothing.
  - **The command input:** a GET form to `/search` at the bottom of Command's centre column.
  - **The eight areas:**
    - Command Center;
    - Songs & Releases (tabs; both URLs kept);
    - Studio, Research, Creative Vault;
    - Workflow Builder (`/workflows`, read-only: files, steps, runs by revision, runs with no file apart);
    - Analytics (`/analytics`: links, not metrics);
    - System Admin (`/system`: pulse, migrations, registries, roles, secrets as Configured or Not configured, then the index).
  - `pnpm web:smoke` drives all of it (the proof's section 3).
- **Numbers:**
  - 1456 tests in 113 files (up from 1431), all passing; 5 new test files (overview, geometry, workflows, analytics, admin), all red first;
  - no migration, no new table, role, dependency, agent, tool or capability.
  - On the dev DB: 778 entities; 113 drawn, 665 in 15 groups, 166 edges; nothing demoted; 582 files, 0 diagnostics.
  - Gates: typecheck, the suite, `agents:validate`, the migration round trip, `web:build`, `web:smoke`.
- **Red tests with bugs of their own**, fixed in the green commit:
  - the overview fixture miscounted Core files (an agent file belongs to its frontmatter domain: 250 + 4);
  - the workflows fixture wrote an `error` run without the `failed_step` and `error_detail` the schema requires.
- **Found on the way:**
  - A selection turned the camera even when the node was already in view, putting it over the hub. The camera now turns only for what is out of view.
  - Group rings drawn as opaque disks hid what was behind them.
  - Labels ran off the drawing at 390 px.
  - The sphere's height was measured in JS, so the skeleton and the drawing differed (a layout shift); it is now CSS.
  - A typecheck error was committed once, because a piped exit code hid it. It was caught before any push and amended.
- **Observed, not fixed** (F49): the Sofia clock samples `/api/time` on `/login`, where there is no session yet, so the login page logs three 401 console errors (Plan B). It is suggested as a separate task.
- **Open** (F49):
  - Prompt 03's answers, clusters, filters and signals;
  - frame rate not measured;
  - group labels vs the shell's short domain labels;
  - the contract conflicts in the map's §2.
- **Next:**
  1. **Prompt 02** (the voice loop: Whisper/Kokoro, = AOS-05), inspected and planned before code.
  2. **The live `pnpm research ask`** still waits on `OPENROUTER_API_KEY` (set in the environment, never pasted in chat).
