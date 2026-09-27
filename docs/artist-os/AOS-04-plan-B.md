# AOS-04 — The Mercury shell: implementation plan (Plan B of 3)

> **For agentic workers:** execute task by task. Steps use checkbox (`- [ ]`) syntax. Every task commits its failing test before the code that turns it green (house rule since AOS-01).

**Goal:** the whole web app moves from the AOS-01 brutalist shell to **XYP3RN Mercury**:
- graphite/mercury tokens and locally hosted fonts;
- a three-column shell (top bar, left rail, per-page right rail) that works from 1920 px down to 390 px;
- a four-card metric strip whose every figure names its source and as-of time;
- a Sofia clock synced to server time;
- the Research screens recomposed per §17.

No sphere, graph or file index: those are Plan C.

**Architecture:**
- **Tokens:** one presentation module (`apps/web/lib/tokens.ts`) feeds Tailwind and a contrast test. Domain hues stay in `core/contracts/taxonomy.ts`; the module adds only the brighter label variants.
- **Restyle:** the base layer in `globals.css` restyles every page through the classes pages already share (`h1`/`h2`/`table`, `.meta`, `.tag`, `.card`, `.status-*`). Pages are edited only where §13/§17 change their composition.
- **New server reads:** `shell-loaders.ts` (metrics, pulse, activity) runs as `xyp_web` in read-only transactions.
- **New client code:** the clock, the navigation drawer and the run page's focus-safe refresh. They are the app's first client components. Everything else stays server-rendered.
- **Server time:** one new authenticated route, `/api/time`.

**Tech stack:** as Plan A. New pinned dependencies (apps/web only):
- `@fontsource-variable/inter@5.3.0`;
- `@fontsource-variable/space-grotesk@5.3.0`;
- `@fontsource/ibm-plex-mono@5.3.0`.

All three are OFL-1.1.

