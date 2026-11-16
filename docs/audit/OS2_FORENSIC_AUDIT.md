# OS2 / OS3 Backend Forensic Audit (`xyp3rn-os-2`)

**Audit Date:** 2026-11-16  
**Audited Checkout:** `C:\Users\blago\Desktop\oss2\officialFolderofXYP3RNOS` (`origin`: `https://github.com/BLGofficial/xyp3rn-os-2.git`, branch `main` @ `c17ed05`, clean working tree) — **VERIFIED**  
**Scope:** Read-only architectural, runtime, dependency, security, persistence, and CI audit of the backend repository. Zero code or configuration changes performed.

---

## 1. Executive Reality Finding: Hybrid Coexistence of OS2 & OS3

The audited repository `officialFolderofXYP3RNOS` is **not** a pure pre-migration OS2 tree — it currently houses **two coexisting architectures side by side** (**VERIFIED** via filesystem layout and `rg` import tracing):

1. **Legacy OS2 PostgreSQL + Legacy Web Stack (`apps/web/`, `core/db/`, `supabase/migrations/`):** **96 TypeScript files** across `core/`, `knowledge/`, `records/`, `research-intelligence/`, `tech/`, `governance/`, and `apps/web/server/` still import `postgres` (`postgres.js`) or `core/db` (`127.0.0.1:5432`).
2. **OS3 Local-First Obsidian Vault + SQLite Runtime (`core/vault-engine/`, `core/sqlite/`, `core/gateway/`):** **13 root orchestrating files** (`core/gateway/*`, `core/context-engine/os3-*`, `core/tool-registry/os3-*`, `core/workflow-engine/os3-*`, `records/os3-records-engine.ts`, `research-intelligence/os3-research-engine.ts`) plus **18 OS3 test suites (`tests/os3-*`)** implement the local-first Vault + WAL SQLite engine, operating with zero Postgres connection.

---

## 2. Runtime, Entry Points & Workspace Topology

