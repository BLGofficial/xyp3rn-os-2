# Primary Interface Forensic Audit (`UI-xyp3rn`)

**Audit Date:** 2026-11-16  
**Audited Checkout:** `C:\Users\blago\Desktop\building-agentic-systems\XYP3RNOS\UI-xyp3rn` (`origin`: `https://github.com/BLGofficial/UI-xyp3rn.git`, branch `main` @ `27d2ea5`, clean working tree) — **VERIFIED**  
**Scope:** Read-only forensic inspection of App Router pages, components, constellation geometry/camera, tokens/typography, static data, Gateway API adapters, `localStorage`, responsiveness, tests, and build setup.

---

## 1. Executive Reality Finding

`UI-xyp3rn` is **cleanly decoupled from PostgreSQL and Supabase** (**VERIFIED**: zero imports of `postgres` or `@supabase/*` across `app/`, `components/`, `data/`, `lib/`). It operates as a Next.js `14.2.35` SPA/SSR shell targeting `127.0.0.1:3000` (with static build output `next build`) communicating exclusively via JSON HTTP calls to OS3 Gateway (`127.0.0.1:8077`), backed by deterministic client-side seed fallbacks on Map, Jarvis, and Dashboards.

Meanwhile, legacy `apps/web/` inside `xyp3rn-os-2` (`@xyp3rn/web`, Next `15.5.27` on `:3100`) remains present in the backend monorepo, creating a UI stack divergence (`INFERRED`: legacy `apps/web/` should stay frozen).

---

## 2. App Structure & Routes (`UI-xyp3rn/app/`, `VERIFIED`)

