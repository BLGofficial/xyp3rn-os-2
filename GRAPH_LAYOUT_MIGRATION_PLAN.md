# GALAXY → GRAPH MIGRATION PLAN
### Agentic OS · layout swap, audit, and integration

**Status: blocked on repository access.** Nothing in this document is speculative about your
code — Part A is the audit I'll run the moment I can read it, Part B is the design decision
that has to be made regardless of how the code is structured, Part C is the work sequence.

---

## PART A · AUDIT — what I'll inspect, in order

I'll report findings as I go, not at the end. If something is broken I'll say so before
proposing the replacement, because the swap has to land on a working base.

### A1 · Orientation (first pass)
- Repo shape: monorepo or single app, package manager, lockfile present
- Framework and version: Next / Vite / SvelteKit / plain, React version, TS strict or loose
- Renderer: SVG, Canvas 2D, WebGL, or a library (d3, three, pixi, react-force-graph, cytoscape)
- Where the galaxy view lives: component path, its data source, its prop contract
- Build and run: does `install` → `dev` → `build` all complete clean on a fresh clone

### A2 · The galaxy implementation specifically
- How the radial geometry is computed — hard-coded radii or derived
- Where the cluster/app/routine data comes from: local JSON, API, filesystem scan, DB
- Is the data model typed, and does it match the `GalaxyData` shape in
  `galaxy_view_prompts.md` § 2? If it diverges, I document the delta first
- What is actually *connected*: does any node link to a real entity, or is it decorative
- Animation approach and whether `prefers-reduced-motion` is honoured
- Any state that would be lost on a layout swap (selection, filters, zoom, deep links)

### A3 · The integration surface
- Routing: how the view is reached, whether it's deep-linkable
- Data fetching: server components, SWR/React Query, Zustand/Redux, plain fetch
- Design tokens: is there a theme file, or are colours inline
- Shared components I must not break: panels, headers, navigation
- Tests, lint, typecheck, CI — what gates exist and what currently passes

### A4 · Risk report
- Coupling: what else imports the galaxy module
- Dead code I'd inherit
- Performance baseline: node count, frame time, bundle contribution

**Deliverable:** `AUDIT.md` — findings, the real data contract, a file-level change list,
and any blockers stated plainly before I touch anything.

---

## PART B · THE LAYOUT DECISION

A graph is not one thing. Three genuinely different results, all called "graph layout":

### B1 · Force-directed node-link  ← *most likely what you mean*
Obsidian-style. Nodes repel, edges pull, clusters settle into regions.
- **Best for:** a second brain. Structure emerges from the data — you see which apps
  actually talk to which, and clumps you didn't know existed.
- **Cost:** layout is non-deterministic. Needs a seeded sim + a settle pass, then freeze.
- **Preserves from the galaxy:** the colour system, the glass nodes, the core, the glow.

### B2 · Hierarchical / layered
Core at top, clusters below, apps as leaves. Deterministic, tidy, ordered.
- **Best for:** org charts, dependency trees, anything with real parentage.
- **Cost:** kills the "discovery" quality. It's a diagram, not a map.

### B3 · Hybrid — radial skeleton, real edges
Keeps the concentric orbits (the composition you already approved) but adds true edges
between nodes, with force relaxation inside each ring.
- **Best for:** keeping the poster quality you liked while gaining the connectivity.
- **Cost:** less emergent structure; rings constrain what the graph can tell you.

**My recommendation: B1**, with B3's discipline applied to the visual layer — force-directed
geometry, but rendered with the existing brand system so it still looks like your product
and not like a generic graph library.

### What changes regardless of choice

| Concern | Galaxy (today) | Graph (target) |
|---|---|---|
| Position | computed from angle + fixed radius | computed by the sim, then frozen |
| Node kinds | core, app, routine (implicit clusters) | core, cluster, app, routine — all first-class |
| Edges | decorative spokes, core→app only | real, typed, bidirectional |
| Cluster | an arc of dots | a hull/region containing members |
| Zoom | fit-to-screen | fit, focus-on-node, follow-selection |
| Determinism | fully deterministic | seeded PRNG + settle-then-freeze |
| Interaction | hover/focus | hover subgraph, click focus, drag, search |

### The new edge model — this is the real work

The galaxy has no edges worth the name. A graph is *made of* edges, so this is where the
integration lives. Minimum viable edge types:

```
core      → cluster     "owns"
cluster   → app         "contains"
app       ↔ app         "integrates with"     ← the signal that matters
routine   → app|cluster "triggers" / "reads" / "writes"
```

