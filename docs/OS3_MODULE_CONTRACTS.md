# XYP3RN OS 3.0 + DAW Brain — Full Module Contracts Specification (Phase 02 Freeze)

**Status:** Phase 02 Architecture Freeze  
**Scope:** Formal **10-field contract** (`Responsibility`, `Inputs`, `Outputs`, `Interfaces`, `Dependencies`, `Permissions`, `Events`, `Failure modes`, `Persistence`, `Tests`) for every **OS3 subsystem (17 modules)** and every **DAW Brain subsystem (13 modules)** — **30 contracts total**.

---

## PART A — XYP3RN OS 3.0 SUBSYSTEM CONTRACTS (1–17)

### A1. Runtime (`core/runtime/`)
- **Responsibility:** Process bootstrap, `.env.local` discovery, Windows-safe service startup/shutdown, stale SQLite lock/job recovery, configuration management.
- **Inputs:** `NodeJS.ProcessEnv`, `RuntimeConfigInput` (`vaultRoot`, `sqlitePath`, `gatewayPort`, `logLevel`).
- **Outputs:** Initialized `Os3RuntimeContext` (`db`, `vault`, `eventBus`, `logger`) and clean shutdown telemetry.
- **Interfaces:** `startOs3Runtime()`, `stopOs3Runtime()`, `recoverStaleState()`.
- **Dependencies:** Node `process`, `fs`, `path`, `core/sqlite`, `core/vault-engine`, `core/runtime/event-bus`, `core/runtime/logger`.
- **Permissions:** System bootstrapper; reads `process.env` secrets strictly in memory; never exposes raw env to UI/agents.
- **Events:** `runtime.started`, `runtime.recovery.completed`, `runtime.stopping`, `runtime.stopped`.
- **Failure modes:** Missing `OBSIDIAN_VAULT_PATH` -> `VaultNotFoundError`; locked SQLite DB -> bounded retry then structured boot failure; port conflict on `:8077` -> `EADDRINUSE` abort.
- **Persistence:** Delegates lock/job state transitions to `core/sqlite/`.
- **Tests:** Restart crash-recovery suite (`recoverStaleLocks`, `recoverStaleRunningJobs`), missing-Vault degradation test, graceful HTTP close test (`tests/os3-phase5-runtime/`).

### A2. Vault Engine (`core/vault-engine/`)
- **Responsibility:** Sole authorized reader/writer/scanner/linker over the external Obsidian Vault (`path-guard`, No-Overwrite Guard, SHA-256 CAS, `.vault-revisions/`, atomic file writes).
- **Inputs:** Vault-relative POSIX paths, Markdown/YAML payloads, `expectedSha256`, `WriteMode` (`no-overwrite` | `compare-and-swap`), scan options.
- **Outputs:** `VaultNoteDocument`, `WriteNoteResult`, `VaultScanSummary`, link resolution arrays, `VaultVersionEntry[]`.
- **Interfaces:** `readNote()`, `writeNote()`, `appendNote()`, `linkNotes()`, `restoreRevision()`, `scanVault()`, `search()`, `resolveLinks()`, `executeAtomicBatch()`.
- **Dependencies:** `core/sqlite`, `knowledge/obsidian/parser.ts`, `yaml`, Node `fs`/`crypto`/`path`.
- **Permissions:** Refuses writes to `CANONICAL_PATH_PREFIXES` (`status: canonical`) outside `PromotionGate`; rejects path escapes/junctions/executables.
- **Events:** `vault.write`, `vault.append`, `vault.write.denied`, `vault.write.conflict`, `vault.external_edit`, `vault.scan.completed`.
- **Failure modes:** `VaultPathSecurityError`, `VaultConflictError` (`EXTERNAL_OBSIDIAN_EDIT`), `VaultPermissionError`, `EBUSY` (mitigated by exponential retry backoff), transactional batch rollback.
- **Persistence:** Canonical `.md`/`.yaml` files on disk, `.vault-revisions/<sha>` backups, updates derived `index_state` in SQLite.
- **Tests:** 13 core operations + path traversal, junction escape, No-Overwrite, CAS conflict, batch atomic rollback, external Obsidian edit preservation (`tests/os3-phase4-vault-engine/`).

### A3. Knowledge Engine (`knowledge/` + Structural & Semantic Indexing)
- **Responsibility:** Parses Obsidian frontmatter & `[[wikilinks]]`, validates entity schemas (`xyp3rn.knowledge/v3`), manages deterministic ingestion/normalizers (`mix-rubric`, `vocal-dna`, `module-manifest`), and maintains disposable FTS/vector caches.
- **Inputs:** Raw Markdown/YAML documents, PDFs (`unpdf`), first-party manifests, incremental file scan changes.
- **Outputs:** `NormalizedDocument`, parsed `ExtractedWikilink[]`, structural index rows, 384-dim `gte-small` embeddings, knowledge graph topology (`nodes`, `edges`).
- **Interfaces:** `parseObsidianNote()`, `validateEntityContent()`, `scanStructuralIndex()`, `rebuildSemanticIndex()`, `normalizeDocument()`.
- **Dependencies:** `yaml`, `@huggingface/transformers`, `unpdf`, `core/vault-engine`, `core/sqlite`.
- **Permissions:** Read-only Vault scanning + cache writing in SQLite/local cache; cannot commit canonical knowledge without `PromotionGate`.
- **Events:** `knowledge.indexed`, `knowledge.validation_failed`, `knowledge.embeddings_updated`.
- **Failure modes:** Broken YAML frontmatter (captured safely in `frontmatterError` without crashing indexer), missing `.local-models/` -> falls back gracefully to lexical/structural retrieval.
- **Persistence:** Derived `index_state` in SQLite + local `.vault/<sha256>` binary store + optional local embedding vector cache.
- **Tests:** Parser edge-case tests, incremental vs full scan reconciliation, corrupt-index recovery (`tests/os3-phase6-context/`).

