# XYP3RN OS 3.0 — Local-First & Obsidian-First Architecture

Status: Phases 1, 2, 3 & 4 implemented (`core/sqlite`, `core/vault-engine`, `core/gateway`, `UI-xyp3rn/lib/gateway.ts`, `scripts/start-os3.ps1`, `tests/os3-phase1..3`). Legacy PostgreSQL (`core/db`, `supabase/migrations`) preserved in parallel until full migration parity is verified.

## 1. Architectural Ownership

| Subsystem | Owner | Responsibility |
|---|---|---|
| **Obsidian Vault** | External Vault (`XYP3RN-Suno-KB-v1.2-Brain` + 6 canonical sectors `01_CORE`..`06_GOVERNANCE`) | Canonical knowledge, agent definitions, workflow definitions, research briefs/evidence/findings, policies, decisions, X3LIUS creative records, documentation. |
| **Vault Engine** | `core/vault-engine/` (`engine.ts`, `path-guard.ts`, `revision.ts`) | Single authority for Vault file reads/writes, path safety, extension validation, No-Overwrite Guard, Compare-and-Swap conflict detection, immutable SHA-256 revisions (`.vault-revisions/`), structural indexing, wikilink resolution, and Promotion Gate execution. |
| **Minimal SQLite** | `core/sqlite/` (`schema.ts`, `client.ts`) | Local Node 22 `node:sqlite` runtime database (`agent_runs`, `jobs`, `locks`, `sessions`, `runtime_events`, `pending_approvals`, `index_state`, `index_meta`). |
| **JARVIS Core** | `core/src/jarvis/` + `core/orchestrator/` | Request routing, agent orchestration, workflow execution, tool authorization, context assembly, model gateway, runtime coordination. |
| **UI-xyp3rn** | Primary operator interface (`UI-xyp3rn`) | Galaxy Map, Agent Explorer, Workflow Explorer, Knowledge Explorer, Research Workbench, X3LIUS Records, Studio, Dashboards, Governance. |

## 2. Phase 1 Invariants Enforced in Code & SQLite Triggers

1. **Append-Then-Seal Runs & Jobs:** `trg_agent_runs_seal`, `trg_agent_runs_no_delete`, `trg_jobs_seal`, and `trg_jobs_no_delete` prevent mutating identity columns or modifying/deleting a run or job once it leaves `pending`/`running`.
2. **Immutable Audit Trail:** `runtime_events` rejects `UPDATE` and `DELETE` via `trg_runtime_events_no_update` and `trg_runtime_events_no_delete`.
3. **Human Approval Gate (`F35 D2`):** `pending_approvals` requires a non-empty `approver` and `reason` to transition from `pending` to `approved` or `rejected`, and `trg_pending_approvals_seal` prevents re-deciding or deleting decided rows.
4. **Canonical Protection:** `VaultEngine.writeNote()` and `VaultEngine.appendNote()` refuse any direct write to canonical sectors (`02_KNOWLEDGE_LAYER/`, `01_CORE/00_Identity/`, `01_CORE/01_System_Prompts/`, `06_GOVERNANCE/00_Policies/`, `canonical/`) or notes declaring `status: canonical`. Only `VaultEngine.promoteToCanonical()` with an `approved` row in `pending_approvals` can write canonical notes.
5. **No Silent Overwrites:** `VaultEngine.writeNote()` defaults to `no-overwrite` (`Note (2).md`) and supports `compare-and-swap` (`expectedSha256`), logging `vault.write.conflict` if the file changed on disk.
6. **Disposable Index State:** `index_state` in SQLite is a non-canonical structural cache rebuilt incrementally from the Obsidian Vault via `VaultEngine.scanVault()`.

## 3. Phase 2 — Canonical Vault Bootstrap & Synchronization

`core/vault-engine/bootstrap.ts` (`pnpm vault:os3 init | scan | status | search`) maintains the 6-sector folder hierarchy inside the canonical Obsidian Vault (`C:/Users/blago/Desktop/XYP3RN-Suno-KB-v1.2-Brain`):