**Spec:** [AOS-04-design.md](AOS-04-design.md) §§13–14, §17, §19 and the Plan-B rows of §§20–21. §§15–16 and §18 (graph, index, sphere, motion) are **Plan C**. [Plan A](AOS-04-plan.md) is built (PR #17).

## Decisions (operator, 2026-09-27)

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| M1 | How far the re-skin goes | **The whole app.** Swap tokens and base styles so every page takes Mercury. Recompose Command and Research per §13/§17. The AOS-01 "modern brutalism" note in `tailwind.config.mjs` is superseded. | Shell + Research only (visually mixed); keep brutalism (departs from §14) |
| M2 | Where the fonts come from | **`@fontsource` npm packages**, pinned. The Next build bundles the WOFF2 files; no runtime CDN. | Vendored WOFF2 in git; `next/font/google` (network at every build) |
| M3 | Delivery | **This plan first**, reviewed before code; stacked on the AOS-04 branch. | Plan + build in one go; wait for PR #17 to merge |

## Global constraints

- **Nothing fabricated (§20):**
  - every figure comes from a query and shows its source definition and as-of time;
  - zero means the query returned zero; a failed query shows "unavailable", never 0;
  - a provider key's presence reads "Configured", never "healthy" or "connected".
- **No pixel-perfect clones of the reference images.** The design's tokens and layout rules are the spec.
- **Existing behaviour stays:**
  - every form, action, route and loader keeps working;
  - the web tests and `web:smoke` stay green at every commit;
  - no OS module changes except read-only loaders.
- **Client components:** only where interactivity needs them (clock, drawer, run refresh). Each is small, has no data fetching beyond `/api/time`, and degrades without JS: the nav is plain links, the clock shows the server-rendered time, and the run page falls back to the Plan A meta refresh.
- **Accessibility floor:**
  - text ≥4.5:1 and control boundaries ≥3:1 (pinned by a test);
  - a 2 px focus ring with 3 px offset;
  - pointer targets ≥44×44 px on buttons and nav;
  - no colour-only status;
  - `prefers-reduced-motion` honoured;
  - 390 px width with no horizontal page scroll.
- **Gates before each push:**
  - `pnpm typecheck`, `pnpm test`, `pnpm agents:validate`;
  - a migration down/up/down/up on the dev DB (no migration in this plan; the round trip still runs);
  - `pnpm web:build` and `pnpm web:smoke`.
- **Commit messages:** `AOS-04 red test: …` / `AOS-04 UI: …` / `AOS-04: …`, ending with the Co-Authored-By line.

## Review focus

1. **Contrast is pinned, not eyeballed.**
   - Canonical Records red (`#EF4444`) is 3.72:1 on `surface-hover`: fine as a rim or chip (≥3:1), not as label text.
   - Labels use the bright variants (all ≥7.4:1 on every surface). The token test fails if a page-level text pair drops below 4.5:1.
2. **The clock never lies about accuracy.**
   - "Server-synced" appears only after a successful `/api/time` sample; otherwise "Device time · not verified".
   - Formatting uses the IANA zone, never a fixed offset. The DST cases are unit-tested.
3. **Metric definitions are exact.** Each card's query and included statuses are written in the table below and shown in the UI. A card whose query fails reads "unavailable".
4. **The re-skin breaks nothing functional.** `web:smoke` (every AOS-01–04 line) is the regression net; its selectors target roles, names and classes that must survive the restyle.
5. **Space Grotesk has no Cyrillic subset** (verified in the 5.3.0 package): headings fall back per glyph to Inter, which has Cyrillic. The font test pins this.

## Metric definitions (§13.1, the four cards)

| Card | Value | Source (as `xyp_web`) | Drilldown |
|---|---|---|---|
| Active songs | songs whose current status is `idea`, `writing`, `producing` or `releasing` | `current_songs` | `/songs` |
| Running workflows | workflow runs with status `running`; research runs with status `running` shown as a second figure | `workflow_runs`, `research_runs` | `/research` (the running runs) |
| Vault | stored files (`sources.storage is not null`) and, separately, artifact lineages (`count(distinct creative_artifacts.lineage_id)`), so versions aren't double-counted | `sources`, `creative_artifacts` | `/vault` |
| Open research briefs | briefs whose question status is `open` | `research_questions` | `/research` |

- Each card shows its as-of time. It comes from the one transaction that read all four, so they are consistent.
- Statuses not listed are excluded: `released` and `archived` songs; `success`/`error` runs; `answered`/`abandoned` briefs.
- The operator can change a definition later; the definition text is data in the loader, shown on the card.

## File map

| File | Responsibility | Task |
|---|---|---|
| `apps/web/lib/tokens.ts`, `tokens.test.ts` | surface/text/status/domain-label tokens; contrast pins; canonical hues from taxonomy | 1 |
| `apps/web/tailwind.config.mjs`, `app/globals.css` | Tailwind theme from tokens; Mercury base layer, components, status classes, focus ring, reduced motion | 1 |
| `apps/web/package.json`, `app/fonts.css`, `lib/fonts.test.ts`, `FONT-NOTICES.md` | the three font families, subsets, fallbacks, license notices | 2 |
| `apps/web/lib/clock.ts`, `clock.test.ts` | Sofia formatting, offset estimation, sync state | 3 |
| `apps/web/app/api/time/route.ts` | authenticated, uncached server time | 3 |
| `apps/web/app/shell/sofia-clock.tsx` | client clock | 3 |
| `apps/web/server/shell-loaders.ts`, `shell.test.ts` | metrics, system pulse, recent activity | 4 |
| `apps/web/lib/server.ts` | the `shellLoaders` door | 4 |
| `apps/web/app/layout.tsx`, `app/shell/*.tsx` | top bar, left rail, drawer, right-rail slot, icons | 5 |
| `apps/web/app/page.tsx` | Command: metric strip, sections re-composed, pulse + activity rail | 6 |
| `apps/web/app/research/**`, `app/research/run-refresh.tsx` | §17 composition: filters, New brief, workbench right column, outcome states, focus-safe refresh | 7 |
| every other `app/**/page.tsx` | only where the restyle exposes a layout problem (wide tables in a scroll region, forms in the new spacing) | 8 |
| `apps/web/e2e/smoke.ts` | viewports, drawer, clock, metrics, no horizontal scroll | 9 |
| docs, proof, handoff | F44 decided (M1–M3), F45 open | 10 |

---

### Task 1: Tokens and the Mercury base layer

**Files:** create `apps/web/lib/tokens.ts` and `apps/web/lib/tokens.test.ts`; modify `apps/web/tailwind.config.mjs` and `apps/web/app/globals.css`.

**Interfaces:**
- `SURFACE` (`canvas`, `surface`, `surfaceRaised`, `surfaceHover`);
- `TEXT` (`primary`, `secondary`, `muted`);
- `BORDER` (`subtle`, `control`);
- `ACCENT` (`mercury`, `champagne`, `focus`);
- `STATUS` (`success`, `warning`, `failure`, `info`, `unknown`);
- `DOMAIN_LABEL: Record<Domain, string>` (the bright variants of §14.2);
- `contrast(a: string, b: string): number` (WCAG 2.x).

Values exactly as §14.1 and §14.2.

- [ ] **Step 1: Red test** (`tokens.test.ts`):
  - every `TEXT` value, `ACCENT.mercury`, `ACCENT.champagne`, every `STATUS` and every `DOMAIN_LABEL` is ≥4.5:1 on each `SURFACE`;
  - `BORDER.control` and every canonical domain hue (`DOMAIN_META[d].color`) are ≥3:1 on each `SURFACE`;
  - `ACCENT.focus` is ≥3:1 on each `SURFACE`;
  - `BORDER.subtle` is **below** 3:1 (it is decorative only; the test names that rule so nobody promotes it to a control boundary);
  - canonical hues are read from taxonomy, never redefined: the module's domain keys equal `DOMAINS`;
  - `contrast('#FFFFFF', '#000000')` is 21, and the pair is symmetric.
- [ ] **Step 2: Run, see it fail** (no module). **Commit the red test.**
- [ ] **Step 3: Implement.**
  - `tokens.ts` holds the values and `contrast`.
  - `tailwind.config.mjs` imports them. Colours: `canvas`, `surface`, `raised`, `hover`, `line`, `control`, `ink-1/2/3`, `mercury`, `champagne`, `focus`, the six domain hues plus `-label` variants, and the five status colours. `fontFamily`: `sans`, `display`, `mono` (Task 2 fills the families). `screens`: `md 960px`, `lg 1280px`, `xl 1600px`.
  - `globals.css`:
    - base: `html` canvas with `text-primary` and Inter at 15–16 px / 1.55; headings in the display family (28–32 px titles); `h2` as the 12 px uppercase section label (the only uppercase); `a` with a mercury underline;
    - tables: `surface` rows, a `hover` row background, and a labelled scroll region class `.table-scroll`;
    - controls: inputs with 10 px radius and a `control` border; buttons ≥44 px high; the focus ring `2px solid focus`, offset 3 px;
    - components: `.panel` (gradient surface, 1 px border, 14 px radius, the §14.1 shadow, a top-edge highlight), `.card` = `.panel` + 20–24 px padding, `.meta` as muted 12–13 px, `.tag` as a chip, `.quote` for evidence at 16 px with a 60–80ch measure;
    - `.status-*`: the status colour plus a text word. The existing names (`approved`, `success`, `running`, `promoted`, …) map to success/warning/failure/info/unknown, and Records red is never a status;
    - `@media (prefers-reduced-motion: reduce)`: transitions off.
- [ ] **Step 4:** `pnpm vitest run apps/web/lib/tokens.test.ts && pnpm web:build && pnpm web:smoke` must all pass (every page restyled, every smoke line green). **Commit:** `AOS-04 UI: Mercury tokens and base layer (whole app, M1); contrast pinned by test`.

### Task 2: Fonts (M2)

**Files:** modify `apps/web/package.json` and the lockfile; create `apps/web/app/fonts.css`, `apps/web/lib/fonts.test.ts` and `apps/web/FONT-NOTICES.md`; modify `apps/web/app/layout.tsx` (import `fonts.css`).

- [ ] **Step 1: Red test** (`fonts.test.ts`), reading the installed packages:
  - each of the three packages is present at the pinned version with `license: OFL-1.1`;
  - Inter and IBM Plex Mono ship `cyrillic` and `latin` WOFF2 subsets;
  - Space Grotesk ships `latin` and no `cyrillic`, and `fonts.css` lists Inter right after it in the display stack (the verified per-glyph fallback);
  - `fonts.css` sets `font-display: swap` on every `@font-face` it declares, and imports only from the three packages (no `http`);
  - `FONT-NOTICES.md` carries each package's copyright line from its `LICENSE`.
- [ ] **Step 2: Run, see it fail. Commit the red test.**
- [ ] **Step 3: Implement.**
  - `pnpm --filter @xyp3rn/web add` the three pinned packages.
  - `fonts.css` imports the packages' CSS (`@fontsource-variable/inter/index.css` etc.) and defines the `--font-sans/display/mono` stacks from §14.3.
  - The notices file quotes each LICENSE's copyright line and names OFL-1.1.
  - Tabular numerals (`font-variant-numeric: tabular-nums`) on `.num` and the mono stack.
- [ ] **Step 4:** tests, `web:build` (the WOFF2 files land in `.next/static/media`; the build log shows no external URL), `web:smoke`. **Commit:** `AOS-04 UI: locally hosted Inter, Space Grotesk and IBM Plex Mono (M2); notices; Cyrillic fallback pinned`.

### Task 3: The Sofia clock (§19)

**Files:** create `apps/web/lib/clock.ts`, `apps/web/lib/clock.test.ts`, `apps/web/app/api/time/route.ts` and `apps/web/app/shell/sofia-clock.tsx`.

**Interfaces (`clock.ts`, pure):**
- `sofiaParts(epochMs): { time: 'HH:mm:ss'; short: 'HH:mm'; date: string; offset: 'GMT+02:00' | 'GMT+03:00' | … }`. `Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', …, hourCycle: 'h23' })` for the parts; `timeZoneName: 'longOffset'` for the offset.
- `offsetFromSample({ sentAt, receivedAt, serverEpochMs }): { offsetMs, rttMs }`, where offset = server − the midpoint of sent and received.
- `bestSample(samples): Sample | null`: the lowest round trip.
- `syncState(last: { at: number } | null, now: number): 'server-synced' | 'device-unverified' | 'stale'`, where stale means older than 10 minutes.
- `SYNC_EVERY_MS = 300_000`, `STALE_AFTER_MS = 600_000`.

- [ ] **Step 1: Red test** (`clock.test.ts`):
  - winter: `2026-01-15T12:00:00Z` → `14:00:00`, `GMT+02:00`;
  - summer: `2026-07-15T12:00:00Z` → `15:00:00`, `GMT+03:00`;
  - spring jump: `2026-03-29T00:59:59Z` → `02:59:59`, then `01:00:00Z` → `04:00:00`;
  - autumn repeat: `2026-10-25T00:30:00Z` → `03:30:00 GMT+03:00`, and `01:30:00Z` → `03:30:00 GMT+02:00` (same wall time, different offsets);
  - midnight rollover: `2026-12-31T22:00:00Z` → `00:00:00` on `1 January 2027`;
  - independent of the process timezone: run with `TZ=America/New_York` via `process.env.TZ` set before import; the results are identical;
  - offset estimation: a 100 ms round trip whose server time is 5 s ahead gives `offsetMs` 5000 ± 1 and `rttMs` 100; `bestSample` picks the smallest round trip;
  - sync state: null → `device-unverified`; a sample 1 minute old → `server-synced`; 11 minutes old → `stale`.
- [ ] **Step 2: Run, see it fail. Commit the red test.**
- [ ] **Step 3: Implement.**
  - **`clock.ts`** as above.
  - **`/api/time`** is `GET` only, `dynamic = 'force-dynamic'`, `Cache-Control: no-store`, and returns `{ epochMs: Date.now() }`. It sits behind the existing middleware session check (no session → 401); the route itself adds nothing public.
  - **`sofia-clock.tsx`** (`'use client'`):
    - **First render:** the server passes its instant, so hydration matches, in a fixed-width placeholder.
    - **Sampling:** three samples at mount; then every `SYNC_EVERY_MS`, on `visibilitychange` to visible and on `online`. It keeps the lowest round trip.
    - **Ticking:** display = `performance.now()` anchor + offset, recomputed each tick from the timestamp (never incremented). No rendering while the tab is hidden.
    - **Markup:** two lines, `SOFIA, BG` and `HH:mm:ss` (`HH:mm` below `md`). The date and offset sit in the `title` and an accessible description. The sync state is a word ("Server-synced" / "Device time · not verified" / "Server time · stale"). An `aria-live="polite"` region announces only sync-state changes, never seconds.
- [ ] **Step 4:** `pnpm vitest run apps/web/lib/clock.test.ts`, typecheck, build. **Commit:** `AOS-04 UI: the Sofia clock (IANA zone, server-synced offset, honest sync state) and /api/time`.

### Task 4: Shell loaders: metrics, pulse, activity

**Files:** create `apps/web/server/shell-loaders.ts` and `apps/web/server/shell.test.ts`; modify `apps/web/lib/server.ts` (the `shellLoaders` door).

**Interfaces:**
- `metrics(sql): Promise<{ asOf: string; cards: MetricCard[] }>`, where `MetricCard = { key; label; value: number | null; secondary?: { label; value }; definition; source; href; error?: string }`. On a failed query, `value` is null with `error` set: the card reads "unavailable".
- `pulse(sql, env, registry): Promise<PulseRow[]>`, where `PulseRow = { label; state: 'ok' | 'configured' | 'not-configured' | 'unavailable'; detail; asOf }`. Rows:
  - database reachable: the query ran, with its time;
  - migration head: `appliedVersions`, read through the pool; it is not an `xyp_web` table;
  - agents registered;
  - LLM providers: for each key env in `PROVIDERS`, "Configured" or "Not configured" (presence only, never the value, never "connected");
  - the last ingestion run and its status.
- `activity(sql, limit = 12): Promise<ActivityRow[]>`: the newest of agent runs, workflow runs, research runs and owner decisions (`approval_queue` decided rows), each `{ at; kind; title; status; href }`, newest first.

- [ ] **Step 1: Red test** (`shell.test.ts`, throwaway DB, songs created via `songCreate` and runs via fixtures):
  - with 2 `idea`, 1 `writing`, 1 `released` and 1 `archived` song, Active songs = 3 (`idea` counts; `released` and `archived` don't). The definition text names the four statuses.
  - A `running` and a `success` workflow run give 1; a running research run appears as the secondary figure.
  - Vault: 2 stored files and one lineage with 3 versions give files 2, lineages 1.
  - Open briefs counts `status = 'open'` only.
  - All four cards share one `asOf`.
  - A card whose query fails (simulated by a loader seam that throws) has `value: null` and `error`, and the others still render.
  - `pulse` with `env = { OPENROUTER_API_KEY: 'x' }` reports OpenRouter "Configured" and Anthropic "Not configured". The output never contains the key's value.
  - `activity` returns rows newest first across kinds, each with an `href` that resolves to an existing route pattern.
  - Every loader runs as `xyp_web`: a write inside it would fail. Asserted by the `asWeb` read-only transaction, as the other loader tests do.
- [ ] **Step 2: Run, see it fail. Commit the red test.**
- [ ] **Step 3: Implement** as specified. Each card is its own query inside one `asWeb` transaction; a failure is caught per card.
- [ ] **Step 4:** tests, typecheck. **Commit:** `AOS-04: shell loaders (metric strip with definitions, system pulse, recent activity), read as xyp_web`.

### Task 5: The shell (§13.1, §13.3)

**Files:** modify `apps/web/app/layout.tsx`; create `apps/web/app/shell/{top-bar,left-rail,nav-drawer,icons,right-rail}.tsx`.

- **Grid:** at `xl`, `232px minmax(0,1fr)` + an optional right rail of 320 px, with 20 px padding and gaps. At `lg`, the rails are 216/304 px with 16 px gaps. Below `lg`, the left rail becomes a drawer. Below `md`, a single column.
- **Top bar (68–76 px):**
  - the XYP3RN mark + "Mercury" (the interface name only, no "network" wording);
  - a search field that searches the **Vault** (`/vault?q=`), labelled exactly that. The global index search is Plan C, and the field says so in its hint;
  - the Sofia clock;
  - identity: `XYP_OWNER` shown as the signed-in owner, and the logout button.
- **Left rail:**
  - primary nav with icon and full label: Command, Studio, Research, Creative Vault, Songs, Releases, Tasks;
  - secondary nav: People, Ingest;
  - "Analytics" shown disabled with the reason "not built (AOS-06)";
  - the current page marked with `aria-current="page"`;
  - no domain filters (they filter the graph: Plan C).
- **Drawer** (`'use client'`): a `<dialog>` opened by a labelled button; `showModal` traps focus; Escape closes; focus returns to the trigger. It is progressive enhancement: the rail is only hidden below `lg` once the client component has mounted, so without JS the links still render as a plain nav, and navigation never depends on the drawer.
- **Right rail:** a layout slot that pages fill through a `RightRail` component wrapper. A page without one gets the full width.
- **Icons:** inline SVG, `aria-hidden`, drawn in this repo (no icon package).
- [ ] **Test:** covered by Task 9's smoke (drawer, `aria-current`, no horizontal scroll at 390 px, the four viewports). There is no red unit test for markup. The drawer's keyboard contract is asserted in the browser.
- [ ] **Commit:** `AOS-04 UI: the Mercury shell (top bar with Vault search, clock and identity; left rail and drawer; right-rail slot)`.

### Task 6: Command (§13.1)

**Files:** modify `apps/web/app/page.tsx`.

- **The metric strip:** four cards; 2×2 below `xl`. Each card shows its value (tabular, 28–36 px), definition, source, as-of time (`<Time>`) and a drilldown link. An "unavailable" card shows the error text, not 0.
- **The sections below:** songs by status, releases, open tasks, alerts, recent research. Same data, restyled into panels; wide tables go in `.table-scroll` regions.
- **Right rail:** System pulse (Task 4's rows, each with a state word) and Recent activity (timestamped, with links).
- **No sphere placeholder:** the centre shows no empty graph frame. Plan C adds the sphere above the sections.
- [ ] **Test:** Task 9's smoke asserts that four cards render, each with a definition and as-of time, and that Active songs equals the song count the journey created at the moment it is read.
- [ ] **Commit:** `AOS-04 UI: Command in the Mercury shell (metric strip with definitions, pulse and activity rail)`.

### Task 7: Research composition (§17)

**Files:** modify `apps/web/app/research/page.tsx`, `research-ui.tsx`, `runs/[id]/page.tsx` and `library/page.tsx`; create `apps/web/app/research/run-refresh.tsx`; extend `apps/web/server/research-loaders.ts` and `research.test.ts`.

- **`/research`:**
  - a "New brief" action that jumps to the form;
  - filters by latest-run status and by target kind/target, as GET params, applied in `researchIndex` (red test first);
  - the brief list as readable rows: intended use, target chips, latest run.
- **Workbench (`/research/runs/[id]`):**
  - **Header:** question, status word, elapsed time (computed from recorded start/end, not estimated), start/deadline, re-run.
  - **Target chips** below the header.
  - **Main column:** specialist results, then findings by topic, side by side on desktop and stacked on mobile.
  - **Right column:** the selected evidence (`?evidence=<id>`, default the first) with its source, quote, model tag and confidence inputs, plus a compact provenance path: brief → run → evidence → source, then finding → candidate → approval → canonical where records exist.
  - **Outcome words** kept distinct: Completed, No sources, Declined (n), Failed, Timed out. Timed out is an agent run whose error starts `timeout after` (red test in `research.test.ts` for the loader's `outcome` field).
  - **Progress:** completed/total only when `selected` is recorded; otherwise a labelled indeterminate state.
  - **Partial evidence** labelled after a failure.
- **Focus-safe refresh** (`run-refresh.tsx`, client): while the run is `running`, every 5 s it calls `router.refresh()`, but only when no input, textarea or select has focus and every reason field is empty. The Plan A meta refresh stays in a `<noscript>` fallback.
- **Library:**
  - filters by target and topic;
  - each card shows claim, evidence count, source links, the acceptance decision, and the canonical status as a separate badge;
  - "Accepted in library" is never styled like "Canonical".
- [ ] **Red tests first:** the new `researchIndex` filters, the `runDetail` outcome words (including Timed out), and elapsed time from recorded timestamps.
- [ ] **Commit(s):** `AOS-04 red web tests: research filters, outcome words, elapsed time` then `AOS-04 UI: Research per §17 (filters, workbench evidence column and provenance path, outcome words, focus-safe refresh)`.

### Task 8: The rest of the app in the new layout

- Walk every page at 1440 and 390 px (the Task 9 screenshots) and fix only what the restyle exposes:
  - wide tables go into `.table-scroll` with an accessible label;
  - forms use the new field spacing;
  - long IDs and paths get a truncation with the full value in `title` and a copy button where the page already shows the value.
- No content or behaviour changes.
- [ ] **Commit:** `AOS-04 UI: pages settled in the Mercury layout (scroll regions, field spacing, long values)`.

### Task 9: The browser journey

**Files:** modify `apps/web/e2e/smoke.ts`.

- Every existing line stays.
- New checks:
  - after login, the top bar shows `SOFIA, BG`, a `HH:mm:ss` time, and the sync-state word "Server-synced", with `/api/time` returning 200 with a session and 401 without;
  - `/` shows four metric cards, each with a definition and an as-of `<time>`; Active songs matches the journey's song count at that moment;
  - at 1024×768 the rail is a drawer: the button opens it, Escape closes it, focus returns to the button;
  - at 390×844 on `/`, `/research`, `/research/runs/<id>`, `/studio/packages/<id>` and `/songs/<id>`, `document.documentElement.scrollWidth <= innerWidth` (no horizontal page scroll);
  - `aria-current="page"` is on the active nav item;
  - the run page shows an outcome word and the evidence column with the quote and source;
  - with `reducedMotion: 'reduce'`, the computed transition duration of a nav link is 0.
- Screenshots of `/`, `/research`, a run page and `/research/library`: 1920×1080, 1440×900, 1024×768, 390×844, and "200% zoom", approximated by a 960×540 CSS viewport at device scale 2.
- [ ] **Commit:** `AOS-04: web:smoke drives the Mercury shell (clock, metrics, drawer, 390 px, reduced motion; four viewports + 200%)`.

### Task 10: Proof, docs, handoff

- `docs/proofs/AOS-04-mercury.txt`:
  - the token contrast table (from the test);
  - the clock DST cases;
  - the metric definitions with a DB readout;
  - the smoke output and the screenshot list;
  - the gates.
- ARCHITECTURE:
  - **F44** "The Mercury shell (AOS-04 Plan B)": M1–M3 one line each; the metric definitions; the clock's sync rule;
  - **F45** (open): global search and domain filters wait on Plan C's index; no measured performance numbers yet (§18 targets are Plan C's); the neighbouring checkout's Mercury SVG shell was not used (§12.3).
- The AOS-04 handoff gains a Plan B section; README's AOS-04 line is updated.
- Run every gate; paste the summaries into the proof. **Commit:** `AOS-04 proof and docs: the Mercury shell (F44 decided, F45 open)`.

## Out of scope (Plan C)

- The permission-filtered graph/index projection (entities, edges with provenance, repository-file scope, safe preview).
- The sphere renderer and its SVG/2D fallback.
- Graph/List parity, the inspector, domain filters and global search over the index.
- Source-aware camera motion and the command bar's answers.
- The §18 performance measurements.

## §21 checklist rows this plan closes

- **Visual:**
  - four viewports + 200% for the shell and Research;
  - domain hues, fonts and spacing consistent.
- **Time:** all §19 cases.
- **Research:**
  - the §17 composition;
  - outcome words;
  - partial failure;
  - library vs canonical distinction.
- **Accessibility:**
  - keyboard navigation of the shell;
  - contrast measured by test;
  - reduced motion;
  - 390 px.
- **Still open for Plan C:** "Source reality", "Coverage", "Connections", "Ownership" (lenses), "File safety", "Freshness", "Answers", the rest of "Accessibility/performance".