- **Node & Package Toolchain (`VERIFIED`):**
  - Installed Node runtime: `v26.13.0` (`package.json` `engines.node`: `>=22`; `.nvmrc`: `22`).
  - Package manager: `pnpm 10.30.3` (`pnpm-workspace.yaml` declares workspace `apps/*`; Windows execution requires `pnpm.cmd`).
  - Root TypeScript (`tsconfig.json`): `"target": "ES2023"`, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"verbatimModuleSyntax": true`, `"allowImportingTsExtensions": true`, `"erasableSyntaxOnly": true`, `"noEmit": true`.
  - Root code runs directly via Node's native `.ts` type-stripping without a root `dist/` compilation step (`VERIFIED`).
- **Workspace Checkout Conflicts (`VERIFIED`):**
  - Clean `main`: `C:\Users\blago\Desktop\oss2\officialFolderofXYP3RNOS` (`c17ed05`).
  - Dirty sibling worktrees of the same Git repo: `C:\Users\blago\Desktop\oss2\xyp3rn-os-2` (`feat/p01-shell` @ `528b1e2`), `C:\Users\blago\Desktop\oss2\xyp3rn-os-2-aos04` (`claude/aos-04` @ `4007964`, includes `Kokoro-FastAPI/`), plus prunable missing worktree `xyp3rn-os-2-engine`.
  - Session metadata active URI (`e:\FileHistory\...\xyp3rn-os-2-aos04`) points to a non-git Windows File History snapshot from `2026-09-27` (`not a git repository`, lacks `package.json`).
  - `officialFolderofXYP3RNOS` root contains unreferenced/loose artifacts (`0.26.0`, legacy HTML/TSX UI prototypes, `New folder`).
- **Entry Points (`package.json`, `scripts/`, `core/`, `VERIFIED`):**
  - **OS3 Boot:** `pnpm.cmd start:os` / `start:os3` → `scripts/start-os3.ps1` (scans Vault via `vault:os3 scan`, launches `core/gateway/cli.ts` on `127.0.0.1:8077`, launches `UI-xyp3rn` on `127.0.0.1:3000`).
  - **OS2 Legacy Boot:** `pnpm.cmd start:legacy-os2` → `scripts/start-xyp3rn.ps1` (Docker/Postgres + `@xyp3rn/web` on `127.0.0.1:3100`).
  - **Direct CLIs:**
    - OS3-native: `vault:os3` (`core/vault-engine/cli.ts`), `gateway:os3` (`core/gateway/cli.ts`), `agents:validate` (`core/agent-registry/cli.ts`).
    - OS2 Postgres-bound (`VERIFIED` importing `core/db`): `db:setup/up/down/status`, `ask` (`core/orchestrator/ask-cli.ts`), `dispatch` (`core/orchestrator/cli.ts`), `workflow` (`core/workflow-engine/cli.ts`), `jarvis` (`core/src/cli/jarvis-entry.ts`), `ingest`, `embed`, `context`, `research`, `gate`, `evaluate`, `trace:serve` (`tech/trace/serve-cli.ts`), `vault` (`records/vault/cli.ts`), `index`, `obsidian:export`, `obsidian:watch`, `studio`.

---

## 3. Module Boundaries & Dependency Graph

| Subsystem | Directory (`file count`) | Storage / IO Binding | Key Contracts & Source Paths |
|---|---|---|---|
| **Taxonomy & Contracts** | `core/contracts/` | Pure TypeScript (`VERIFIED`) | `core/contracts/taxonomy.ts` (6 domains, 8 agent classes; enforced single-kernel ownership in `tests/aos-00/single-kernel.test.ts`) |
| **Vault Engine (OS3)** | `core/vault-engine/` (20 files) | Local Obsidian Vault FS + `core/sqlite/` (`VERIFIED`) | `vault-engine.ts`, `path-guard.ts`, `path-resolver.ts`, `writer.ts`, `revision.ts` (atomic + backoff), `transaction-manager.ts`, `version-manager.ts`, `promotion-gate.ts`, `watcher.ts`, `vault-foundation.ts`, `bootstrap.ts` |
| **Local Runtime (OS3)** | `core/sqlite/` (4 files), `core/runtime/` | `node:sqlite` (`.local-db/xyp3rn-os3.sqlite`) (`VERIFIED`) | `core/sqlite/client.ts` (1,079 lines), `schema.ts`, `schema-migrations.ts`, `repositories.ts`, `core/runtime/logger.ts` |
| **Gateway & JARVIS (OS3)** | `core/gateway/` (7 files) | VaultEngine + `SqliteRuntimeDb` (`VERIFIED`) | `cli.ts`, `server.ts`, `os3-jarvis-core.ts`, `jarvis-runtime.ts`, `jarvis-inspector.ts`, `ui-queries.ts`, `audio-reverse-engineer.ts` |
| **Legacy DB & JARVIS (OS2)** | `core/db/`, `core/src/`, `core/orchestrator/` | `postgres` `^3.4.9` (`VERIFIED`) | `core/db/client.ts`, `core/orchestrator/dispatch.ts`, `core/src/jarvis/JarvisOrchestrator.ts`, `core/src/playbooks/monday-review.ts` |
| **Agent Registry** | `core/agent-registry/`, `agents/` (53 `.md`) | Filesystem Markdown/YAML (`VERIFIED`) | 52 active `.agent.md` + `_template.agent.md`; OS2 loader `registry.ts` + OS3 Vault loader `os3-agent-registry.ts` (`04_AGENTS/`) |
| **Tool Registry** | `core/tool-registry/` | In-memory capability enforcement (`VERIFIED`) | `capabilities.ts` (23 capabilities across 8 classes; `canonical.write`, `approval.decide`, `audit.write` = `[]`), `registry.ts`, `os3-tool-registry.ts` (39 tools) |
| **Context Engine** | `core/context-engine/` | Hybrid OS2 (Postgres) & OS3 (SQLite + Vault) (`VERIFIED`) | OS2: `context-engine.ts`, `vault-corpus.ts`; OS3: `os3-context-engine.ts`, `structural-index.ts`, `semantic-index.ts` |
| **Workflow Engine** | `core/workflow-engine/` | Hybrid OS2 (`workflow_runs`) & OS3 (`jobs`) (`VERIFIED`) | Spec/DAG compiler `spec.ts`, 7 `.workflow.yaml` files; OS2 `engine.ts`; OS3 `os3-workflow-engine.ts` |
| **Model Gateway** | `core/llm/` | Env API keys / local Claude CLI (`VERIFIED`) | `providers.ts` (`@anthropic-ai/sdk`, OpenRouter, Groq), `claude-cli.ts`, `os3-model-gateway.ts`, `json-schema.ts` |
| **Knowledge & Obsidian** | `knowledge/` (60 files) | Mostly OS2 Postgres + `.vault/` + `.local-models/` (`VERIFIED`) | `obsidian/{parser,watcher,exporter,sync}.ts`, `promotion-gate/{gate,decide}.ts`, `vector-retrieval/` (`@huggingface/transformers` gte-small), `source-registry/vault-store.ts` |
| **Research Intelligence** | `research-intelligence/` (24 files) | Legacy CLI on Postgres; OS3 engine on Vault+SQLite (`VERIFIED`) | 20 specialist definitions; verbatim quote verification (`sources/verify.ts`, `evidence/engine.ts`); contradiction detection; `os3-research-engine.ts` (1,171 lines) |
| **Records & X3LIUS** | `records/` (68 files) | Legacy CLIs/ops on Postgres; OS3 on Vault (`VERIFIED`) | `records/x3lius/` (10 domain manifest, `script-check.ts`, `mix-master/agent.ts`, `evaluation/loop.ts`), `records/ops/` (GS1 UPC, ISO 3901 ISRC, 100.000% splits), `records/os3-records-engine.ts` (1,336 lines) |
| **Tech & TRACE** | `tech/` (17 files) | Postgres (`server.ts` `:8787`) (`VERIFIED`) | `tech/trace/{analysis,report,schemas,intake,server,serve-cli}.ts`, `tech/r-and-d/` |
| **Governance** | `governance/` (2 files) | Postgres (`xyp_decide_approval`) (`VERIFIED`) | `governance/approvals.ts` (OS3 equivalents live in `core/vault-engine/promotion-gate.ts` & `core/sqlite/`) |
| **Galaxy Python Daemon** | `galaxy/` (72 files) | Python auxiliary server (`VERIFIED`) | Static Python graph build step in CI (`python3 galaxy/build.py`) + auxiliary daemon scripts |

---

## 4. API Routes Inventory (`VERIFIED`)

### A. OS3 HTTP Gateway (`core/gateway/server.ts`, bound to `127.0.0.1:8077`)
- **UI & Health:** `GET /` (HTML control console or JSON), `GET /api/health`
- **JARVIS & Whole-OS Inspection:** `POST /api/jarvis`, `GET /api/jarvis/search`, `GET /api/jarvis/inspect`, `POST /api/jarvis/proposal/decide`
- **Vault & Knowledge Graph:** `GET /api/vault/note`, `GET /api/vault/search`, `GET /api/vault/tree`, `GET /api/vault/graph`
- **Dashboards & Governance:** `GET /api/overview`, `GET /api/agents`, `GET /api/workflows`, `GET /api/runs`, `GET /api/events`, `GET /api/approvals`, `POST /api/approvals/decide`, `GET /api/research`, `GET /api/records`
- **Audio & X3LIUS:** `GET /api/music/pulse`, `GET /api/audio/prompts`, `POST /api/audio/reverse-engineer`, `POST /api/audio/save-prompts`

### B. Legacy Web App (`apps/web/app/api/*`, Next.js `15.5.27`, `:3100`)
- Exposes 24+ App Router handlers (`/api/events/stream`, `/api/graph/*`, `/api/jarvis/{command,start}`, `/api/studio/[operation]`, `/api/tasks`, `/api/v1/{galaxy,hud,knowledge,records,research,vault,workflows}/*`, `/api/voice/stream`). Server loaders under `apps/web/server/` remain bound to `core/db` (`postgres`).

### C. TRACE HTTP Service (`tech/trace/server.ts`, `127.0.0.1:8787`)
- Exposes `POST /v1/trace/analyses` behind bearer auth (`XYP_TRACE_TOKEN`); still imports `core/db` and writes to PostgreSQL.

---

## 5. SQL Schemas, Migrations, SQLite Boundary & Security Controls

### PostgreSQL (`supabase/migrations/`) — Legacy Store (`VERIFIED`)
- **27 `.sql` migrations** with **29 `enable row level security` statements** and **68 `CREATE POLICY` statements**.
- Enforces least-privilege role separation (`xyp_runtime`, `xyp_promotion`, `xyp_obsidian_watch`, `xyp_research`, `xyp_creative`, `xyp_catalog`, etc.) via `set local role` transactions (`core/orchestrator/dispatch.ts`, `knowledge/promotion-gate/gate.ts`).
- Enforces GS1 check digits (`xyp_is_valid_gs1`), ISRC constraints, split 100% triggers, and immutable audit history.

### SQLite (`core/sqlite/`) — OS3 Minimal Runtime Store (`VERIFIED`)
- WAL-mode embedded `node:sqlite` (`core/sqlite/client.ts`, `schema-migrations.ts`, 2 migrations).
- Strictly limited to **9 runtime tables** (`schema_meta`, `agent_runs`, `jobs`, `locks`, `sessions`, `runtime_events`, `pending_approvals`, `index_state`, `index_meta`) plus **2 views** (`runs`, `approvals`).
- Explicitly asserts against `FORBIDDEN_CANONICAL_SQLITE_TABLES` (`canonical_claims`, `knowledge_sources`, `songs`, `lyrics`, `releases`, `rights_splits`, etc.) so canonical content cannot quietly creep back into SQL.

### Security, Obsidian Watcher & Audit Controls (`VERIFIED`)
- **Network / Auth (`core/gateway/server.ts`):** Host/Origin/Referer strict allowlist for `127.0.0.1` and `localhost`; optional constant-time Bearer/`X-XYP-Token` authentication (`XYP_GATEWAY_TOKEN`).
- **Vault Path Security (`core/vault-engine/path-guard.ts`, `path-resolver.ts`):** Canonical path prefix guards (`CANONICAL_PATH_PREFIXES`), extension allowlist, traversal/non-POSIX rejection, symlink and NTFS junction escape blocking.
- **No-Overwrite & Atomic Concurrency (`revision.ts`):** `writeFileAtomic()` with Windows `EBUSY`/`EPERM` backoff, SHA-256 CAS optimistic locks, and external Obsidian edit preservation inside `.vault-revisions/`.
- **Promotion Gate (`core/vault-engine/promotion-gate.ts`):** Blocks agent self-approval (`AGENT_OR_SYSTEM_ACTOR_RE`), enforces human `"approved"` SQLite approval row before canonical commit.
- **Logging (`core/runtime/logger.ts`):** `StructuredLogger` + `redactSecrets()` masks API keys (`sk-or-v1-`, `sk-ant-`, `gsk_`, `AIza`, `Bearer`, PEM keys) and sensitive key names (`api_key`, `secret`, `password`, `token`, `authorization`).

---

## 6. Dependencies, Tests & CI (`VERIFIED`)

- **Notable Package Findings (`package.json`):**
  - Root specifies `typescript: ^7.0.2` alongside aliased `typescript-api: npm:typescript@5.9.3`, `@types/node: ^26.6.2`, `vitest: ^5.0.1`.
  - `onnxruntime-node` and `protobufjs` sit in `pnpm.ignoredBuiltDependencies` (Transformers.js runs WASM/JS CPU fallback locally).
  - `postgres: ^3.4.9` remains a root production dependency due to the 96 files still referencing `core/db`.
- **CI Definition (`.github/workflows/ci.yml`):**
  - Spins up `pgvector/pgvector:pg16` on port `5432`, runs `pnpm install --frozen-lockfile`, `tsc --noEmit`, `brand.test.ts`, `knowledge/obsidian/parser.test.ts`, `pnpm agents:validate`, applies `supabase-roles.sql`, runs `python3 galaxy/build.py`, and executes `pnpm test` (`vitest.config.ts` matches ALL `**/*.test.ts`).
  - **Local Impact:** Without Docker/Postgres running on `:5432`, running bare `pnpm.cmd test` executes 42+ legacy `tests/phase-*` + `apps/web` DB tests that fail with `ECONNREFUSED 127.0.0.1:5432`, while OS3 verification must target `tests/os3-*` (`18` files). *(Inferred & verified against prior `KNOWN_LIMITATIONS.md` and CI config; live test run was excluded from this read-only audit phase.)*

---

## 7. Unresolved Questions

1. Which of the 96 `core/db`-importing CLI/domain files should be refactored onto `VaultEngine + SqliteRuntimeDb` vs explicitly retired behind `apps/web/` / legacy rollback markers?
2. Should `tech/trace/server.ts` (`:8787`) be migrated from PostgreSQL to SQLite/Vault and merged into `:8077` (or remain a separate DAW/Audio intake listener)?
3. When should `officialFolderofXYP3RNOS` retire legacy `postgres` CI requirements in `.github/workflows/ci.yml` or split `test:os3` vs `test:legacy` scripts?