### A4. Context Engine (`core/context-engine/os3-context-engine.ts`)
- **Responsibility:** Analyzes queries, searches `knowledge`, `vault`, `agents`, and `daw-knowledge` corpora via hybrid structural + link + semantic scoring, deduplicates, caches per Vault generation, and bounds output to strict token budgets.
- **Inputs:** Query string, target corpus/module scopes, token budget (`maxTokens`), Vault generation ID.
- **Outputs:** `Os3ContextPackage` (`items[]` with provenance path, SHA-256, score, snippet, matched claims).
- **Interfaces:** `analyzeContextQuery()`, `assembleContext()`, `retrieveClaims()`.
- **Dependencies:** `Knowledge Engine`, `core/sqlite` (`index_state`), generation LRU cache.
- **Permissions:** Strictly read-only (`context.read`). Zero file mutations.
- **Events:** `context.assembled`, `context.cache_hit`, `context.cache_invalidated`.
- **Failure modes:** Empty/no-match query -> returns bounded empty bundle cleanly; stale cache -> automatically invalidated whenever `index_meta` generation increments.
- **Persistence:** In-memory generation-keyed LRU cache reading SQLite `index_state` and `VaultEngine`.
- **Tests:** Hybrid ranking determinism, token budget clipping, multi-hop link expansion, cache invalidation (`tests/os3-phase6-context/`).

### A5. Agent Registry (`core/agent-registry/os3-agent-registry.ts`)
- **Responsibility:** Discovers, validates (`xyp3rn.agent/v3`), caches, and atomically hot-reloads Markdown/YAML agent files from `04_AGENTS/` (plus DAW agents when approved).
- **Inputs:** Vault `04_AGENTS/` Markdown directory, reload trigger signal.
- **Outputs:** Validated `Os3AgentDefinition[]`, lookup map, structured validation errors per malformed file.
- **Interfaces:** `loadAgents()`, `get(name)`, `list()`, `validateAll()`, `reloadAtomic()`.
- **Dependencies:** `VaultEngine`, `knowledge/obsidian/parser`, `core/contracts/taxonomy.ts`.
- **Permissions:** Read-only over agent definition files; rejects privilege escalation (`declared tool` outside `CLASS_CAPABILITIES`), wrong schema versions, filename mismatch, or unknown fields.
- **Events:** `agents.loaded`, `agents.reload_succeeded`, `agents.reload_rejected`.
- **Failure modes:** Broken agent YAML on hot reload -> rejects reload cleanly while **retaining last valid atomic snapshot** (`tests/os3-phase7-agents-tools`).
- **Persistence:** Canonical definitions stored as Markdown in Obsidian `04_AGENTS/`.
- **Tests:** 52-agent validation test, invalid YAML/capability violation rejection test, atomic hot reload fallback test.

### A6. Tool Registry (`core/tool-registry/os3-tool-registry.ts`)
- **Responsibility:** Registers typed executable tools (`39+` OS3 + new Phase 02 DAW tools), validates JSON input/output schemas, enforces deny-by-default class authorization, and executes with timeouts and retries.
- **Inputs:** `agentClass`, `toolName`, declared `agent.tools[]`, tool JSON args, `AbortSignal`.
- **Outputs:** Authorized tool JSON result or structured authorization/validation denial.
- **Interfaces:** `defineTool()`, `authorize(agentClass, toolName)`, `invokeTool(ctx, toolName, args)`.
- **Dependencies:** `core/tool-registry/capabilities.ts`, `core/llm/json-schema.ts`, `Audit Engine`.
- **Permissions:** Enforces `CLASS_CAPABILITIES` + agent frontmatter whitelist; forbids `canonical.write`, `approval.decide`, `audit.write` for all agent classes.
- **Events:** `tool.authorized`, `tool.denied`, `tool.executed`, `tool.timed_out`.
- **Failure modes:** Undeclared tool request -> `UNAUTHORIZED_TOOL`; timeout -> `AbortError`; bad arg shape -> schema rejection before handler invocation.
- **Persistence:** Zero direct storage; delegates run/tool execution trace to `Runtime Store` + `Audit Engine`.
- **Tests:** Deny-by-default escalation adversarial suite, schema enforcement, timeout & bounded retry verification (`tests/os3-phase7-agents-tools`, `phase12`).

### A7. Workflow Engine (`core/workflow-engine/os3-workflow-engine.ts`)
- **Responsibility:** Compiles YAML DAG definitions (`*.workflow.yaml`) from `05_WORKFLOWS/DEFINITIONS/`, checks agent existence, rejects cycles and prototype pollution keys, resolves `$input` / `$steps.<id>.output` bindings, evaluates conditionals, and coordinates step runs.
- **Inputs:** Workflow name/YAML, JSON inputs, step execution handler.
- **Outputs:** `Os3WorkflowExecutionResult` (`jobId`, `status`, `output`, `failedStep`, `skippedSteps[]`, per-step run links).
- **Interfaces:** `compileWorkflow()`, `listWorkflows()`, `runWorkflow()`.
- **Dependencies:** `yaml`, `Agent Registry`, `Task Orchestrator`, `core/memory`, `Runtime Store`.
- **Permissions:** Inherits step agent capabilities; validates required inputs strictly before step 1 executes.
- **Events:** `workflow.compiled`, `workflow.started`, `workflow.step.completed`, `workflow.failed`, `workflow.completed`.
- **Failure modes:** Cyclic DAG, missing required input, prototype pollution key (`__proto__`), step timeout, mid-DAG failure -> marks downstream steps `skippedSteps` cleanly with no partial commit confusion.
- **Persistence:** Workflow specs canonical in Obsidian `05_WORKFLOWS/`; executions persisted with `spec_sha256` in SQLite `jobs`.
- **Tests:** 7-workflow compilation test, cycle/unknown agent rejection, failure trace + conditional routing test (`tests/os3-phase8-orchestration`).

