# XYP3RN Plugin Brain (Phase 13)

Independent plugin knowledge, catalog ingestion, compatibility, parameter interpretation, and signal-chain reasoning subsystem (`core/daw-brain/plugin-brain/`).

---

## 1. Architecture & Modules

| Module | Responsibility |
| :--- | :--- |
| `types.ts` | Defines `PluginProfile` (manufacturer, product name, version, format, category, type, processing roles, I/O, parameter specs/ranges/units, `DawAvailability` presets, compatibility, requirements, limitations, doc sources, installation state), `PluginChainGraph`, `PluginChainAnalysisReport`, `PluginComparisonResult`, `PluginRecommendation`. |
| `plugin-analyzer.ts` | Classifies plugin identity (`classifyPluginIdentity`), maps live `DawPluginParameter` telemetry into semantic DSP keys/units/ranges (`interpretParameter`), evaluates host & edition compatibility (`evaluatePluginCompatibility`), and compares processors (`comparePlugins`). |
| `catalog-ingestion.ts` | `PluginCatalogRegistry` merging strictly verified sources (`ingestDawExposedPlugins`, `ingestLocalHostInventory`, `ingestUserCatalog`, `ingestVaultPluginDocs`) without ever conflating Vault documentation with host installation. |
| `chain-intelligence.ts` | Extracts `actual_daw_chain` graphs from live DAW snapshots (`extractActualChainsFromSnapshot`) and evaluates signal flow + redundancy (`analyzePluginChain`). |
| `recommendation-engine.ts` | Role-based selection (`recommendPluginsForRole`), typed ordered chain recipes (`buildSuggestedChainRecipe`) across all 9 production workflows (`vocal_chain`, `instrument_chain`, `drum_processing`, `bass_processing`, `mix_bus`, `master_bus`, `creative_fx`, `parallel_processing`, `sidechain_workflow`), and Vault draft formatting (`formatPluginProfileVaultMarkdown`). |
| `plugin-brain.ts` | Unified `PluginBrain` facade and read-only parameter patch proposal helper (`proposeBoundedParameterPatch`). |

---

## 2. Core Invariants

1. **Verified Discovery Only:** Reading an approved Vault plugin note in `10_DAW_BRAIN/PLUGINS/` sets `installedOnHost: 'not_detected_on_host'` until confirmed by local workstation scan or live DAW telemetry.
2. **Actual vs Suggested Chain Separation:** Live observed mixer chains are tagged `sourceKind: 'actual_daw_chain'`; generated recommendations are tagged `sourceKind: 'suggested_recipe'` and omit unavailable slots into `missingRoles`.
3. **Parameter Safety:** Plugin Brain executes **zero** direct parameter writes; future writes must route through `DawCommandGateway.prepare()` + human approval + active lease.
