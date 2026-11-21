# XYP3RN DAW Brain — Universal Foundation (`core/daw-brain/`)

Phase 10 implementation of the DAW-independent Universal DAW Brain core, strictly free of FL Studio or REAPER vendor-specific dependencies.

## 1. Architecture & Core Modules

| File | Responsibility |
| :--- | :--- |
| `types.ts` | Universal Domain Model (`DawInstance`, `DawConnection`, `DawProject`, `DawSession`, `DawTempo`, `DawTimeSignature`, `DawTransport`, `DawTrack`, `DawChannel`, `DawBus`, `DawRoutingConnection`, `DawMixerChannel`, `DawPluginInstance`, `DawPluginParameter`, `DawAutomationLane`, `DawAudioClip`, `DawMidiClip`, `DawMarker`, `DawRegion`, `DawStateSnapshot`, `DawCommand`, `DawCommandResult`, `DawCapability`), `DawAvailability<T>`, 7 freshness states (`observed`, `cached`, `stale`, `proposed`, `applied`, `saved`, `unknown`), `DawObservationProvenance`, and `DawBrainError`. |
| `daw-adapter-sdk.ts` | Lifecycle contract `DawAdapter` (`discover`, `connect`, `disconnect`, `healthCheck`, `getCapabilities`, `observe`, `subscribe`, `validateCommand`, `execute`) plus `validateAdapterContract()`. |
| `daw-capability-registry.ts` | Enforces adapter capability support (`SUPPORTED` \| `TEMPLATE_SCOPED` \| `READ_ONLY` \| `UNSUPPORTED`), default read-only permission bounds (`observe`/`analyze`), SQLite `daw_session_leases` TTL leases, and target scope restrictions. |
| `daw-session-model.ts` | Isolates `observed`, `cached`, `stale`, `proposed`, `applied`, `saved`, and explicit `unknownFields`, computes live-vs-saved digest drift (`hasUnsavedLiveChanges`), enforces observation staleness windows, and persists session headers in SQLite `daw_sessions`. |
| `daw-version-manager.ts` | Evaluates host/API version bounds, rejecting below-minimum hosts (`incompatible`) and degrading untrusted newer hosts safely to `degraded_read_only`. |
| `daw-connection-manager.ts` | Manages adapter registration, host discovery, version handshakes, and connection state transitions (`disconnected` -> `connected_read_only` -> `leased_mutable` -> `degraded_cached` -> `closed`). |
| `daw-health-monitor.ts` | Polls `healthCheck()`, tracks RTT and failure counters, and degrades sessions cleanly to `degraded_cached` / `stale` after consecutive heartbeat failures. |
| `daw-state-observer.ts` | Performs non-mutating `observe()` polling and push `subscribe()` delta updates into `DawSessionModel`. |
| `daw-event-bus.ts` | Coalesces rapid `daw.session.observed` telemetry updates and persists security/command events to SQLite `runtime_events`. |
| `daw-command-gateway.ts` | Choke point enforcing capability/lease checks, target drift detection (`DAW_TARGET_DRIFT`), gain/parameter/tempo safety clamps (`DAW_SAFETY_VIOLATION`), human `pending_approvals` verification, single-shot execution with readback confirmation, immutable `daw_command_journal` receipts, and `beforeState` rollback. |
| `daw-core.ts` | Unified facade wiring all subsystems and implementing Phase 08 `DawBrainDelegate` for JARVIS. |
| `fake-adapter.ts` | Deterministic `FakeDawAdapter` (`isSimulated: true`) for automated conformance, latency, drift, failure, and rollback testing. |

---

## 2. Freshness & Explicit Unavailability Guarantees

- Every `DawStateSnapshot` and `DawHealthReport` carries `DawObservationProvenance` (`observedAt`, `dawId`, `adapterId`, `hostVersion`, `sourceEvidence`, `freshness`).
- Unavailable or unexposed DAW data uses `DawAvailability<T>` (`{ status: 'unavailable' | 'unsupported' | 'unknown', reason }`) instead of faking empty/zero placeholders; `DawSession.unknownFields` surfaces these gaps explicitly.
- Cached/aged snapshots degrade explicitly to `stale: true` and `observed: null`, ensuring stale memory never masquerades as live observation or saved disk truth.