### A8. Task Orchestrator (`core/orchestrator/os3-orchestrator.ts`)
- **Responsibility:** Routes direct intents, acquires TTL concurrency locks (`locks`), invokes single agents via `AgentRegistry` + `ToolRegistry` + `ModelGateway`, enforces max step bounds (`32`), handles cancellation, and seals `agent_runs` rows.
- **Inputs:** Directive / agent name / input JSON / workflow run binding / `AbortSignal`.
- **Outputs:** `Os3SingleRunResult` (`runId`, `status`, `output`, `tokensUsed`, `latencyMs`, `errorDetail`).
- **Interfaces:** `dispatchAgent()`, `acquireLock()`, `releaseLock()`, `cancelJob()`.
- **Dependencies:** `Agent Registry`, `Tool Registry`, `Model Gateway`, `Context Engine`, `Runtime Store`, `Event Bus`.
- **Permissions:** Strictly propagates caller/agent class identity (`cannot elevate to admin/operator`).
- **Events:** `agent.run.started`, `agent.run.completed`, `agent.run.failed`, `lock.acquired`, `lock.expired`.
- **Failure modes:** Lock contention (`RESOURCE_LOCKED`), step error (recorded cleanly on `agent_runs` without crashing orchestrator), runaway loop (halted at `MAX_STEPS = 32`).
- **Persistence:** SQLite `agent_runs`, `jobs`, `locks`.
- **Tests:** Single-agent dispatch invariants, bounded execution cap, concurrent lock isolation, error recording (`tests/os3-phase8-orchestration`).

### A9. JARVIS Core (`core/gateway/os3-jarvis-core.ts`, `jarvis-runtime.ts`, `jarvis-inspector.ts`)
- **Responsibility:** Single unified operator assistant front door routing commands, Whole-OS & Vault search/inspection (`readAccepted`), DAW commands (`via DAW Core`), and non-mutating change proposal staging (`askBeforeChange`).
- **Inputs:** `prompt`, `engine`, `activeSector`, `selectedJobId`, `readAccepted`, `askBeforeChange`.
- **Outputs:** `JarvisResult` / `JarvisExchange` (`reply`, `citations[]`, `proposal`, `action`), status.
- **Interfaces:** `classifyRequest()`, `executeDirective()`, `searchWholeVaultAndOs()`, `inspectSourceFile()`, `decideChangeProposal()`.
- **Dependencies:** `Agent Registry`, `Workflow Engine`, `Task Orchestrator`, `Context Engine`, `Vault Engine`, `DAW Core`, `Promotion Gate`.
- **Permissions:** Read/search across Whole OS + Vault strictly gated by `readAccepted`; mutations gated by `askBeforeChange` -> `pending_approvals`.
- **Events:** `jarvis.command.received`, `jarvis.inspection.performed`, `jarvis.proposal.created`, `jarvis.proposal.decided`.
- **Failure modes:** Refusal when `readAccepted: false`; safe rollback/no-op when proposal rejected; Model provider failure falls back to deterministic local command handlers.
- **Persistence:** Operator sessions stored cleanly in SQLite `sessions`; proposals persisted in `pending_approvals`.
- **Tests:** Routing/context/proposal/whole-OS read lock E2E suite (`jarvis-inspector-and-acceptance.test.ts`, `gateway.test.ts`).

### A10. Research Intelligence (`research-intelligence/os3-research-engine.ts`)
- **Responsibility:** Coordinates the 20 specialist research personas over operator-approved sources, validates verbatim evidence quotes against source text, tracks multi-source confidence caps, flags contradictions without overwriting history, and scores A/B experiments.
- **Inputs:** Research brief, approved source URLs/texts, evidence claims, experiment configs.
- **Outputs:** Canonical-candidate research briefs, evidence notes, findings, contradiction reports in `03_RESEARCH_INTELLIGENCE/`.
- **Interfaces:** `createProject()`, `ingestSource()`, `recordEvidence()`, `synthesizeFinding()`, `detectContradictions()`, `scoreExperiment()`.
- **Dependencies:** `VaultEngine`, `Task Orchestrator`, `PromotionGate`, `Runtime Store`.
- **Permissions:** Allowed `web.read`, `research.write`, `candidate.propose`; blocked from self-approving findings to `02_KNOWLEDGE_LAYER/`.
- **Events:** `research.source.verified`, `research.evidence.recorded`, `research.contradiction.flagged`, `research.candidate.proposed`.
- **Failure modes:** Non-verbatim quote -> `VERBATIM_CHECK_FAILED`; open contradiction blocks canonical promotion.
- **Persistence:** Vault Markdown notes in `03_RESEARCH_INTELLIGENCE/` & `04_RESEARCH_MATERIAL/` + candidate queue in SQLite `pending_approvals`.
- **Tests:** Full Project->Brief chain & contradiction block tests (`tests/os3-phase9-research`).

### A11. Records (+ Transitional Parity Layer) (`records/os3-records-engine.ts` + legacy `records/ops/`)
- **Responsibility:** Owns all 13 X3LIUS music & label domains (songwriting, lyrics, vocal DNA, composition, arrangement, genre/style, Suno packages, production blueprints, mix/master checks, evaluation, catalog UPC/ISRC, rights splits, release calendar) plus `09_X3LIUS_MUSIC/AUDIO_EXTRACTED_PROMPTS/`. Preserves legacy SQL parity hooks until full CLI parity is proven.
- **Inputs:** Creative briefs, lyrics, catalog UPC/ISRC codes, split percentage sets, release state moves, audio extracted prompt specs.
- **Outputs:** Versioned X3LIUS Vault notes, mix evaluation reports, release readiness verdicts, `/api/records` dashboard summaries.
- **Interfaces:** `registerSong()`, `commitLyricVersion()` (homoglyph checked), `assignIsrc()` / `setUpc()`, `proposeRightsSplits()`, `transitionRelease()`, `saveExtractedAudioPrompts()`.
- **Dependencies:** `VaultEngine`, `Runtime Store`, `script-check.ts`, `checkRights()`, `Audio Brain` (`mix-rubric.yaml`).
- **Permissions:** Requires human approval (`apply-split`, lyric approval) for rights split writes & Suno submission gate; GS1 mod-10 & ISO 3901 ISRC write-once validation enforced programmatically.
- **Events:** `records.lyric.committed`, `records.split.proposed`, `records.split.applied`, `records.release.transitioned`, `records.audio_prompt.saved`.
- **Failure modes:** Mixed Latin/Cyrillic homoglyphs -> rejected (`F22`); split sum != 100.000% or unassigned payee on release -> blocked (`F31`); ISRC mutation attempt -> write-once violation rejected.
- **Persistence:** Vault `05_XYP3RN_RECORDS/` & `09_X3LIUS_MUSIC/` Markdown notes; transitional legacy Postgres scripts preserved read-only for parity rollback.
- **Tests:** Parity reconciliation tests against OS2 exports + GS1/ISRC/homoglyph/split adversarial checks (`tests/os3-phase10-records`, `audio-reverse-engineer.test.ts`).

