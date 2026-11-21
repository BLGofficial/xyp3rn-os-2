# XYP3RN DAW Session Intelligence (Phase 12)

Vendor-independent DAW Session Intelligence subsystem built under `core/daw-brain/session-intelligence/` on top of the Phase 10 Universal DAW Brain Core, Phase 11 FL Studio 2025 Adapter, and Phase 06 Context Engine.

---

## 1. Architecture & Modules

| Module | Responsibility |
| :--- | :--- |
| `types.ts` | Defines `DawSessionAnalysisReport`, `DawSessionInventory`, `DawClassifiedTrack`, `DawRoutingGraph`, `DawNamingOrganizationReport`, `DawComplexityReport`, `DawConsistencyReport`, `DawSnapshotComparison`, `DawKnowledgeIntegrationReport`, `DawAnalysisConfidence`, `DawSessionFinding`, and `DawRecommendedAction`. |
| `routing-graph.ts` | Builds directed signal-flow graphs (`nodes`, `edges`, `signalFlowChains`, `masterSinkIds`, `orphanNodeIds`, `disconnectedSourceIds`, `cyclePaths`) and classifies track/mixer roles (`master`, `vocal`, `drums_percussion`, `bass_sub`, `melodic_synth`, `fx_return`, `submix_bus`, `reference`, `unclassified`) purely from observed metadata. |
| `snapshot-diff.ts` | Implements `compareDawSnapshots(before, after)` detecting transport/tempo changes, added/removed tracks, mixer fader/pan/mute/solo changes, routing diffs, plugin changes, and inspected parameter changes. |
| `session-analyzer.ts` | Computes inventory, naming score (`0..100`), complexity tier, consistency checks (`LIVE_VS_SAVED_DRIFT`, `STALE_OR_CACHED_TELEMETRY`, `DISCONNECTED_OR_ORPHAN_ROUTING`, `MUTED_ROUTED_BUS`, `EDITION_INCOMPATIBLE_PLUGIN`, `HEADROOM_OR_CLIP_RISK`, `DEGRADED_HOST_VERSION`), confidence scoring, explicit `limitations`, and `recommendedNextActions`. |
| `knowledge-bridge.ts` | Integrates ephemeral DAW telemetry cleanly via `Os3ContextEngine.retrieveDawContext()` against X3LIUS Music records, production knowledge, plugin documentation, strictly human-approved user preferences, and historical SQLite/Vault session records without conflating live state with canonical knowledge. |
| `session-intelligence.ts` | `DawSessionIntelligence` facade tracking consecutive snapshot state transitions and formatting Markdown reports (`formatSessionAnalysisMarkdown()`). |
| `core/daw-adapters/fl-studio-2025/flp-to-snapshot.ts` | Vendor adapter helper (`flpParsedToDawSession`, `inspectFlpAsDawSession`) allowing offline read-only `.flp` files to be analyzed through the universal engine while preserving `unknown`/`unavailable` boundaries on unparsed chunks. |

---

## 2. Anti-Fabrication Guarantees

1. **Zero Simulated Metrics for Inaccessible Domains:** Any domain marked `'unavailable'`, `'unsupported'`, or `'unknown'` in `DawStateSnapshot` renders as `null` counts inside `inventory.counts` and appears explicitly under `inventory.inaccessibleDomains` and `limitations`.
2. **Routing Honesty:** When `routing.status !== 'available'` (e.g., offline saved `.flp` inspection), `routingGraph.observabilityStatus` reports `'unavailable'` or `'partial'` rather than raising false disconnected-channel warnings.
3. **Preference Governance:** Unapproved or draft user preference notes are excluded before knowledge linking via Phase 06 `isVerifiedApprovedRecord()` checks.
4. **Freshness-Driven Confidence:** Stale or cached snapshots (`stale === true`), offline `.flp` saves (`freshness === 'saved'`), and missing domains automatically lower `confidence.level` and attach rationale strings.