Typed edges let you colour, weight, filter and animate them differently — line style,
arrowheads, dash, pulse speed. Without types you get hairball soup.

**Where do the app↔app edges come from?** This is the question to answer during the audit.
Options, best to worst: (1) already in your data, just unrendered; (2) derivable from your
routines/config — what reads and writes what; (3) declared in a small relationships file
you maintain; (4) inferred from co-occurrence. I'll tell you which is available once I can
read the repo, and I won't invent edges that don't reflect reality.

---

## PART C · WORK SEQUENCE

Each step ends in something runnable. No big-bang swap.

**01 · AUDIT** → `AUDIT.md`. Repo shape, real data contract, change list, risks.

**02 · DATA LAYER** → the graph model lands beside the galaxy, unused.
- `graph.types.ts` — Node, Edge, GraphData, with the existing types mapped in
- `build-graph.ts` — takes your current data, returns nodes + edges, seeded, deterministic
- Unit tests: node count matches, every edge resolves to a real node, no orphans
- The app still renders the galaxy. Nothing visible has changed.

**03 · LAYOUT ENGINE** → the sim runs headless.
- Force simulation, seeded, with a settle-then-freeze pass
- Runs in a worker if node count justifies it
- Snapshots committed as fixtures so the layout is stable across machines
- Still nothing visible.

**04 · GRAPH VIEW** → the render, behind a flag.
- Same brand system: gradient field, star layer, glass nodes, mono labels, amber core
- Cluster hulls, typed edges, directional pulses
- Interactions: hover subgraph, click focus, drag, zoom/pan, keyboard nav
- `?view=graph` or a feature flag — galaxy still the default, side by side

**05 · PARITY + SWAP**
- Port every interaction the galaxy had, so nothing regresses
- Accessibility pass: focus order, accessible names, reduced-motion
- Performance: target 60fps at your real node count, measured not assumed
- Flip the default. Galaxy stays in the tree one release as a fallback.

**06 · CLEANUP**
- Remove the galaxy module only after the fallback release
- Update docs, delete dead radii/constants, close the flag

### Verification — "connected and working properly" means all of this passes

- [ ] Fresh clone → install → dev → build, all clean
- [ ] Typecheck, lint, tests pass
- [ ] Every node resolves to a real entity in your data — no decorative nodes
- [ ] Every edge resolves to two real nodes — no orphans, no dangling ids
- [ ] Layout is identical across reloads and across machines (seeded)
- [ ] Selection, filters and deep links survive a page reload
- [ ] Hover highlights the true subgraph, not an approximation
- [ ] 60fps while dragging and while zoomed out to full graph
- [ ] Reduced-motion honours the OS setting
- [ ] Keyboard-only navigation reaches every node
- [ ] Bundle size delta reported
- [ ] Rollback is one flag flip

---

## What I need from you

1. **The repository.** Public URL → I clone it now. Private → upload a zip of the repo
   (or the app subtree) and I'll work from that. I can't take a personal access token;
   don't paste one.
2. **The layout choice** — B1, B2 or B3 above.
3. **The edge source** — if you already know where app↔app relationships live, tell me and
   I'll skip the discovery step.

Once I can read the code, Step 01 comes back with findings, not questions.

---

## Appendix — prototype verification log

`agentic-os-graph-view.html` is the runnable prototype for **B1 (force-directed)**. It is
sample-data only, but the layout engine, render path and interaction layer are the real
implementations, and all three are verified. Re-run the harness any time:

```bash
python3 -c "import re;h=open('agentic-os-graph-view.html').read();open('/tmp/graph.js','w').write(re.search(r'<script>(.*)</script>',h,re.S).group(1))"
node --check /tmp/graph.js     # syntax
node /tmp/interact3.js         # full boot + render + interaction suite (harness in /tmp)
```

No headless browser exists in this sandbox, so verification is a stubbed DOM + 2D-context
harness that executes the **real** script and counts every draw call. It cannot catch
visual regressions — only logic, runtime and geometry ones.

**Data integrity** — 38 nodes (1 core / 8 cluster / 22 app / 7 routine), 71 edges,
0 broken edges, 0 orphan nodes, degree range 1–15.

**Layout** — seeded PRNG, so identical positions across reloads and machines. Measured
settled extent **1879 × 1706 px**, **0 overlapping node pairs**, tightest gap **101 px**,
closest cluster centroids **260 px** apart. All coordinates finite (no NaN blow-up).
Settles to `alpha < alphaMin` in ~800 steps, then freezes — no idle CPU burn.