### A12. Promotion Gate (`core/vault-engine/promotion-gate.ts`)
- **Responsibility:** Exclusive write path into canonical Vault sectors (`02_KNOWLEDGE_LAYER/`, `01_CORE/00_Identity/`, `01_CORE/01_System_Prompts/`, `06_GOVERNANCE/00_Policies/`, `canonical/`). Validates evidence, provenance, confidence thresholds, blocks agent self-approval, marks notes immutable (`0444` when requested), and records audit provenance.
- **Inputs:** `PromoteToCanonicalRequest` (`approvalId`, `targetVaultPath`, `title`, `body`, `provenance`, `evidenceIds`, `confidence`).
- **Outputs:** Promoted canonical `WriteNoteResult` (incremented version + `source_sha256` + previous link).
- **Interfaces:** `promote(req)`, `VaultEngine.promoteToCanonical()`.
- **Dependencies:** `VaultEngine`, `Runtime Store` (`pending_approvals`), `Audit Engine`.
- **Permissions:** Reserved exclusively for human-approved gate invocation (`AGENT_OR_SYSTEM_ACTOR_RE` blocked as approver).
- **Events:** `promotion.approved`, `promotion.committed`, `promotion.denied`.
- **Failure modes:** Missing/pending/rejected approval, agent self-approval, missing provenance/evidence, confidence below floor -> throws `VaultPermissionError` / `VaultValidationError` with denied audit record.
- **Persistence:** Canonical Obsidian notes + `.vault-revisions/` + sealed `pending_approvals` row.
- **Tests:** 9-step adversarial promotion bypass suite (`tests/os3-phase12-security`).

### A13. Runtime Store (`core/sqlite/`)
- **Responsibility:** WAL-mode embedded SQLite persistence (`node:sqlite`) strictly scoped to operational runtime telemetry, queue approvals, distributed leases/locks, derived index cache, and DAW runtime session/command journals.
- **Inputs:** SQLite queries/transactions from `Runtime`, `VaultEngine`, `Orchestrator`, `Gateway`, `DAW Core`.
- **Outputs:** Strongly typed runtime records, integrity check reports (`checkIntegrity`), binary snapshot backups (`backupDatabase`).
- **Interfaces:** `SqliteRuntimeDb`, `applySqliteMigrations()`, `createRuntimeRepositories()`.
- **Dependencies:** Node `node:sqlite`, `fs`, `path`, `core/contracts/taxonomy.ts`.
- **Permissions:** Server runtime only; triggers forbid `UPDATE`/`DELETE` on `runtime_events`, `daw_command_journal`, completed `agent_runs`/`jobs`, and decided `pending_approvals`. Blocks `FORBIDDEN_CANONICAL_SQLITE_TABLES`.
- **Events:** Emits migration & backup health telemetry to `Runtime` logger.
- **Failure modes:** SQLite unavailable/locked -> gateway `/api/health` degrades cleanly (`sqliteOpen: false`) while Vault read/history continues; corrupt index pruned by `scanVault({ full: true })`.
- **Persistence:** `.local-db/xyp3rn-os3.sqlite` (+ WAL/SHM files) + timestamped snapshot backups.
- **Tests:** Migration test, immutable trigger enforcement test, forbidden canonical table check, backup integrity verification (`tests/os3-phase1`, `phase5`, `phase13`).

### A14. Event Bus (`core/runtime/event-bus.ts` — Phase 02 Specification)
- **Responsibility:** Unified internal synchronous/async typed Pub-Sub dispatcher routing system, Vault, Approval, Orchestrator, and DAW Brain domain events consistently to durable Audit persistence and UI push streams (`/api/events/stream`).
- **Inputs:** Typed `Os3DomainEvent` envelopes (`eventType`, `domain`, `actor`, `correlationId`, `payload`, `timestamp`).
- **Outputs:** Fan-out delivery to registered local listeners + SSE clients (`Gateway`) + durable append to `Audit Engine`.
- **Interfaces:** `publish(event)`, `subscribe(pattern, listener)`, `unsubscribe(id)`.
- **Dependencies:** `core/contracts/`, `Audit Engine`.
- **Permissions:** Internal runtime bus; secrets stripped via `redactSecrets()` prior to broadcast.
- **Events:** All OS3 + DAW event namespaces (`vault.*`, `agent.*`, `workflow.*`, `approval.*`, `daw.*`, `audio.*`).
- **Failure modes:** Slow UI subscriber -> isolated bounded queue drop (never blocks critical audio/Vault mutation paths); uncaught subscriber exception -> caught and logged without crashing emitter.
- **Persistence:** Non-durable transport backed by durable mirroring to SQLite `runtime_events`.
- **Tests:** Deterministic pub/sub delivery order, slow-listener backpressure isolation, secret redaction check.

### A15. Audit Engine (`core/vault-engine/audit.ts` + `core/runtime/logger.ts` + SQLite triggers)
- **Responsibility:** Records immutable security/governance/execution audit trails across Vault operations, authorization denials, human approval decisions, and DAW command executions, enforcing zero secret leakage.
- **Inputs:** Structured audit events (`actor`, `operation`, `targetPath`, `result`, `reason`, context map).
- **Outputs:** Appended `runtime_events` row + redacted `StructuredLogEntry` ring buffer (and optional Vault Audit Markdown summaries under `06_GOVERNANCE/05_Audit_Logs/`).
- **Interfaces:** `record(event)`, `redactSecrets(text)`, `verifyAuditContinuity()`.
- **Dependencies:** `Runtime Store`, `core/runtime/logger.ts`.
- **Permissions:** `audit.write` (`[]` — inaccessible directly to agents; invoked strictly by trusted engine hooks & SQLite triggers).
- **Events:** `audit.recorded`, `audit.violation_flagged`.
- **Failure modes:** Trigger tampering attempt -> SQLite raises `ABORT`; log secret regex detects API token -> replaced with `[REDACTED_SECRET]`.
- **Persistence:** Immutable SQLite `runtime_events` + `daw_command_journal` + Markdown audit exports.
- **Tests:** Log redaction regex tests, immutable SQLite trigger enforcement, unauthorized write audit proof (`tests/os3-phase12-security`).

