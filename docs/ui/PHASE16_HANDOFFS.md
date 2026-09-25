# Phase 16 execution handoffs

## 16B — Mercury shell
- Built: semantic CSS tokens, five-region responsive shell and empty/authentication states.
- Key decisions: canonical domain colors, gold hub, SVG geometry; zero screenshot-as-background usage.
- Deviations from spec: current Next.js App Router, custom semantic CSS rather than adding a styling dependency.
- Open flags: browser screenshot comparison pending final integration.
- Next phase needs: source-backed canonical projection.

## 16C — Canonical data contract
- Built: GraphNode, GraphEdge, SystemStatusSnapshot, LiveActivityEvent; shared projection for all views and inspectors.
- Key decisions: sourceRef on every entity, query/timestamp on metrics, role-filtered governance, bounded SQL results.
- Deviations from spec: local PostgreSQL without Supabase hosted realtime.
- Open flags: provider connectivity/uptime and geographic analytics are unmeasured.
- Next phase needs: deterministic graph geometry and source integrity tests.

## 16D — Radial graph
- Built: gold central hub, six canonical domain sectors, orbit guides, real satellites and overflow expansion.
- Key decisions: fixed orbit positions; bounded satellites; decorative guides are not data edges.
- Deviations from spec: actual source colors and labels take priority over illustrative image content.
- Open flags: final screenshots and density tests pending.
- Next phase needs: working system-map controls.

## 16E — Left rail
- Built: graph/list/agent/workflow/knowledge/resource/event projections, canonical filters, observed agent states.
- Key decisions: no Training state; latest run status is explicitly different from heartbeat availability.
- Deviations from spec: status terminology follows runtime pending/success/error semantics.
- Open flags: none specific to this rail.
- Next phase needs: metric and activity rendering.

## 16F — Right rail
- Built: sourced metrics, bounded timestamped activity, geographic map with unconfigured state.
- Key decisions: unknown uptime/health stay unavailable; configured adapters are not claimed healthy connections.
- Deviations from spec: sparse activity remains sparse; no illustrative 106-country claim.
- Open flags: integrations must supply missing measurements later.
- Next phase needs: top navigation and identity.

## 16G — Top bar
- Built: eight views, source-backed search, real package version and authenticated role badge.
- Key decisions: role and permissions come from database tables; no hardcoded SUPERADMIN.
- Deviations from spec: current package version is 0.0.0, not the illustration's v4.2.
- Open flags: users require operator-issued session tokens.
- Next phase needs: infrastructure inspection.

## 16H — Infrastructure rail
- Built: configured providers, actual pipelines, security and local infrastructure inspection; explicit deployment-unconfigured state.
- Key decisions: only provider adapters already implemented are registered.
- Deviations from spec: no AgentRouter integration exists; no invented regions.
- Open flags: external provider probes not run.
- Next phase needs: complete inspector and URL state.

## 16I — Interaction
- Built: select/focus/filter/search, list expansion, inspector, keyboard graph navigation and URL view/domain/node state.
- Key decisions: server projection enforces field visibility; unknown/restricted deep links show an empty state.
- Deviations from spec: source contracts remain inspectable without exposing runtime prompts or raw inputs.
- Open flags: final browser interaction proof pending.
- Next phase needs: telemetry update proof.

## 16J — Telemetry
- Built: bounded 10-second polling paused for hidden pages; existing low-risk health-check execution; allowlisted events.
- Key decisions: preserve unchanged node objects so event-only updates do not rebuild graph geometry.
- Deviations from spec: no realtime transport already exists, so polling is used.
- Open flags: deterministic UNKNOWN until full dependency health can be measured.
- Next phase needs: responsive, accessibility and performance validation.

## 16K — Hardening
- Built: desktop rails, narrow-screen drawers, keyboard focus, status text, reduced motion, bounded graph density.
- Key decisions: retain graph canvas width and navigation on mobile.
- Deviations from spec: visual/data limitations must be recorded at final gate.
- Open flags: measured results belong to PHASE16_ACCEPTANCE.md; not yet claimed.
- Next phase needs: audit before final fixes, browser and production-build evidence.