- **`01_CORE`**: 52 first-party agent definitions (`02_Agents/*.md`), 7 workflow specs & notes (`03_Workflows/*.workflow.yaml` + `*.md`), templates (`04_Templates/`), dashboards (`05_Dashboards/Agent Registry.md`, `Workflow Engine.md`), tasks (`06_Tasks/`), tools (`07_Tools/`).
- **`02_KNOWLEDGE_LAYER`**: MOCs, frameworks (`mix-rubric.yaml`, `tech.manifest.yaml`), atomic notes, and `Prompt_Knowledge`.
- **`03_RESEARCH_INTELLIGENCE`**: Research briefs, analyses, syntheses, and the 20 research specialists (`06_Specialists/*.md`).
- **`04_RESEARCH_MATERIAL`**: Source papers, articles, transcripts, datasets, media.
- **`05_XYP3RN_RECORDS`**: Daily notes, session logs, ADRs, releases, and `06_X3LIUS_MUSIC_SYSTEM/` (`00_Songs`..`07_Suno_Prompts`, `vocal-dna.yaml`, `music-system.manifest.yaml`).
- **`06_GOVERNANCE`**: Policies, standards (`OS-2-Architecture.md`, `OS-3-Architecture.md`, `Canonical-Schema-Reference.md`), access control (`Agent-Classes-and-Capabilities.md`), audit logs.
- **`ROOT_KB`**: Preserves all 19,630+ Suno v5/v6 knowledge base notes in place (`BEST-*`, `PROMPT-*`, `TAG-*`, `TECH-*`, `VOC-*`, `WF-*`, `_COMMUNITY_*`) and indexes them into SQLite `index_state` using batched WAL transactions (`400` rows per transaction) with `mtime + byte_size` fast-path skipping on subsequent scans.

## 4. Phase 3 — JARVIS Core & Local HTTP Gateway (`127.0.0.1:8077`)

`core/gateway/jarvis-runtime.ts` and `core/gateway/server.ts` (`pnpm gateway:os3`) expose the local-first HTTP gateway bound strictly to `127.0.0.1:8077`:

- `GET /api/health` — Live Vault index counters across all sectors, registered agent count (`52`), and pending human approvals.
- `POST /api/jarvis` — Executes operator directives (`status`, `read`, `write`, `append`, `search`, `flow`, `task`, `registry`, `promote`, `connections`, `specialists`, `research`, `record`, `records`, `song new`, `compose`, `play`, `gemini`, `@context`) through `ToolRegistry` capability checks, `VaultEngine`, `AgentRegistry`, and `SqliteRuntimeDb`.
- `GET /api/music/pulse` — Deterministic 24-band beat-synced spectrum relay for `X3liusPlayer`.
- `GET /api/vault/note` & `GET /api/vault/search` — Direct read and search over the 20,161 indexed Vault files plus incoming/outgoing `[[wikilinks]]`.
- `GET /api/approvals` & `POST /api/approvals/decide` — Human-in-the-loop approval queue and Promotion Gate execution.
- `GET /api/events` & `GET /api/runs` — Append-only audit events (`runtime_events`), `agent_runs`, and `jobs`.

## 5. Phase 4 — `UI-xyp3rn` Integration & Unified Launcher

- `UI-xyp3rn/lib/gateway.ts` & `UI-xyp3rn/lib/types.ts` expose typed client bindings for the OS 3.0 Gateway on `127.0.0.1:8077`:
  - `dispatchJarvis()` (`POST /api/jarvis`)
  - `fetchTrackPulse()` (`GET /api/music/pulse`)
  - `fetchGatewayHealth()` (`GET /api/health`)
  - `fetchVaultNote()` (`GET /api/vault/note`)
  - `searchLiveVault()` (`GET /api/vault/search`)
  - `fetchPendingApprovals()` (`GET /api/approvals`)
  - `decideGatewayApproval()` (`POST /api/approvals/decide`)
- Every client helper falls back deterministically to the local seed in `data/map.ts` when `127.0.0.1:8077` is offline, preserving 100% of `UI-xyp3rn`'s geometry, animations, navigation, and visual tokens.
- `pnpm start:os3` (`scripts/start-os3.ps1`) runs incremental Vault indexing (`pnpm vault:os3 scan`), launches the OS 3.0 Gateway on `127.0.0.1:8077`, and starts `UI-xyp3rn` on `127.0.0.1:3000`.