### A16. API (`core/gateway/server.ts`, `127.0.0.1:8077`)
- **Responsibility:** Loopback-bound HTTP/JSON/SSE transport serving `UI-xyp3rn` and local OS3 scripts, enforcing Host/Origin allowlists, Bearer token auth (`XYP_GATEWAY_TOKEN`), request size limits (256 KB JSON), and clean HTTP error codes.
- **Inputs:** HTTP requests over `127.0.0.1:8077` / `localhost:8077`.
- **Outputs:** JSON API responses, SSE live event streams, gateway status dashboard HTML (`GET /`).
- **Interfaces:** Complete REST/SSE endpoints documented in `OS3_API_CONTRACTS.md` (existing + `/api/daw/*`, `/api/plugins/*`, `/api/audio-brain/*`).
- **Dependencies:** `JARVIS Core`, `DAW Core`, `Vault Engine`, `Runtime Store`, `Event Bus`, `ui-queries.ts`.
- **Permissions:** Refuses `0.0.0.0` binding; rejects non-local Host/Origin (`403`); validates Bearer token when configured (`401`).
- **Events:** `api.request.denied`, `api.sse.connected`, `api.sse.disconnected`.
- **Failure modes:** Malformed JSON (`400`), foreign Origin (`403`), missing token (`401`), unsupported DAW capability (`422` / `501`), internal fault (`500` with redacted message).
- **Persistence:** Stateless HTTP routing over underlying OS3 engines.
- **Tests:** Localhost/allowlist rejection tests, auth token constant-time equality test, payload limit test, all API route integration tests (`tests/os3-phase3`, `phase11`, `jarvis-inspector`).

### A17. UI Adapter (`UI-xyp3rn/lib/{os3-adapter,gateway,daw-adapter,audio-reverse-engineer}.ts` + `core/gateway/ui-queries.ts`)
- **Responsibility:** Translates backend OS3/Vault/DAW DTOs into stable typed shapes for `UI-xyp3rn` components (`DashboardsView`, `MapScreen`, `KnowledgeGraphView`, `JarvisView`, future DAW panels), managing timeouts (`8000ms`), client DSP pre-computation, and deterministic seed fallbacks when `:8077` is offline.
- **Inputs:** User UI interactions, local browser audio files (`File`/`ObjectURL`), Gateway HTTP JSON/SSE responses, seed data (`data/map.ts`, `dashboard-seed.ts`).
- **Outputs:** Validated React state snapshots (`ApiAdapterResult<T>`), local seed fallbacks, normalized `UiPreferences`.
- **Interfaces:** `fetchSystemOverview()`, `fetchKnowledgeGraph()`, `dispatchJarvis()`, `analyzeAudioBuffer()` + Phase 02 `fetchDawStatus()`, `fetchDawSession()`, `proposeDawPatch()`, `approveDawPatch()`.
- **Dependencies:** Browser `fetch` API, Web Audio API (`AudioContext`, `AnalyserNode`), `@/lib/types`, `@/data/map`.
- **Permissions:** Browser client privilege only; carries zero filesystem/SQLite/DAW host handles; passes operator decisions to Gateway endpoints.
- **Events:** Consumes Gateway SSE/poll snapshots to trigger reactive UI state refreshes.
- **Failure modes:** Gateway offline / timeout -> sets diagnostic `error` state while returning typed offline seed mode (`local-vault`) without crashing UI rendering.
- **Persistence:** Strict minimal `localStorage` keys (`status`, `session`, `prefs` only).
- **Tests:** Mocked fetch online/offline/500/timeout unit tests + React Testing Library integration tests (`os3-adapter.test.ts`, `os3-integration.test.tsx`).

---

## PART B — DAW BRAIN SUBSYSTEM CONTRACTS (1–13)

### B1. DAW Core (`core/daw-brain/core.ts`)
- **Responsibility:** Top-level vendor-agnostic DAW orchestrator managing adapter registry lifecycle, active DAW session coordination, read-only default observation, workflow dispatch, and strict `UNSUPPORTED` reporting.
- **Inputs:** Selected `adapterId`, project path, DAW requests from `JARVIS Core` / `API` / `DAW Agents`.
- **Outputs:** `DawSessionStateContainer`, `DawDiagnosticReport`, execution/proposal receipts.
- **Interfaces:** `registerAdapter(adapter)`, `connectSession(adapterId, projectPath?)`, `refreshSession(sessionId)`, `proposeActions()`, `executeWithGateway()`.
- **Dependencies:** `DAW Adapter SDK`, `DAW Capability Registry`, `DAW Session Model`, `DAW State Observer`, `DAW Command Gateway`, `Event Bus`.
- **Permissions:** Boots every session at `observe` max permission; delegates capability enforcement to `DawCapabilityRegistry`.
- **Events:** `daw.session.connected`, `daw.session.disconnected`, `daw.session.error`.
- **Failure modes:** Unknown adapter (`DAW_ADAPTER_NOT_FOUND`), host unreachable (falls back cleanly to `cached` state with `hostOnline: false`), vendor leakage forbidden by static test.
- **Persistence:** Coordinates session state with `Runtime Store` (`daw_sessions`).
- **Tests:** Vendor-isolation import guard test, mock multi-adapter session lifecycle tests.