Physics constants that produced that result (they are tuned, not guessed — five
candidates were measured before this one won):

| constant | value | role |
|---|---|---|
| `repulsion` / `repulsionMax` | 90000 / 90 | pair repulsion, clamped per tick |
| `linkK` | 0.0045 | spring stiffness |
| `velDecay` | 0.74 | velocity damping |
| `alphaDecay` / `alphaMin` | 0.984 / 0.0015 | cooling schedule |
| `clusterPull` / `centerPull` | 0.060 / 0.0008 | cohesion vs. drift |
| `LINK_DIST` | owns 600, contains 290, integrates 340, triggers 90, reports 420 | rest lengths per edge type |

**Render** — first paint emits 1420 arcs, 685 edges, 310 text runs, 40 smoothed cluster
hulls, 575 save/restore pairs. No external requests: the file is fully self-contained, so
it renders under a sandboxed iframe with no network.

**Interactions** — hit-testing resolves **38/38 nodes correctly via the real screen→world
transform** (0 unreachable, 0 mis-picks). Hover populates the inspect panel and sets the
cursor; click selects and highlights the true neighbour set (verified: app "Assistant" →
5-node highlight, 4 links listed); click on empty space clears; drag pins a node and
releases it cleanly; pan is exact (100,60 requested → 100,60 applied); wheel zoom is
cursor-anchored and clamped to [0.28, 3.2]; `/` focuses search, Escape resets; zoom / fit /
relayout buttons all work. Escape, search and relayout leave 0 uncaught errors.

Two real bugs were found and fixed by this harness — worth noting because they are the
kind that survive eyeballing:

1. The original relaxation had no velocity clamp or cooling, so it **diverged** — settled
   coordinates spread to ~1,000,000 px. Replaced with an alpha-cooled, velocity-clamped,
   damped integrator.
2. `hullPath()` shadowed an array with an arrow function of the same name and threw
   `p.forEach is not a function` on **every frame** — the cluster regions never drew.

**Still sample data.** The 26 app nodes and all 84 edges are placeholders. Nothing here
substitutes for the audit: the real node set, the real edge source and the real build
integration are all still Step 01.

### Update — navigation + Jarvis interactivity

**Zoom** is now a real camera with a target state that the render loop eases toward, and
direct manipulation (wheel, drag) writes current *and* target so a tween can never fight
a gesture. Verified: buttons, `+`/`-`/`0` keys, wheel, and voice all move it; the wheel
keeps the world point under the cursor pinned (measured drift < 0.6 px world) and both
ends clamp exactly at 0.28× / 3.2×.

**Every entity is openable.** Clicking a domain frames its members and lights the hull;
clicking an app frames it against its domain and lights its true neighbour set; clicking
a routine lights what it fires; clicking the root returns to overview. Edges are pickable
too — `pickEdge` resolves **84/84** at their midpoint and opens a relationship card.
All 8 domains, all 26 apps and all 7 routines were opened in sequence and checked for
correct selection, correct highlight set and correct camera framing. Breadcrumb, RESET,
the ⌖ focus button and legend-swatch clicks all drive the same code path.

**Jarvis** is a voice + chat console over the graph. **28/28 interpreted phrasings pass**,
including `open memory`, `open dev and prs`, `what connects Assistant`,
`whats connected to drive`, `where is metrics`, `list domains`, `how many edges`,
`zoom 150`, `mute`, and bare entity names. Voice and typing run through the *same*
`interpret()` — a transcript is not a second-class path.

The interpreter is deliberately **local**. There is no network call anywhere in the file,
which is what lets it work offline and inside the sandboxed preview frame. Swapping it for
a real LLM later means replacing `interpret()` and keeping the `{action, reply}` contract;
nothing else moves. Speech synthesis is optional at every step — if the browser has no
voices, no mic, or the frame blocks the microphone, the console says so and stays fully
usable by typing.

**One caveat, stated plainly:** the mic cannot be exercised in the preview, because the
preview sandbox has no microphone permission. The recognition code path is verified
against fake browser speech APIs (start → transcript → reply → end, plus the
`not-allowed` error branch), and muting was checked to suppress speech without
suppressing the action. But no real microphone has ever reached this code. Test that on
your machine.

`graph_view_tests/` holds the harness and its README so these results are reproducible.
