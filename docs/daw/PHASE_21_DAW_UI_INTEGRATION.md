# Phase 21 — XYP3RN DAW Brain UI Integration & Preservation Report

## 1. Constellation / Galaxy Integration Without a Second App

DAW Brain is integrated directly into the existing **UI-xyp3rn** (`C:\Users\blago\Desktop\building-agentic-systems\XYP3RNOS\UI-xyp3rn`) Next.js App Router Constellation application—no separate app, design system, or duplicated navigation chrome was introduced.

### Design & Layout Preservation Checklist
- **Shell & Top Pill Navigation:** Preserved `ChromeShell` (collapsing desktop sector rail, starfield void backdrop, responsive mobile bottom dock) and extended `ui.nav.items` in `UI-xyp3rn/data/map.ts` with `/daw` (`MAP`, `DASHBOARDS`, `CHART`, `DAW`) plus a mobile footer `/daw` shortcut icon and a direct entry link inside `DashboardsView` (`RECORDS` tab).
- **Seed & Constellation Layout Tests Unbroken:** Existing `departments` seed structure (6 sectors, 46 folders, 137 jobs) in `data/map.ts` was left untouched (`lib/__tests__/data.test.ts` and `lib/__tests__/layout.test.ts` remain green).
- **Theme Tokens & Surface Classes:** All 12 DAW Brain panels reuse Constellation utility classes (`glass-card`, `frost`, `outlined`, `chip`, `micro`, Tailwind semantic colors `bg-bg`, `text-ink`, `text-ink-dim`, `border-hairline`).

## 2. Real OS3 Gateway API Endpoints (`core/gateway/`)

Added `DawGatewayController` (`core/gateway/daw-gateway.ts`) and wired it into `core/gateway/server.ts` alongside existing Vault/Jarvis/Records routes:

| Method & Route | Purpose & Safety Model |
| --- | --- |
| `GET /api/daw/overview` | Aggregates real host probes (FL Studio 2025 & Cockos REAPER), connected/disconnected state, capability matrix (`available` vs `unsupported`), active leases/operations, Session Intelligence, Plugin Brain, Audio Brain, 12 DAW agents, canonical workflows, pending approvals, receipts, evaluation, and DAW events. |
| `POST /api/daw/connections/probe` | Re-runs local FL Studio / REAPER installation, running process, project, and plugin discovery without mutating projects. |
| `POST /api/daw/connections/connect` | Opens a read-only (`observe`) session on a reachable adapter instance. |
| `POST /api/daw/sessions/refresh` | Polls live observation; returns `404` when disconnected rather than fabricating a fake session. |
| `POST /api/daw/sessions/lease` | Grants scoped `prepare` lease strictly for human operators (blocks agent identities with `403`). |
| `POST /api/daw/agents/run` | Dispatches `DawAgentTeam.runTask()` in `analyze`, `recommend`, or `prepare` mode (blocks direct `execute_with_approval` with `403`). |
| `POST /api/daw/workflows/run` | Runs canonical `DAW_PRODUCTION_WORKFLOWS` analysis steps against a connected session. |
| `POST /api/daw/commands/propose` | Runs dry-run & `DawCommandGateway.prepare()`, queuing pending approval in SQLite (requires active `prepare` lease; returns `403` otherwise). |
| `POST /api/daw/commands/decide` | Enforces F35 D2 no-self-approval (`403 SELF_APPROVAL_FORBIDDEN`) and explicit `confirmDangerous` for high-risk/potentially-destructive actions before scoped lease execution. |
| `POST /api/daw/commands/rollback` | Executes exact-before-state rollback strictly when `receipt.rollbackSupported === true` (returns `409` otherwise). |
| `POST /api/daw/evaluate` | Runs the real Phase 18 `DawEvaluationEngine` suite tagged `verified-fixtures-and-adapters`. |

## 3. UI Action Safety & Honest Data Guarantees

- **4-Tier Visual & Semantic Separation:**
  1. `OBSERVATION · READ-ONLY` (Overview, Connections, Active Sessions, Session Explorer, Track & Routing Inspector, Plugin Inventory)
  2. `RECOMMENDATION · ADVISORY ONLY` (Audio Brain advisory fixes, Plugin Brain chain suggestions, explicitly labeled `PROBABILISTIC MIR ESTIMATES`)
  3. `PROPOSED ACTION · DRY-RUN` (Prepared commands with before/after diff and project identity/freshness checks)
  4. `APPROVED EXECUTION · MUTATING` (Execution receipts, rollback buttons, high-risk confirmation checkboxes & crimson warning framing for `potentially_destructive` / `high` risk actions)
- **Zero Fake Live Telemetry:** When the OS3 Gateway or DAW hosts are offline, `DawBrainWorkspace` renders `DISCONNECTED` / `GATEWAY OFFLINE` with a `RETRY CONNECTION` CTA. Demonstration scenarios (`connected_fl_studio`, `stale_drift`) live exclusively inside `lib/daw-demo-fixtures.ts` and are only shown when explicitly toggled, under a persistent amber `DEMONSTRATION FIXTURE — NOT LIVE DAW DATA` warning banner.