### B2. DAW Adapter SDK (`core/daw-brain/adapter-sdk.ts`)
- **Responsibility:** Defines the uniform TypeScript contract, manifest declaration schema, standardized error codes (`DAW_CAPABILITY_UNSUPPORTED`, `DAW_TARGET_DRIFT`, `DAW_HOST_OFFLINE`), and adapter conformance suite.
- **Inputs:** Vendor adapter implementations (`FL Studio 2025`, `REAPER`, mock test adapters).
- **Outputs:** Verified `DawAdapter` instances passing capability compliance checks.
- **Interfaces:** `DawAdapter` interface, `DawAdapterManifest`, `runAdapterConformanceSuite(adapter)`.
- **Dependencies:** Zero vendor imports; depends purely on canonical DAW types (`core/daw-brain/types.ts`).
- **Permissions:** Enforces that every adapter explicitly labels every `DawCapabilityId` (`SUPPORTED` | `TEMPLATE_SCOPED` | `READ_ONLY` | `UNSUPPORTED`).
- **Events:** `daw.adapter.registered`, `daw.adapter.conformance_failed`.
- **Failure modes:** Missing capability declaration or silent mock-success on an `UNSUPPORTED` capability -> fails conformance verification.
- **Persistence:** None (pure TypeScript runtime contract + conformance harness).
- **Tests:** Automated SDK conformance matrix verifying both capable (`REAPER`-style) and constrained (`FL Studio 2025`-style) capability assertions.

### B3. DAW Capability Registry (`core/daw-brain/capability-registry.ts`)
- **Responsibility:** Resolves whether an actor (`operator` | `AgentClass`) in a given `sessionId` can invoke a `DawCapabilityId`, cross-checking session permission lease tier (`observe`..`rollback`) against adapter manifest support.
- **Inputs:** `sessionId`, `actor`, `capabilityId`, active `DawSessionLease`.
- **Outputs:** `{ authorized: true }` or structured denial (`DAW_PERMISSION_DENIED` vs `DAW_CAPABILITY_UNSUPPORTED` vs `DAW_TEMPLATE_REQUIRED`).
- **Interfaces:** `checkCapability(req)`, `grantSessionLease(lease)`, `revokeSessionLease(sessionId)`.
- **Dependencies:** `Runtime Store` (`daw_session_leases`), `DAW Adapter SDK`, `Audit Engine`.
- **Permissions:** Defaults strictly to `observe` (`analyze` read compute allowed; `execute`/`rollback` denied without explicit valid lease).
- **Events:** `daw.lease.granted`, `daw.lease.revoked`, `daw.capability.denied`.
- **Failure modes:** Expired TTL lease -> auto-downgrades immediately back to `observe` read-only.
- **Persistence:** Reads/writes active leases in SQLite `daw_session_leases`.
- **Tests:** Lease expiry escalation denial, unsupported host capability denial, cross-host capability differentiation tests.

### B4. DAW Session Model (`core/daw-brain/session-model.ts`)
- **Responsibility:** Enforces immutable separation across the 5 mandatory state tiers (`liveObserved`, `cached`, `savedProject`, `proposedModifications`, `appliedModifications`), tracking `hasUnsavedLiveChanges` and project file checksum drift.
- **Inputs:** Host observed snapshot, cached DB row, parsed project structure (`savedProject`), proposal list, execution receipts.
- **Outputs:** Unified `DawSessionStateContainer` with explicit staleness/unsaved flags.
- **Interfaces:** `applyObservedSnapshot()`, `setSavedProjectSnapshot()`, `addProposal()`, `recordAppliedExecution()`, `detectLiveVsSavedDivergence()`.
- **Dependencies:** `core/sqlite`, `crypto` SHA-256.
- **Permissions:** Mutation per field locked to owning subsystem (`liveObserved` updated ONLY by Observer; `savedProject` updated ONLY by project parser; `appliedModifications` written ONLY by Command Gateway).
- **Events:** `daw.session.state_updated`, `daw.session.unsaved_drift_detected`.
- **Failure modes:** Rejects stale receipt overwrites or treating cached snapshots as live observed truth (`state.source` discriminator checked strictly).
- **Persistence:** Persists cached snapshot, saved checksum, and applied journal in SQLite (`daw_sessions`, `daw_command_journal`); Obsidian holds promoted session summaries.
- **Tests:** Five-tier state isolation test (proving live tweak never alters `savedProject`, closed DAW returns `cached` flagged `stale: true`).

### B5. DAW State Observer (`core/daw-brain/observer.ts`)
- **Responsibility:** Performs bounded, non-mutating inspection of live DAW transport, mixer channels/routing, loaded plugin lists, and on-disk `.flp`/`.rpp` SHA-256 checksums without blocking host UI or spamming MIDI buffers.
- **Inputs:** Poll interval / manual inspect trigger, active `DawAdapter` (`observe` permission).
- **Outputs:** Diffed `DawObservedSnapshot` & `DawSavedTopology` events into `DAW Session Model`.
- **Interfaces:** `pollOnce(sessionId)`, `startObserving(sessionId, intervalMs)`, `stopObserving(sessionId)`, `inspectProjectFile(path)`.
- **Dependencies:** `DAW Adapter SDK`, `DAW Session Model`, `DAW Event System`.
- **Permissions:** Requires `observe` only. Refuses execution commands cleanly.
- **Events:** `daw.session.observed`, `daw.session.drift_detected`, `daw.transport.changed`.
- **Failure modes:** Poll timeout / SysEx drop -> increments retry counter and marks live stream `degraded` while keeping last `cached` snapshot intact.
- **Persistence:** Updates `daw_sessions.cached_snapshot_json` on meaningful state deltas.
- **Tests:** Poll deduplication, external manual fader change detection, timeout degradation test with mock MIDI/OSC responder.

