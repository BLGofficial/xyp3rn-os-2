# XYP3RN Agentic OS 2 — Developer Documentation

> **Style note:** The request template left *Style* and *Audience* blanks. This document is written as a **README/Wiki-style, developer-facing** reference (Markdown, single source of truth). It consolidates what lives across `README.md`, `docs/ARCHITECTURE.md`, `docs/AGENT_CLASSES.md`, `docs/NAMING.md`, `docs/SCHEMA.md` and the source trees into one onboarding/reference document. Where this prose and `core/contracts/taxonomy.ts` disagree, **the code wins**.

XYP3RN Agentic OS 2 ("the OS") is a six-domain **agent operating system**: a runtime that turns declarative `.agent.md` files plus YAML workflow specs into executed, logged, traceable work, grounded on a canonical knowledge base and a creative vault, and surfaced through a local single-owner Next.js UI (the "Artist OS").

---

## Table of Contents

1. [Overview](#1-overview)
2. [Installation & Setup](#2-installation--setup)
3. [API Reference](#3-api-reference)
4. [Code Examples](#4-code-examples)
5. [Architecture](#5-architecture)
6. [Error Handling & Troubleshooting](#6-error-handling--troubleshooting)
7. [Contributing Guidelines](#7-contributing-guidelines)
8. [Changelog / Version History](#8-changelog--version-history)

---

## 1. Overview

### Purpose and functionality

The OS is a **monorepo** whose root package *is* the operating system. It coordinates a fleet of narrowly-scoped **agents** across six domains, kept honest by three hard contracts:

- **Capability-based authorization** — tools declare a `<resource>.<verb>` capability; an agent may only use a tool whose capability its class is granted (deny-by-default).
- **Canonical knowledge is write-once through the Promotion Gate** — no agent, workflow, or service other than the gate's service account (`xyp_promotion`) may INSERT/UPDATE `canonical_prompts` or `modules`. Every change is a new version row, never an in-place edit.
- **One `agent_runs` row per dispatch** — failures are logged and returned, never thrown past the caller (the only exception is when the run row itself can't be written).

It is built phase by phase following `XYP3RN_Agentic_OS_Build_Sequence.pdf` (Phase 0 → 17), plus an Artist OS extension (`AOS-00` → `AOS-08`) that adds the Command Center, Studio, and Research UIs.

### Key features

- **Six domains** with least-privilege database roles (`xyp_*`) and Row-Level Security policies: `CORE`, `KNOWLEDGE`, `RESEARCH_INTELLIGENCE`, `RECORDS`, `TECH`, `GOVERNANCE`.
- **Eight agent classes** defined once in `core/contracts/taxonomy.ts`: `Research`, `Knowledge`, `Planning`, `Creative`, `Critic`, `Revision`, `Execution`, `Governance`.
- **Agent Registry** — agents are human-readable Markdown files with YAML frontmatter (`agents/*.agent.md`); nothing is loaded dynamically.
- **Tool Registry + authorization matrix** — `core/tool-registry/capabilities.ts` is the enforced copy of `docs/AGENT_CLASSES.md`.
- **Context Engine** — query → ranked, fully **traceable** context bundle: vector similarity (`gte-small`) plus a 1-hop Knowledge Graph expansion, each result carrying a human-readable `why` and its source row.
- **Workflow Engine** — declarative YAML DAGs of agents; data flows between steps only via explicit `{ $from: ... }` bindings; every problem is reported at once before anything runs.
- **Knowledge Promotion Gate (6D)** — the only canonical writer; a nine-step state machine (`candidate → … → propagation`) that evaluates evidence, freshness, model/version tagging, controlled experiments, and confidence, then routes to `blocked` / `rejected` / `pending_approval` / `promoted`.
- **Research Intelligence** — 20 grounded-evidence specialists run one program; every claim quotes its passage verbatim, checked against kept page text.
- **X3LIUS Music System** — ten creative sub-domains (Songwriting, Lyrics, Vocal DNA, Composition, Arrangement, Genre/Style, Suno, Production, Mix/Master, Evaluation) plus Records ops (catalog, rights splits, release calendar) and a Creative Vault.
- **TRACE service (Phase 14)** — `trace.analysis/v1` in, `trace.report/v1` out, with one definition of a check and JSON Schemas for the plugin.
- **Local single-owner Next.js UI** (Artist OS) — Command Center, Studio, Research, Graph, and HUD, on `127.0.0.1:3100`.

### Use cases

- **Grounded AI-music knowledge building** — ingest first-party docs, run specialist research, promote verified rules into canonical prompts that downstream creative agents consume.
- **Creative production** — brief → songwriting/lyrics → style recipe + tag set → Suno-ready package → submission → take capture → owner rating, every attempt traced to its exact lyric/style/tags/workflow-sha/audio-sha.
- **Catalog & rights management** — register releases/tracks, enforce split sums of exactly 100 (with explicit unassigned shares), assign ISRC/UPC, schedule releases behind a rights check.
- **Mix/master quality gating** — a TRACE analysis checked against a canonical rubric, with no auto-approval (owner decides, F35 D2).
- **Local observability** — the HUD and Graph views, source-backed entities/edges, and a safe repository file viewer.

---

## 2. Installation & Setup

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | **≥ 22** (`engines.node >= 22`) | Native TypeScript type stripping; no build step for `core/*` |
| pnpm | latest | Workspace package manager |
| Postgres | **16** + **pgvector** | Provisioned locally by `pnpm db:setup` (Debian/Ubuntu; idempotent) |
| Git | any | For clones and phase handoffs |

> The root `package.json` is the OS itself; `apps/*` are user interfaces. `pnpm-workspace.yaml` globs `apps/*` only.

### Dependencies

Runtime deps (root `package.json`):
- `@anthropic-ai/sdk` — native Anthropic Messages transport.
- `@huggingface/transformers` — local `gte-small` embeddings (downloads to `.local-models/` on first use).
- `postgres` — Postgres client, parameterized queries.
- `unpdf` — PDF text extraction during ingestion.
- `yaml` — workflow / manifest parsing.
- `typescript-api` (pinned `typescript@5.9.3`) — used by some tooling.

Dev deps: `typescript@^7`, `vitest@^5`, `@types/node@^26`.

`apps/web` adds Next.js 15.5.27, React 18.3.1, Tailwind 3.4.17, and fontsource packages. Its `pnpm` override pins Next's transitive PostCSS to `8.5.28`.

### Installation steps

```sh
# 1. Install workspace packages
pnpm install

# 2. Provision a local Postgres 16 + pgvector + emulated Supabase roles
pnpm db:setup      # Debian/Ubuntu; idempotent

# 3. Apply migrations (Phase 1+ schema)
pnpm db:up

# 4. Ingest the build-sequence PDF (Phase 2)
pnpm ingest --file XYP3RN_Agentic_OS_Build_Sequence.pdf --origin first_party

# 5. Build embeddings for the knowledge index (Phase 3)
pnpm embed

# 6. (Optional) Validate the agent registry and try a dispatch
pnpm agents:validate
pnpm dispatch health-check '{"ping":"xyp"}'

# 7. (Optional) Build & run the web UI
pnpm web:build
XYP_WEB_TOKEN=... pnpm web        # serves on 127.0.0.1:3100
```

> **Cloud sessions:** `scripts/session-start.sh` (the `SessionStart` hook in `.claude/settings.json`) runs steps 2–5 automatically — DB, migrations, guide + X3LIUS manifest ingest, and embeddings.

### Configuration

Copy `.env.example` → `.env` (never committed). Variables are `UPPER_SNAKE`, prefixed `XYP_`, and **nothing loads `.env` automatically** — the process environment is read at runtime.

| Variable | Default | Purpose |
|---|---|---|
| `XYP_DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5432/postgres` | DB connection (local cluster from `supabase/local/setup.sh`). |
| `OPENROUTER_API_KEY` / `GROQ_API_KEY` / `ANTHROPIC_API_KEY` | — | LLM provider keys (Phase 8+). An agent's frontmatter `model` picks the provider; only that provider's key is needed. |
| `SUNO_API_KEY` / `SUNO_CALLBACK_URL` | — | Suno reseller adapter (`sunoapi`); the `manual` adapter needs nothing. |
| `XYP_TRACE_TOKEN` | — | **Required** for `pnpm trace:serve` (≥16 chars). Also `XYP_TRACE_HOST` (default `127.0.0.1`), `XYP_TRACE_PORT` (default `8787`). |
| `XYP_OWNER` | `owner` | Default approver name for vault artifact decisions. |
| `XYP_WHISPER_URL` / `XYP_KOKORO_URL` | — | Optional browser transcription / local read-back services. |
| `XYP_VAULT_DIR` | `.vault/` at repo root | Byte store for Creative Vault files. |

LLM engine override: `LLM_ENGINE=claude-code` routes Anthropic agents through the owner's logged-in Claude Code CLI (subscription) instead of the API.

---

## 3. API Reference

All `core/*` modules are **functional**: exported camelCase functions, PascalCase types, `UPPER_SNAKE` constants, run under Node 22 native type stripping with the explicit `.ts` extension. Import with the `.ts` suffix.

### 3.1 Agent Registry — `core/agent-registry/`

**`createAgentRegistry({ dir })`**
- `@param dir` — absolute path to the `agents/` directory.
- `@returns` — an `AgentRegistry` with:
  - `get(name): AgentDefinition | undefined`
  - `validateAll(): readonly { path, errors }[]` — validates every non-template file; reports unknown keys, class/domain outside the taxonomy, unregistered tools, etc.
  - `snapshot(): { agents, skipped }` — loaded agents and skipped `_`-prefixed templates.

**`parseAgentFile(path): AgentDefinition`** — parses one `*.agent.md` (frontmatter `name`, `class`, `domain`, `tools`, `model`). The registry **rejects unknown keys** so a typo never silently disables a field.

### 3.2 Orchestrator — `core/orchestrator/`

**`dispatch(deps, agentName, input, options?): Promise<DispatchResult>`**
Single-agent execution.
- `deps: DispatchDeps` — `{ sql, registry, tools, handlers, llmRunner? }`.
- `agentName` — registry name.
- `input` — JSON stored immutably on the `agent_runs` row.
- `options` — `{ timeoutMs? (default 30000), workflowRunId?, stepId?, researchRunId? }`.
- `@returns` — `{ runId, status: 'success' | 'error', output?, error?, latencyMs }`.

**Types:**
- `AgentContext` — `{ runId, agent, signal, useTool(name, args), log(level, message) }`. `useTool` is the **only** way a handler reaches a tool (declared-in-frontmatter check + authorization, every call).
- `AgentHandler` — `(ctx, input) => Promise<{ output, tokensUsed? }>`.
- `LlmRunner` — an `AgentHandler` for LLM-backed agents (`model !== 'none'`).
- `DEFAULT_TIMEOUT_MS = 30_000`; `RUNTIME_ROLE = 'xyp_runtime'`.

**`router` / `route-cli.ts`** — domain routing decision with evidence. `pnpm route "request"`.

**`ask` / `ask-cli.ts` & `ask.ts`** — the **front door**: `route → plan → run the domain entrypoint` (research, X3LIUS sub-domains, tech). `formatReply(plan, outcome?)` builds a bounded (≤600 char) plain-text reply from the real plan/result only — no raw error text (it can carry model output or provider detail). `refsOf(outcome)` lifts run/artifact/approval UUIDs out of step outputs.

### 3.3 Context Engine — `core/context-engine/`

**`createContextEngine(sql, embedder): ContextEngine`**
- `retrieve(query, opts?)` —
  - Default (`KnowledgeRetrieveOptions`): `retrieve(query, { limits?: RankLimits, scope?: ContextScope })` → `ContextBundle` (`{ query, scope, model, generation, cache: 'hit'|'miss', items, diagnostics }`).
  - Vault corpus: `retrieve(query, { corpus: 'vault', limit? })` → `VaultBundle`.
- `claims(topicPrefix)` — exact lookup of current canonical claims by topic prefix (no vectors).

Key constants: `DEFAULT_LIMITS = { direct: 8, expanded: 4 }`, `CACHE_MAX_ENTRIES = 256`, `CACHE_TTL_MS = 900_000`, `CONTEXT_ROLE = 'xyp_runtime'`. The cache key includes a **knowledge `generation`** (row count + newest write of canonical tables/relations) so a cached bundle can never outlive the knowledge it was built from; Vault-only file adds leave the generation unchanged.

`ContextItem` carries `ref`, `slug`, `title`, `snippet`, `text`, `domain`, `modelTag`, `score`, `reasons`, `why`, and `source` (its ingested source row).

**`rankContext(hitRefs, edges, limits): Ranked`** — pure ranking used by the engine. `PREDICATE_WEIGHTS` lives in `rank.ts`; unweighted predicates are skipped and reported in `diagnostics.skippedPredicates`.

### 3.4 Workflow Engine — `core/workflow-engine/`

**`runWorkflow(deps, wf, input, options?): Promise<WorkflowResult>`**
- Opens a `workflow_runs` row (with `spec_sha256`), topologically orders steps, resolves each step's input bindings (`{ $from: 'input.<k>' }` or `{ $from: 'steps.<id>.output[.<path>]' }`), dispatches each as a step, then resolves the spec's `output`. On failure, records `failed_step`, `error_detail`, and `skipped_steps` (everything downstream of the failure). Optional inputs left absent bind as `null`.
- `options` — `{ timeoutMs?, researchRunId?, log? }`.

**`loadWorkflow(path, registry): LoadedWorkflow`** — reads + validates a YAML spec, computes `sha256`.
**`hasLlmSteps(wf, registry): boolean`** — whether any step agent is LLM-backed (selects the 1.8M LLM timeout).
**`parseWorkflowSpec(yaml, agents: ReadonlySet<string>): SpecResult`** — `{ ok: true, spec } | { ok: false, errors }`. Validates kebab-case name, step ids, dependsOn integrity, cycles, `$from` reference reachability, and that every `agent` is registered.

Workflow spec shape (`WorkflowSpec`): `name`, `description`, `requiredInput`, `optionalInput`, `steps[]`, `output`. Step shape: `{ id, agent, dependsOn[], input }`.

### 3.5 Tool Registry — `core/tool-registry/`

**`createRuntimeTools({ sql, vault? }): ToolRegistry`**
- `authorize(class: AgentClass, toolName): { allow: boolean, reason: string }` — consults `CLASS_CAPABILITIES` (deny-by-default).
- `get(name)` — the tool's `{ handler, capability }`.

**Capabilities** (`core/tool-registry/capabilities.ts`, enforced list `CAPABILITIES`): `context.read`, `log.write`, `web.read`, `research.write`, `research.read`, `candidate.propose`, `plan.write`, `artifact.write`, `artifact.read`, `critique.write`, `critique.read`, `catalog.read`, `catalog.write`, `trace.write`, `vault.write`, `vault.read`, `task.write`, `feedback.write`, `external.execute`, `governance.flag`, `canonical.write` (gate only), `approval.decide` (humans only), `audit.write` (triggers only). `isCapability(value)` guards unknown ids.

### 3.6 Database — `core/db/`

**`connect(url?, opts?): Sql`** — `postgres` client (parameterized; injection-safe templates). `opts` includes `max` (pool size).
**`core/db/cli.ts`** — `up | down [steps|all] | status` against `XYP_DATABASE_URL`. Rollbacks live in `supabase/rollbacks/` so the Supabase CLI never applies them forward. (23 migrations currently.)

### 3.7 LLM layer — `core/llm/`

**`createLlmRunner({ programs, env, fetch? }): LlmRunner`** — dispatches an LLM agent to its registered `LlmProgram` and a client bound to its frontmatter `model`. An LLM agent without a registered program fails with that reason (no generic tool-loop improvisation).
**`createLlmClient({ model, agentName, env, fetch? }): LlmClient`** — provider-agnostic. `complete(req): Promise<LlmResponse>` where `req = { system, user, schema, maxTokens?, signal? }`. Every reply is parsed and validated against `req.schema` locally.
**`parseModelRef(ref): ModelRef`** — `anthropic:<id>`, `groq:<id>`, `openrouter:<vendor>/<id>`, or bare `claude-*`. Throws for `none`, unknown provider, or empty model.
**`PROVIDERS`** — `anthropic` (pinned base URL), `groq`, `openrouter`. Retries transient errors (408/429/5xx) with `[2000, 6000] ms` delays. `LLM_TIMEOUT_MS = 1_800_000` (used for LLM-backed steps).

### 3.8 Knowledge Promotion Gate — `knowledge/promotion-gate/`

**`runGate(sql, candidateId): Promise<GateResult>`** — runs a Research Intelligence candidate through the nine-step state machine. Returns `{ outcome: 'blocked'|'rejected'|'pending_approval'|'promoted', steps, reasons, promotionRunId, approvalId?, canonicalPromptId?, version? }`.
**`admitFirstParty(tx, admission: FirstPartyAdmission): Promise<{ stats, promotionRunId }>`** — operator-authored first-party document admission (the F1 successor), run inside an ingestion transaction that already holds `CANONICAL_WRITE_LOCK_KEY`. `FirstPartyAdmission = { doc, sourceId, ingestionRunId, kind, origin, normalizer, asOf }`. Requires `origin: first_party`; throws `FIRST_PARTY_ADMISSION_ERROR` otherwise. (In practice first-party material enters via `pnpm ingest --origin first_party`, which calls this; third-party material is refused and must go through Research Intelligence → `runGate`.)
**`decideQueueItem(sql, approvalId, decision, approver, reason)`** — operator decision; re-runs a knowledge candidate through the gate, or records a critique escalation (Phase 12).
**`pendingApprovals(sql)`** — pending human approvals with the gate's reasons.

Decision rule (`decide.ts`): precedence **blocked** (open contradiction) → **rejected** (inconsistent model/version tags) → **human** (everything else; since F35 D2 *nothing* auto-approves — the threshold is shown as a reason). Constants: `AUTO_APPROVE_CONFIDENCE = 0.8`, `SOURCE_MAX_AGE_DAYS = 180`, `GATE_STEPS` (the nine steps).

### 3.9 Knowledge — ingestion, embeddings, graph

**`ingestSource(sql, input): Promise<IngestResult>`** (`knowledge/ingestion/ingest.ts`) — input `{ kind: 'file'|'url'|'manual', ... , origin: 'first_party'|'third_party' }`. Since 6D only `first_party` is admitted through the gate; `third_party` is recorded as an **error run** (third-party material enters as research evidence instead).
**`embedPending(sql, embedder)` / `embedVault(sql, embedder)`** (`knowledge/vector-retrieval/pipeline.ts`) — embed every row whose input changed (knowledge index, then vault corpus).
**`loadEmbedder()`** — loads `gte-small` (`@huggingface/transformers`); downloads to `.local-models/` on first use.

**Knowledge Graph CLI** (`knowledge/knowledge-graph/cli.ts`) — `pnpm index scan [--full]` (AOS-04 C1: scans the checkout + Vault, agents, workflows, decisions, imports, links as source-backed entities/edges) and `pnpm index status`.

### 3.10 Records (X3LIUS) & Tech

- **Vault CLI** (`records/vault/cli.ts`) — `add`, `edit`, `approve`/`reject` (artifact decisions), `export`/`import` (`xyp-vault-export/v1`), `song create|revise|link|unlink`. Exit codes: `2` usage, `1` refused/failed (the run row records why).
- **Studio CLI** (`records/x3lius/studio/cli.ts`) — `export <packageId> [--text]` → `xyp-suno-package/v1` as JSON or copy-paste blocks for Suno's form; read-only as `xyp_web`.
- **TRACE service** (`tech/trace/serve-cli.ts`) — `startTraceServer({ deps, token, host, port, log })` serves `POST /v1/trace/analyses`, `GET /v1/trace/analyses/:id`, `GET /v1/trace/health`. `trace:schemas` regenerates `tech/trace/schemas/*.schema.json` from the contract.
- **Research CLI** (`research-intelligence/cli.ts`) — `pnpm research <cmd> '<json>'` for the 6C engines (observation, cite, finding, candidate, eligibility, resolve, experiment:*), plus `ask`, `decide`, `promote`, and `specialists:table`.

### 3.11 CLI command surface (quick index)

| Command | Purpose |
|---|---|
| `pnpm install` | Install workspace deps |
| `pnpm db:setup` / `db:up` / `db:down` / `db:status` | Local Postgres + pgvector; migrations |
| `pnpm ingest --file\|--url\|--manual --origin` | Ingest a source (first_party only admitted) |
| `pnpm embed` | Build/refresh embeddings |
| `pnpm context "query" [--json] [--vault]` | Ranked, traceable context bundle |
| `pnpm agents:validate` | Validate `agents/*.agent.md` |
| `pnpm dispatch <agent> '<json>'` | Run one agent end-to-end |
| `pnpm route "request"` | Domain routing decision |
| `pnpm ask "request"` | Front door: route → plan → run |
| `pnpm workflow <spec.yaml> '<json>'` | Run a workflow DAG |
| `pnpm research <cmd> '<json>'` | 6C research engines |
| `pnpm gate run\|queue\|decide` | Promotion Gate operator access |
| `pnpm index scan\|status` | Knowledge Graph / file index |
| `pnpm vault ...` / `pnpm studio export` | Creative Vault / Suno packages |
| `pnpm trace:serve` / `trace:schemas` | TRACE service / schema regen |
| `pnpm test` / `pnpm typecheck` | vitest; `tsc --noEmit` |
| `pnpm web` (filter) | Next.js UI on `127.0.0.1:3100` |

---

## 4. Code Examples

### 4.1 Basic usage — run an agent from the CLI

```sh
# Health-check agent (deterministic, model: none)
pnpm dispatch health-check '{"ping":"xyp"}'

# Retrieve a ranked, traceable context bundle
pnpm context "what is the Suno v5 structure convention" --json
```

### 4.2 Basic usage — dispatch programmatically

```ts
import { join } from 'node:path';
import { createAgentRegistry } from './core/agent-registry/registry.ts';
import { connect } from './core/db/client.ts';
import { HANDLERS } from './core/runtime/handlers.ts';
import { createRuntimeLlmRunner } from './core/runtime/programs.ts';
import { createRuntimeTools } from './core/runtime/tools.ts';
import { dispatch } from './core/orchestrator/dispatch.ts';

const registry = createAgentRegistry({ dir: join(import.meta.dirname, 'agents') });
const sql = connect(undefined, { max: 2 });
try {
  const result = await dispatch(
    { sql, registry, tools: createRuntimeTools({ sql }), handlers: HANDLERS, llmRunner: createRuntimeLlmRunner() },
    'health-check',
    { ping: 'xyp' },
    { timeoutMs: 30_000 },
  );
  console.log(result.status, result.latencyMs, result.output);
} finally {
  await sql.end();
}
```

### 4.3 Common scenario — research → promote → consume

```sh
# 1. Run a live research brief (20 specialists on the OpenRouter free route)
pnpm research ask '{"projectSlug":"suno-v5","question":"...","intendedUse":"...","urls":["https://..."]}'

# 2. Accept a finding into the Findings Library, then promote it to canonical
pnpm research decide <findingId> accept "reason"
pnpm research promote '{"findingId":"...","proposed_kind":"canonical_prompt","target_slug":"x3lius-suno","title":"...","body":"...","domain":"RECORDS"}'

# 3. Gate decides; if pending, the operator approves
pnpm gate queue
pnpm gate decide <approvalId> approve "owner" "verified"

# 4. Downstream creative agents now ground on the promoted rule via the Context Engine
pnpm dispatch x3lius-suno-package '{"...request..."}'
```

### 4.4 Common scenario — a declarative workflow

```yaml
# records/workflows/register-track.workflow.yaml
name: register-track
description: Catalog lookup (Knowledge) then catalog write (Execution)
input:
  required: [takeId, release]
  optional: [title, position]
steps:
  - id: lookup
    agent: records-catalog-lookup
    input: { takeId: { $from: input.takeId } }
  - id: register
    agent: records-catalog
    dependsOn: [lookup]
    input:
      takeId: { $from: input.takeId }
      release: { $from: input.release }
      position: { $from: input.position }
output: { $from: steps.register.output }
```

```sh
pnpm workflow records/workflows/register-track.workflow.yaml '{"takeId":"<uuid>","release":{"title":"...","artist":"X3LIUS","kind":"single"},"position":1}'
```

### 4.5 Advanced — write a new deterministic agent

1. Copy `agents/_template.agent.md` → `agents/my-agent.agent.md`.
2. Fill frontmatter (must match filename stem): `name`, `class`, `domain`, `tools`, `model: none`.
3. Register a handler in `core/runtime/handlers.ts` (`HANDLERS['my-agent'] = myHandler`).
4. Validate and run:

```sh
pnpm agents:validate
pnpm dispatch my-agent '{"...input..."}'
```

The handler signature:

```ts
import type { AgentContext, AgentHandler } from '../core/orchestrator/dispatch.ts';

export const myHandler: AgentHandler = async (ctx, input) => {
  ctx.log('info', `running with ${JSON.stringify(input)}`);
  // Read-only context pull (capability context.read is always granted):
  const bundle = await ctx.useTool('retrieve_context', { query: '...' });
  // ... deterministic work ...
  return { output: { ok: true } };
};
```

### 4.6 Advanced — Context Engine with a scoped sub-domain path

```ts
const engine = createContextEngine(sql, await loadEmbedder());
// Restrict retrieval to a module's current canonical prompts + graph expansion inside its scope:
const bundle = await engine.retrieve('suno style guardrails', {
  scope: { modules: ['x3lius-suno'] },
});
// Keep rules to a model version:
bundle.items.filter((i) => i.modelTag === 'suno-v5');
```

---

## 5. Architecture

### Design patterns used

- **Functional core, no OOP** — pure functions over data; no classes, enums, or namespaces (`erasableSyntaxOnly`). Exported functions carry JSDoc. This keeps agents/tests deterministic and the runtime auditable.
- **Registry pattern (Agents & Tools)** — declarative definitions (`agents/*.agent.md`, tool modules) assembled at boot; nothing is dynamically `require`d. The Agent Registry rejects unknown frontmatter keys.
- **Capability-based authorization matrix** — a single source of truth (`capabilities.ts`) maps `<resource>.<verb>` → allowed classes; `authorize(class, tool)` is deny-by-default and called on *every* tool access, including inside `AgentContext.useTool`.
- **Single-responsibility domains + least-privilege roles** — each domain owns specific tables and connects under its own `xyp_*` role (e.g. `xyp_research` INSERT-only on evidence/findings). RLS policies are granted only to named `xyp_*` roles, never `anon`/`authenticated`/`public`.
- **Canonical-vs-proposed separation** — research writes `knowledge_candidates` (status `proposed` only); the **Promotion Gate** is the sole canonical writer, appending version rows. This makes every canonical change auditable and reversible-by-version.
- **Ranked, traceable retrieval** — vector similarity *plus* a 1-hop Knowledge Graph expansion, each item annotated with `why` and its `source` row; results are cached by a knowledge `generation` so staleness is impossible.
- **Declarative workflow DAG** — YAML specs with explicit `$from` data bindings; full static validation before any execution; topological ordering with deterministic tie-breaking.
- **Fail-soft dispatch** — exactly one `agent_runs` row per call, always closed `success`/`error`; timeouts abort via `AbortController`; transient provider errors retried with fixed backoff; no agent-level retries (idempotency of side-effecting Execution is unsolved).

### Key components and their relationships

```
                         ┌────────────────────────────┐
   request ──► ask ─────►│  Orchestrator (CORE)        │
            (route→plan) │  router · dispatch · ask   │
                         └─────────────┬──────────────┘
                                       │  dispatch(agent, input, opts)
                  ┌────────────────────┼─────────────────────┐
                  ▼                    ▼                     ▼
        ┌────────────────┐   ┌──────────────────┐   ┌──────────────────┐
        │ Agent Registry │   │  Tool Registry   │   │  Workflow Engine │
        │ (agents/*.md)  │   │  + authorize()   │   │  (YAML DAG)      │
        └────────────────┘   └────────┬─────────┘   └──────────────────┘
                                       │ useTool(name, args)  [checked + authorized]
                  ┌────────────────────┼─────────────────────┐
                  ▼                    ▼                     ▼
        ┌────────────────┐   ┌──────────────────┐   ┌──────────────────┐
        │ Context Engine │   │  LLM Runner      │   │  Domain agents   │
        │ (vector+graph) │   │  (anthropic/     │   │  (8 classes)     │
        └────────┬───────┘   │   groq/openrouter)│   └────────┬─────────┘
                 │           └──────────────────┘            │
   ┌─────────────┼───────────────────────────────────────────┘
   ▼             ▼
Knowledge Layer (canonical_prompts/modules, sources, relations, embeddings,
                 Knowledge Graph, Promotion Gate)  ◄── Research Intelligence
                                                    (evidence → candidates → gate)
Records (X3LIUS creative + ops + Vault) · Tech (TRACE, R&D) · Governance (approvals, audit)
```

- **Orchestrator** decides *how* work runs (routing, dispatch, workflows, telemetry) but never *what* the content is; it reads canonical knowledge only through the Context Engine.
- **Context Engine** (CORE) calls Knowledge's Vector Retrieval and Knowledge Graph for raw similarity/edges; ranking, `why` reasons, and caching live in CORE.
- **Promotion Gate** is the only writer of canonical knowledge; Research can only propose.
- **Every agent run** emits one `agent_runs` row (input, output, tokens, latency, status, error) — the backbone of observability and audit.

### Data flow

1. **Request intake** — `ask` routes the request to a domain entrypoint (research / X3LIUS sub-domain / tech) using evidence, then plans and runs it.
2. **Agent execution** — `dispatch` resolves the agent, authorizes every declared tool, executes (deterministic handler or LLM program) under a timeout, and writes the `agent_runs` row.
3. **Tool use** — an agent reaches the world only through `useTool`, which re-checks declaration + capability authorization, then runs the tool handler (e.g. `retrieve_context` → Context Engine).
4. **Retrieval** — query → embed (`gte-small`) → `xyp_match_knowledge` (vector) + 1-hop `relations` expansion → `rankContext` → cached `ContextBundle` with `why` + source.
5. **Knowledge promotion** — Research writes `knowledge_candidates` (`proposed`); `runGate` evaluates evidence/freshness/tags/experiments/confidence; on `promoted`, the gate appends a new `(slug, version)` row + `knowledge_versions` history (service role `xyp_promotion`).
6. **Creative production** — X3LIUS agents pull canonical rules/claims through the Context Engine, write versioned schema-validated `creative_artifacts`, and every generation attempt is traced to its lyric/style/tags/workflow-sha/audio-sha.
7. **Observability** — `agent_runs`, `workflow_runs`, `research_runs`, `promotion_runs`, and the Graph/audit views surface all of the above; raw error text is deliberately excluded from user-facing replies.

---

## 6. Error Handling & Troubleshooting

### Common errors

| Symptom / message | Cause | Fix |
|---|---|---|
| `usage: cli.ts <agent-name> '<json input>'` (exit 2) | Missing CLI argument | Provide the agent name and a JSON string. |
| `agent not in registry: <name>` / `agent failed registry validation` | Agent file missing, misnamed, or has unknown frontmatter keys / bad class/domain / unregistered tool | Run `pnpm agents:validate`; ensure filename stem == `name`; check `docs/AGENT_CLASSES.md`. |
| `tool authorization denied: <tool>: <reason>` | Agent's `tools` list or class lacks the capability | Narrow/widen per the capability matrix; remember three capabilities (`canonical.write`, `approval.decide`, `audit.write`) are unobtainable by agents. |
| `no handler registered for deterministic agent <name>` | `model: none` agent absent from `HANDLERS` | Add the handler in `core/runtime/handlers.ts`. |
| `LLM runner unavailable: no LLM runner configured (agent uses model <m>)` | No `llmRunner` passed, or no program for the agent | Pass `createRuntimeLlmRunner()`; register an `LlmProgram` for the agent. |
| `model "<m>" is not <provider>:<model> ...` | Bad `model` frontmatter | Use `anthropic:<id>`, `groq:<id>`, `openrouter:<vendor>/<id>`, or bare `claude-*`. |
| `first-party admission requires origin first_party` | `ingest` with `third_party` since 6D | Ingest third-party material as research evidence, not through the gate. |
| `OPENROUTER_API_KEY`/`GROQ_API_KEY`/`ANTHROPIC_API_KEY` missing | Provider key not in environment | The agent's `model` picks the provider; set only that provider's key. Nothing loads `.env` automatically. |
| `XYP_TRACE_TOKEN` missing / invalid | `trace:serve` without a ≥16-char token | Set `XYP_TRACE_TOKEN` in the process environment. |
| `timeout after <n>ms` | Run exceeded `timeoutMs` (30s deterministic; 1.8M LLM) | Raise `timeoutMs`; check provider upstream idle limits (OpenRouter 120s ends stalled calls). |
| `candidate <id>: finding <fid> has no evidence` / `source <sid> has no reliability score` | Broken research invariants | Ensure 6C recorded scored evidence before promoting. |
| Split-sum / unassigned-share errors (Phase 13) | A split set must sum to exactly 100; an unassigned share is an explicit `null`-payee row that blocks scheduling | Fix shares; assign or keep the explicit unassigned row intentionally. |
| `context scope: modules must be a non-empty list of module slugs` | Bad `scope.modules` | Pass valid kebab-case slug(s). |

### Troubleshooting guide

1. **Start clean:** `pnpm db:status` → ensure migrations applied (`pnpm db:up`). A fresh checkout needs `pnpm db:setup` once.
2. **Validate definitions:** `pnpm agents:validate` catches most dispatch-time registry errors before they happen.
3. **Trace a run:** `pnpm dispatch <agent> '<json>'` prints the full trace — registry pickup → validation → authorization → execution → the `agent_runs` row (including `error_detail` and `logs`).
4. **Check retrieval:** `pnpm context "query" --json` shows `diagnostics` (vector hits, edges considered, skipped predicates/entity types) — useful when results look thin.
5. **Gate stalls:** `pnpm gate queue` shows pending approvals and the gate's reasons; `pnpm gate decide <id> approve|reject "approver" "reason"` then re-run the gate.
6. **Workflow failures:** `runWorkflow` records `failed_step`, `error_detail`, and `skipped_steps`. Use `pnpm workflow <spec> '<json>'` to see the `workflow_runs` row and per-step `agent_runs`.
7. **Web UI not loading:** `pnpm web` binds `127.0.0.1:3100`; ensure `XYP_WEB_TOKEN` is set for `start`. Build first with `pnpm web:build` if serving production.
8. **Provider errors:** transient 408/429/5xx are retried automatically; persistent ones surface as `providerError`. Verify the key and that the model id is valid for that provider.
9. **Tests:** `pnpm test` (vitest; DB tests use throwaway databases) and `pnpm typecheck` (`tsc --noEmit`) are the gate before any commit.

---

## 7. Contributing Guidelines

This is an open-source, contract-driven monorepo. Contributions that change behavior must preserve the three hard contracts (capability authorization, gate-only canonical writes, one `agent_runs` row per dispatch) and follow the naming conventions.

### Workflow

1. **Branch** from `main`; keep changes focused and phase-aligned (see `docs/handoffs/`).
2. **Add/modify agents** via `agents/*.agent.md` using `agents/_template.agent.md`. Rules:
   - `name` == filename stem; kebab-case. `_`-prefixed files are templates and are never loaded.
   - `class` is exactly one of the eight; `domain` exactly one of the six (defined in `core/contracts/taxonomy.ts`).
   - `tools` can only *narrow* the class, never widen it; each tool declares exactly one capability.
   - `model` is `none` (deterministic) or a provider-prefixed id.
3. **Register deterministic handlers** in `core/runtime/handlers.ts` (`HANDLERS`); register LLM programs in `core/runtime/programs.ts`. Nothing is loaded dynamically.
4. **Naming** (`docs/NAMING.md`): kebab-case files/CLI, PascalCase types, camelCase functions, `UPPER_SNAKE` constants; tables are plural snake_case; foreign keys `<singular>_id`; migrations `<YYYYMMDDHHMMSS>_<snake>.sql` + matching `supabase/rollbacks/*.down.sql`.
5. **Capabilities:** a new capability is added to **both** `core/tool-registry/capabilities.ts` and `docs/AGENT_CLASSES.md` in the same phase — never granted implicitly (`tests/phase-04c` fails on drift).
6. **Tests:** colocate unit tests as `<module>.test.ts`; phase acceptance proofs go in `tests/phase-<NN>[<sub>]/`. Run `pnpm test` and `pnpm typecheck`.
7. **Flagged decisions:** anything unsettled (e.g. the `AUTO_APPROVE_CONFIDENCE` threshold) is a contract change tracked in `docs/ARCHITECTURE.md#flagged-decisions` — discuss before editing, never silent.
8. **Handoffs:** record phase work per the Appendix A template in `docs/handoffs/`.

### Code style

- Functional TypeScript, no classes/enums/namespaces; explicit `.ts` imports; JSDoc on exported functions.
- DB access only through parameterized `postgres` templates; never string-concatenate SQL.
- Agents are read-only where their class forbids mutation; writes go through agents + the gate, never ad-hoc.

---

## 8. Changelog / Version History

The OS is versioned by **build phase**, not semver (root `version: 0.0.0`). Each phase is a contract milestone; handoffs live in `docs/handoffs/`.

**Phase 0 — Foundation / Contracts.** Six domains, eight agent classes, taxonomy, naming, capability matrix, agent-file format.

**Phase 1 — Supabase canonical data model.** 23 migrations + rollbacks; least-privilege `xyp_*` roles; RLS policies.

**Phase 2 — Knowledge ingestion + normalization.** PDF/file/URL/manual ingest; normalizers; `ingestion_runs`.

**Phase 3 — Retrieval / context engine.** `gte-small` embeddings, vector match, ranked traceable bundles, LRU cache by knowledge generation.

**Phase 4 — Agent runtime + registry (4A–4E).** Orchestrator, Agent Registry, Tool Registry + authorization, dispatch (one `agent_runs` row), LLM runner/providers.

**Phase 5 — Workflow / orchestration engine.** Declarative YAML DAG, `$from` bindings, static validation, topological execution.

**Phase 6 — AI Music Research Intelligence (6A–6D).** 20 specialists, evidence/verify, contradictions, synthesis/findings, experiments; the **Promotion Gate** (nine-step state machine, sole canonical writer).

**Phase 7 — X3LIUS Music Intelligence.** Module + ten sub-domains via a gate-admitted manifest; scoped context paths.

**Phase 8 — Songwriting + Lyrics + Composition.** Live verse via Nemotron/OpenRouter; replaced Phase 7 stubs with Creative agents writing versioned artifacts.

**Phase 9 — Suno Generation System + Genre/Style.** Brief → Suno-ready prompt artifact; `suno-submitter` (Execution) records submissions/takes.

**Phase 10 — Vocal / Artist DNA.** Built and proven on a fixture; awaiting the operator's real Vocal DNA values.

**Phase 11 — Production / Mix / Master.** Built and proven; mix rubric admitted/embedded. Awaiting a live render's `trace.analysis/v1`.

**Phase 12 — Critic + Revision System.** Built and proven on the FAKE model; Critic run live once (converged). Revision not yet live (no admitted lyrics rules to trigger it).

**Phase 13 — XYP3RN Records (Records ops).** `releases`/`tracks`/`rights_splits` (sum-to-100 with explicit unassigned shares that block scheduling); catalog lookup→catalog (F10 split), Rights→calendar; proven on a throwaway DB.

**Phase 14 — XYP3RN Tech.** TRACE service (`trace.analysis/v1` → `trace.report/v1`, JSON Schemas), TECH components via gate-admitted manifest, R&D backlog agent. Proven with the live service; R&D model call not yet run live (no key).

**Phase 15 — Legal / Governance.** *Planned.* Governance approvals (`governance/approvals.ts`) and audit already exist; the legal/rights workflow is the remaining work.

**Phase 16 — UI / Observability / Graph View / Command Center (16A–16D).** *Planned.* `apps/web` (Artist OS) already delivers Command Center, Studio, Research, Graph, and HUD (AOS-00 → AOS-08).

**Phase 17 — End-to-End Validation.** *Planned.*

### Artist OS extension (AOS-00 → AOS-08)

- **AOS-00** Baseline + no-parallel-kernel gate (four decisions taken, F35).
- **AOS-01** Creative Vault + song schema; vault search; byte-identical export/import; first UI.
- **AOS-02** Command Center + catalog; people/credits, tasks, readiness checks, platform links, artwork, delivery.
- **AOS-03** Studio mode; style recipes + tag sets as approved lineages; Suno package export (JSON or copy-paste); take capture + owner rating; generation tracing.
- **AOS-04 Plan A** Research mode (briefs, 20 specialists on OpenRouter free route, Findings Library, gate promotion).
- **AOS-04 Plan B** Mercury shell (graphite/mercury tokens, local fonts, three-column shell, metric strip, Sofia clock).
- **AOS-04 Plan C1** Graph + file index (source-backed entities/edges, search, inspector with "why" on every connection, safe repo file viewer).
- **Jarvis Prompt 01** Mercury sphere + eight areas (Command, Songs & Releases, Workflow Builder, Analytics, System Admin, etc.).
- **Jarvis Prompt 03** *In progress* — source-focused answers, clustering, richer filters.

### Recent engineering audit (2026-10-02)

- Next.js upgraded `14.2.35` → `15.5.27`; async route params/cookies migrated; registry audit went from **27 advisories → zero**.
- Official logo locked and checksum-tested across Mercury/HUD/Galaxy.
- HUD reachable from primary nav; Windows verification repairs; symlink proofs made portable.
- Final suite: **1,587 passed, 2 failed, 14 skipped** (failures/skips tied to Windows symlink fixtures); web smoke + production build green.

---

*Maintained alongside `README.md`, `docs/ARCHITECTURE.md`, `docs/AGENT_CLASSES.md`, `docs/NAMING.md`, and `docs/SCHEMA.md`. When in doubt, the code in `core/contracts/taxonomy.ts` is authoritative.*