| Route / File | Responsibility | Primary Component |
|---|---|---|
| [app/layout.tsx](file:///C:/Users/blago/Desktop/building-agentic-systems/XYP3RNOS/UI-xyp3rn/app/layout.tsx) | Root shell, 4 `@fontsource/*` font CSS imports, seeded 60-star `StarField`, `ChromeShell` | `ChromeShell` |
| [app/page.tsx](file:///C:/Users/blago/Desktop/building-agentic-systems/XYP3RNOS/UI-xyp3rn/app/page.tsx) / [app/map/page.tsx](file:///C:/Users/blago/Desktop/building-agentic-systems/XYP3RNOS/UI-xyp3rn/app/map/page.tsx) | Primary 6-sector 3D Constellation Map | `MapScreen` |
| [app/dashboards/page.tsx](file:///C:/Users/blago/Desktop/building-agentic-systems/XYP3RNOS/UI-xyp3rn/app/dashboards/page.tsx) | OS3 Telemetry, Agents, Workflows, Approvals, Research, X3LIUS Records & Entity Inspector | `DashboardsView` |
| [app/chart/page.tsx](file:///C:/Users/blago/Desktop/building-agentic-systems/XYP3RNOS/UI-xyp3rn/app/chart/page.tsx) | Obsidian Vault Wikilink Topology Knowledge Graph | `KnowledgeGraphView` |
| [app/jarvis/page.tsx](file:///C:/Users/blago/Desktop/building-agentic-systems/XYP3RNOS/UI-xyp3rn/app/jarvis/page.tsx) | Full-screen Voice Orb Console + Zero-Storage Audio Reverse-Engineer + Vault/OS Inspector | `JarvisView` |

---

## 3. Constellation / Galaxy Components, Geometry & Camera (`VERIFIED`)

- **Core Rendering Pipeline (`components/ConstellationCanvas.tsx`, `BrainCore.tsx`, `SectorTree.tsx`):**
  - Renders a full-viewport SVG scene inside `.constellation-3d-stage` (GPU CSS `perspective(1500px)` pointer-parallax tilt + `rotateX(6deg)` resting angle, disabled automatically under `prefers-reduced-motion`).
  - SVG `<defs>` supply zero-overhead radial sphere gradients (`#sphere-3d-core`, `#sphere-3d-solid`, `#hub-3d-glass`) and blur `#glow`.
  - Framer Motion `useMotionValue` / `useSpring` writes transforms directly to SVG DOM attributes (`cameraRef`, `overviewRef`, `focusRef`, `brainRef`) at 60fps without React re-renders.
  - Camera supports wheel zoom, two-finger pinch, drag pan, and floating HUD zoom controls (`-`, `%`, `+`, Reset, `3D` toggle) in **both Overview and Focus** (`ZOOM_MIN = 0.45`, `ZOOM_MAX = 4.2`), with automatic Zoom LOD (`data-zoom-lod="detail"` at `>= 1.45` reveals `.overview-zoom-label` node titles via CSS).
- **Pure Geometry & Camera Math (`lib/layout.ts`, `lib/camera.ts`, `lib/prng.ts`):**
  - Deterministic layout (`ringPosition`, `layoutSector`, `layoutFocusArc`) driven by seeded PRNG (`mulberry32`) and immutable pixel bounds pinned by snapshot tests (`lib/__tests__/__snapshots__/layout.test.ts.snap`).
  - `fitScale`, `clampPan`, `zoomAt` preserve pointer-centered zoom math in Focus mode; Overview mode applies symmetric viewport clamping.
- **3D Voice Assistant Orb (`lib/voice-orb.ts`, `components/JarvisVisualizer.tsx`):**
  - Uses Three.js `0.160.0` (`OrbitControls`, `EffectComposer`, `RenderPass`, `UnrealBloomPass`) reactive to live mic + `<audio>` `AnalyserNode` (`low`/`mid`/`high`/`punch`), with explicit SVG fallback when WebGL is unavailable.

---

## 4. Design Tokens, Typography & Visual System (`VERIFIED`)

- **Single Token Source (`lib/tokens.ts`):**
  - `TOKENS`: `bg: '#090C14'`, `ink: '#F4F1EA'`, `inkDim: '#A6ADBF'`, `hairline: 'rgba(244,241,234,0.16)'`, `accent: '#FFAC5E'`.
  - `SECTOR_COLORS`: bound strictly by test (`lib/__tests__/data.test.ts`) to `data/map.ts` (`#38BDF8`, `#8B7CF6`, `#EC6A9C`, `#E8C53A`, `#3ECFB2`, `#E5484D`).
  - `LAYOUT`: ring ratios, hub radius (`22`), node disc sizes, `gatewayPort: 8077`.
  - `BREAKPOINT_MOBILE`: `768`.
- **Fonts (`app/layout.tsx`, `tailwind.config.ts`):** Self-hosted `@fontsource/*` (`Cormorant Garamond` 300, `Plus Jakarta Sans` 400/600/700, `Instrument Serif` 400-italic, `JetBrains Mono` 400).
- **CSS Architecture (`app/globals.css`):** Tailwind v3.4 utilities + cosmic radial nebula backdrop + frosted glass surfaces (`.frost`, `.glass-card`, `.outlined`, `.chip`, `.jarvis-glass-panel` hover-reveal opacity transitions).

---

## 5. Static Data, API Integration & `localStorage` Audit (`VERIFIED`)

### Static Seed Sources
- **`data/map.ts`:** 6 sectors (`01_CORE`..`06_GOVERNANCE`), **137 jobs** across 46 leaf clusters (`60` written entries + `77` stubs), `x3liusTracks`, `brain` specs, `ui` copy. Merged dynamically with live Vault notes in `MapScreen.tsx` via `mergeVaultTreeIntoDepartments()`.
- **`lib/dashboard-seed.ts`:** Synthesizes fallback `overview`, `agents`, `workflows`, `research`, and `records` snapshots from `data/map.ts` when OS3 Gateway is offline/booting.

### API Clients
- **`lib/gateway.ts`:** Targets `GATEWAY_BASE_URL = 'http://127.0.0.1:8077'`. Calls `/api/jarvis`, `/api/music/pulse`, `/api/health`, `/api/vault/{note,search}`, `/api/approvals`, `/api/approvals/decide`, `/api/jarvis/{inspect,proposal/decide}`. Gracefully falls back offline for health/notes/search/command dispatch.
- **`lib/os3-adapter.ts`:** Targets `GATEWAY_BASE_URL` with an `8000ms` abort timeout (`Math.max(8000, MOTION.gatewayTimeoutMs * 4)`). Exposes typed fetchers for `/api/overview`, `/api/vault/{tree,graph}`, `/api/{agents,workflows,runs,events,approvals,research,records}`.
- **`lib/audio-reverse-engineer.ts`:** Computes client-side Web Audio telemetry (up to ~3,000 hop frames in browser RAM; zero file upload/persistence) and posts telemetry JSON to `/api/audio/reverse-engineer`, `/api/audio/save-prompts`, and `GET /api/audio/prompts`, with client-side heuristic fallback offline.

### `localStorage` Keys (`VERIFIED` via `rg localStorage`)
1. `xyp3rn.constellation.status.v1` (`lib/storage.ts`) — operator status overrides per `jobId` (`not-started` | `in-development` | `live`).
2. `xyp3rn.jarvis.session.v1` (`lib/gateway.ts`) — bounded local Jarvis conversation log (`readSessionLogs`/`writeSessionLogs`).
3. `xyp3rn.ui.prefs.v1` (`lib/os3-adapter.ts`) — `UiPreferences` (active tab/sector, zoom prefs).

*Security observation (`VERIFIED`):* Zero credentials, API keys, or audio binary blobs are stored in `localStorage`. All storage helpers wrap `try/catch` for private browsing/sandboxed frames.

---

## 6. Dashboards, Empty/Failure States, Navigation & Responsive Behavior (`VERIFIED`)

- **`ChromeShell.tsx`:** Fixed mobile top header + collapsible desktop left rail (`64px`–`240px`) + centered top glass pill nav (`MAP`, `DASHBOARDS`, `CHART`, plus Jarvis launcher). `<main>` uses `flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden` so child route scrollers fit the `h-dvh` viewport cleanly.
- **Map Inspectors & Modals:** `JobPanel.tsx` (14-section job breakdown + autonomy ladder + `buildsOn` jump chips), `SkillViewer.tsx` (Markdown renderer + live Vault note sync + copy/download), both protected with `useDialogFocus.ts` focus traps and `Escape` dismissal.
- **Dashboards (`DashboardsView.tsx`):** Multi-tab interface (`SYSTEM OVERVIEW`, `AGENTS`, `WORKFLOWS & RUNS`, `APPROVALS`, `RESEARCH`, `RECORDS`). If Gateway fails/times out, displays an accessible `role="alert"` diagnostic banner with `RETRY CONNECTION` alongside interactive Local Seed telemetry cards so the page never collapses to a blank screen.
- **Knowledge Graph (`KnowledgeGraphView.tsx`):** Interactive SVG topology with sector dropdown, node filter search, pan/zoom controls, quadratic Bezier edges, and Entity Inspector. **Failure limitation (`VERIFIED`):** If `/api/vault/graph` fails (gateway offline), renders `role="alert"` error message with **no seed graph fallback**.
- **Jarvis Console (`JarvisView.tsx`):** Integrates `JarvisVisualizer` (centered Three.js sphere), `X3liusPlayer` (ObjectURL zero-storage audio player + FFT), `AudioExtractorPanel` (editable extracted style/vocal/flow/instrument specs + Vault Markdown save), Vault/OS Read acceptance lock (`readAccepted`), and Change Proposal `ACCEPT & APPLY` / `DECLINE` gates.
- **Mobile & Reduced Motion (`VERIFIED`):** Breakpoint `< 768px` switches rail to slide-out drawer (`w-dvw` panels, bottom sheet keyframes); `@media (prefers-reduced-motion: reduce)` disables idle orbital drift/pulse animations and lowers SVG transitions to `150ms`.

---

## 7. Tests, Build Config & Toolchain Compatibility (`VERIFIED`)

- **Config (`UI-xyp3rn`):**
  - Build: `next build` (Next `14.2.35`, React `18.3.1`, TypeScript `^5.6.3`, ESLint `next/core-web-vitals` `--max-warnings 0`).
  - Tests: `vitest.config.mts` (`vitest ^5.1.0`, `jsdom ^31.0.0`, `@testing-library/react ^16.3.0`; `VITEST_SKIP_INSTALL_CHECKS = '1'` prevents Vitest from probing unrelated Desktop parent configs).
  - Existing test files: **10 test suites** (`lib/__tests__/{audio-reverse-engineer,data,helpers,jarvis,layout,os3-adapter,voice-orb}.test.ts` and `components/__tests__/{jarvis,os3-integration,views}.test.tsx`).
- **Observed Test Gaps (`VERIFIED`):**
  - JSDOM lacks native Canvas 2D (`HTMLCanvasElement.getContext`), WebGL2, and `HTMLMediaElement.play/pause`, so `VoiceAssistantOrb` Bloom shader rendering and live HTML5 `<audio>` decoding are mocked/skipped in unit tests.
  - Hardcoded `http://127.0.0.1:8077` in `GATEWAY_BASE_URL` works locally on Windows, but opening the UI via `http://localhost:3000` relies on Chromium treating both as trustworthy/PNA-allowed (`Access-Control-Allow-Private-Network: true` is set in `core/gateway/server.ts`).
  - `apps/web/` uses `next 15.5.27`, `three ^0.186.1`, `typescript ~5.9.3` whereas `UI-xyp3rn` pins `next 14.2.35`, `three ^0.160.0`, `typescript ^5.6.3`.

---

## 8. Unresolved Questions

1. Should DAW Brain UI (Plugin Matrix, Audio Brain Live Telemetry, FL Studio Session Inspector & Control) become dedicated routes (`/daw` or `/studio`) in `UI-xyp3rn` alongside `AudioExtractorPanel`, or integrate as tabs under `/dashboards` and `/jarvis`?
2. Should `UI-xyp3rn` add Playwright WebGL / live-gateway E2E browser smoke tests (separate from JSDOM unit tests) once Chromium DevTools/Playwright binaries are configured cleanly for `UI-xyp3rn`?
3. Should `KnowledgeGraphView` (`/chart`) receive a deterministic local seed graph fallback built from `data/map.ts` `buildsOn` edges when Gateway is offline?