### B6. DAW Event System (`core/daw-brain/events.ts`)
- **Responsibility:** Emits strongly typed DAW lifecycle, state change, safety alert (`headroom_alert`), render completion, and command audit events onto the shared OS3 `Event Bus`.
- **Inputs:** State changes from `Observer`, `Audio Brain`, `Command Gateway`, `Evaluation Engine`.
- **Outputs:** Normalized `Os3DomainEvent` envelopes with `daw.*` namespaces.
- **Interfaces:** `emitDawEvent(type, sessionId, payload)`, `onDawEvent(type, handler)`.
- **Dependencies:** OS3 `Event Bus`, `Audit Engine`.
- **Permissions:** Internal telemetry bus; no external control authority.
- **Events:** `daw.adapter.*`, `daw.session.*`, `daw.transport.*`, `daw.audio.*`, `daw.command.*`.
- **Failure modes:** Event storm from rapid user fader drag -> debounced coalescing window (`100ms`) prevents UI/SQLite saturation.
- **Persistence:** Security-critical events (`daw.command.*`, `daw.capability.denied`) mirrored durably to SQLite `runtime_events`.
- **Tests:** Event coalescing test, headroom alert emission test, audit mirror completeness test.

### B7. DAW Command Gateway (`core/daw-brain/command-gateway.ts`)
- **Responsibility:** Enforces the entire 6-stage mutation pipeline (`Capability Check` -> `Target Drift Validation` -> `Audio Safety Clamps` -> `BeforeState Snapshot` -> `Human/Policy Approval Check` -> `Adapter Dispatch + Post-Verify + Rollback Handler`).
- **Inputs:** `DawPatchProposal` (`DawCommand[]`), `approvalId`, operator lease token.
- **Outputs:** `PreparedDawPatch`, `DawExecutionReceipt` (`beforeState`, `afterState`, `verified`), or structured `DawRollbackReceipt`.
- **Interfaces:** `preparePatch(sessionId, cmds)`, `executePatch(sessionId, patchId, approvalId)`, `rollbackExecution(receiptId)`.
- **Dependencies:** `DAW Capability Registry`, `DAW Session Model`, `DAW Adapter SDK`, `Runtime Store`, `Audit Engine`.
- **Permissions:** Strict `prepare` / `execute` / `rollback` permissions; never executes without human/approved ID + lease + safety check.
- **Events:** `daw.command.prepared`, `daw.command.approved`, `daw.command.executed`, `daw.command.denied`, `daw.command.rolled_back`.
- **Failure modes:** Any safety violation (`gainDelta > +3 dB`, ceiling `> -0.1 dBTP`, target plugin mismatch) aborts pre-dispatch cleanly with zero host MIDI sent (`DAW_SAFETY_VIOLATION` / `DAW_TARGET_DRIFT`).
- **Persistence:** Appends immutable before/after receipts into SQLite `daw_command_journal`.
- **Tests:** Safety clamp rejection suite, stale target abort test, approval bypass rejection, round-trip `execute` + `rollback` verification.

### B8. Plugin Brain (`core/daw-brain/plugin-brain/`)
- **Responsibility:** Maintains local host VST3/VST2/CLAP + DAW native inventory, verifies FL Studio Producer Edition license compatibility, maps vendor-specific plugin param indexes/labels to semantic canonical audio concepts (`eq.band1.freq`, `comp.threshold_db`), and checks chain compatibility.
- **Inputs:** Workstation plugin folder scans (`VST3`, `VSTPlugins`), DAW live loaded plugin telemetry, Obsidian `PLUGINS/*.md` semantic maps.
- **Outputs:** `PluginInventoryCatalog`, `EditionCompatibilityVerdict`, `SemanticParamResolution`.
- **Interfaces:** `scanHostPlugins()`, `resolveSemanticParam(pluginId, semanticKey)`, `validateChainForHost(adapterId, edition, pluginIds)`.
- **Dependencies:** `VaultEngine` (`09_X3LIUS_MUSIC/PLUGINS/`), `DAW Adapter SDK`, `fs` (read-only over registered VST directories).
- **Permissions:** Strictly read-only scan over allowlisted system plugin directories (`C:\Program Files\Common Files\VST3`, etc.) + `VaultEngine`.
- **Events:** `daw.plugin.inventory_updated`, `daw.plugin.edition_blocked`.
- **Failure modes:** Unlicensed/Producer-excluded plugin (`Harmor`, `Gross Beat`) requested -> returns `PLUGIN_EDITION_EXCLUDED` + Producer-compatible alternative recommendation; unknown semantic mapping -> prompts read-only param introspection.
- **Persistence:** Canonical/curated plugin semantic maps in Obsidian `09_X3LIUS_MUSIC/PLUGINS/`; fast lookup cache in derived `index_state`.
- **Tests:** Producer vs Signature filtering test, VST3 folder scanner test (Windows fixtures), semantic normalization bijection test.

### B9. Audio Brain (`core/daw-brain/audio-brain/`)
- **Responsibility:** Unified OS3 DSP & Quantitative Mix/Master Analyzer merging `tech/trace` (`trace.analysis/v1`, `trace.report/v1`), `mix-rubric.yaml` compliance scoring, and `audio-reverse-engineer.ts` acoustic extraction across bounce WAVs, TRACE VST3 posts, and browser DSP telemetry — **100% SQLite + Vault backed (zero Postgres)**.
- **Inputs:** Audio PCM/WAV file buffer or path, client `AudioAcousticTelemetry`, external `trace.analysis/v1` payload, active canonical `mix-rubric.yaml` target stage (`mix` | `master`).
- **Outputs:** `AudioBrainReport` (`trace.analysis/v1`, `trace.report/v1` `raise`/`lower`/`keep` deltas, diagnostic alerts, reverse-engineered production specs).
- **Interfaces:** `analyzeAudioFile()`, `evaluateAgainstRubric()`, `reverseEngineerStyle()`, `ingestTraceAnalysis()`.
- **Dependencies:** `tech/trace/{analysis,report}`, `records/x3lius/mix-master/agent`, `core/gateway/audio-reverse-engineer`, `VaultEngine`, `Runtime Store`.
- **Permissions:** Read-only compute (`analyze`); saving extracted prompt notes requires explicit user action to `09_X3LIUS_MUSIC/AUDIO_EXTRACTED_PROMPTS/`.
- **Events:** `daw.audio.analyzed`, `daw.audio.headroom_alert`, `daw.audio.rubric_checked`.
- **Failure modes:** Clipping file (`truePeak > 0 dBTP`) -> immediately flags critical headroom warning; missing rubric -> emits `unset` list without fabricating defaults.
- **Persistence:** Analysis runs stored in SQLite `daw_audio_analyses`; extracted prompts / approved reports saved in Obsidian Vault.
- **Tests:** WAV DSP analysis accuracy on test sine/noise/drum buffers, rubric check parity vs OS2 `x3lius-mix-master`, zero-Postgres TRACE intake test.

### B10. Production Intelligence (`core/daw-brain/production-intelligence/`)
- **Responsibility:** Synthesizes actionable mixing, arrangement, gain-staging, and routing plans from Obsidian production knowledge, X3LIUS briefs, `Audio Brain` reports, and `Plugin Brain` inventories — adapting gracefully between automated patches (`SUPPORTED`) and step-by-step operator instructions (`UNSUPPORTED`).
- **Inputs:** `DawSessionStateContainer`, `AudioBrainReport`, `PluginInventoryCatalog`, artist goal/mix rubric.
- **Outputs:** `DawProductionPlan` (`proposedModifications[]` automated `DawCommand` patches + `manualOperatorSteps[]` for non-scriptable actions like inserting VSTs).
- **Interfaces:** `buildMixCorrectionPlan()`, `adaptProductionSchemaToHost(productionArtifact, session)`.
- **Dependencies:** `Context Engine`, `Plugin Brain`, `Audio Brain`, `DAW Capability Registry`.
- **Permissions:** Strictly `propose` (`never executes directly`).
- **Events:** `daw.plan.proposed`, `daw.plan.manual_steps_required`.
- **Failure modes:** When FL Studio lacks `daw.plugin.load_remove`, emits explicit `manualOperatorSteps` rather than dropping or faking plugin insertion commands.
- **Persistence:** Plans stored as draft session reports/recipes in Obsidian via `VaultEngine`.
- **Tests:** Mix-delta to bounded patch generation test, unsupported capability fallback-to-manual-step test.

### B11. DAW Agent Team (`04_AGENTS/DAW_*.md`) *(Subject to Owner Roster Approval)*
- **Responsibility:** Specialized single-class OS3 Markdown agents executing governed workflows (`daw-session-observer`, `daw-plugin-advisor`, `daw-audio-analyst`, `daw-mix-planner`, `daw-execution-operator`).
- **Inputs:** Workflow step bindings, context bundles, session snapshots.
- **Outputs:** Schema-validated JSON reports, proposals, execution requests.
- **Interfaces:** Loaded strictly through `Agent Registry` (`xyp3rn.agent/v3`), dispatched via `Task Orchestrator` (`ToolRegistry`).
- **Dependencies:** `Agent Registry`, `Tool Registry`, `DAW Core`, `Model Gateway` (`none` for deterministic observer/operator agents; configurable LLM for planner/advisor).
- **Permissions:** Strictly separated single-class permissions (`Knowledge` observers cannot call `daw.execute`; only `Execution` operator triggers approved prepared patches).
- **Events:** Standard `agent.run.*` + `daw.*` events.
- **Failure modes:** Out-of-scope tool call blocked by `ToolRegistry`; schema mismatch logged and halted cleanly.
- **Persistence:** Agent definitions canonical in `04_AGENTS/` (after Owner approval).
- **Tests:** Registry validation check + capability boundary adversarial tests preventing observer/planner direct execution.

### B12. DAW Evaluation Engine (`core/daw-brain/evaluation-engine.ts`)
- **Responsibility:** Quantitatively measures pre- vs post-patch DAW changes (verifying param readbacks, re-running Audio Brain analysis on rendered bounces, detecting metric regression/stall, and recommending rollback when headroom/rubric degrades).
- **Inputs:** `DawExecutionReceipt`, pre/post `AudioBrainReport`, target rubric bounds.
- **Outputs:** `DawEvaluationVerdict` (`improved` | `neutral` | `regressed`, metric deltas, `recommendRollback: boolean`).
- **Interfaces:** `evaluateExecution(sessionId, receiptId)`, `verifyReadback(receipt)`.
- **Dependencies:** `Audio Brain`, `DAW State Observer`, `DAW Command Gateway` (to suggest rollback).
- **Permissions:** Read-only `analyze` + `propose` (`never auto-executes rollback without policy/human sign-off`).
- **Events:** `daw.evaluation.completed`, `daw.evaluation.regression_detected`.
- **Failure modes:** Stale audio render (`bounce` older than last `appliedModification`) -> blocks false pass and labels verdict `NEEDS_FRESH_RENDER`.
- **Persistence:** Evaluation scorecards logged in `runtime_events` + optional session Markdown notes in Vault.
- **Tests:** Regression detection -> rollback proposal trigger test, stale bounce rejection test.

### B13. DAW Workflow Library (`05_WORKFLOWS/DEFINITIONS/daw-*.workflow.yaml`)
- **Responsibility:** Canonical YAML DAG orchestrations combining DAW observation, Audio Brain diagnostics, Plugin Brain checks, human-gated execution, headless render verification, and cross-DAW parity flows.
- **Inputs:** Workflow inputs (`sessionId`, `renderPath`, `targetStage`, `goal`).
- **Outputs:** Compiled `LoadedWorkflow` specs executed through `Workflow Engine`.
- **Interfaces:** Standard `xyp3rn.workflow/v3` specs (`daw-observe-diagnose`, `daw-mix-assist-patch`, `daw-render-verify`, `daw-template-preflight`).
- **Dependencies:** `Workflow Engine`, `DAW Agent Team`, `DAW Brain` tools.
- **Permissions:** Enforces per-step single-class permissions + human approval pause step before `execute`.
- **Events:** Emits `workflow.*` + `daw.*` correlated by `job_id`.
- **Failure modes:** Missing template -> `daw-template-preflight` aborts safely cleanly reporting missing slots.
- **Persistence:** Canonical YAML stored in Obsidian `05_WORKFLOWS/DEFINITIONS/`.
- **Tests:** YAML compilation validation, DAG cycle/binding tests, simulated workflow E2E tests (`tests/daw-brain/`).
