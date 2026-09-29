# Claude Code as the engine: design

Status: approved in conversation, section by section (2026-09-30). This file is the written spec for review before the implementation plan.
Branch: `feat/claude-code-engine`, cut from `main` at `dd98f6a`.

## 1. Intent

Make Mercury a thin control surface over Claude Code running on the owner's Claude Code subscription, in the style of the Chase AI "Claude OS" setup, while keeping every existing agent, domain, workflow, approval and trace.

- Model calls run through the local `claude` CLI instead of the paid API (switchable back).
- Named skills can be started from a Mercury button or by speaking the skill name; they run Claude Code headless in the background, and the actual work still goes through the OS.
- Quick questions about existing data are answered from the database in seconds, without starting a run.
- Open-ended tasks can start a free-form headless Claude Code session, only on an explicit trigger.

Success means: with `LLM_ENGINE=claude-code` and `ANTHROPIC_API_KEY` unset, a research run and a Records run complete end to end; each of the four skills runs from a Mercury button and from dictated text; a tier 2 question answers without creating any run row; a tier 3 task completes, can be cancelled, and returns a resumable session id.

Out of scope: the Obsidian plugin (own spec later, together with the requested section list: Command Center, Song Releases, Studio, Creative Vault, Workflow Builder, Analytics, System Admin, whose source is still to be confirmed); Tech and Governance skills (no entrypoint exists yet); letting any headless run edit files.

## 2. Decisions

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| D1 | Overall approach | Hybrid: swap the engine under the OS, add a skill layer on top (option C) | Engine swap only (A): no skill interaction model. Claude Code as orchestrator (B): largest rewrite, loses the deterministic router and traces |
| D2 | How the engine swap is selected | One env var, `LLM_ENGINE=claude-code`, reroutes all `anthropic` / bare `claude-*` agents | A new `claude-code:` prefix in 44 agent files: large diff, no single switch back |
| D3 | Claude Code tools during engine calls | None. OS agent tools (`retrieve_context`, `fetch_source`, ...) keep running in the OS exactly as today | Letting Claude Code use its own tools inside an agent step: bypasses OS tools, traces and approvals |
| D4 | Structured output | Schema instruction in the prompt (as the Groq/OpenRouter path does) plus existing local validation | Trusting CLI-side structured output alone |
| D5 | Engine call working directory | A neutral scratch directory, so project hooks and style plugins cannot alter agent JSON | Repo root |
| D6 | Skills | Four hand-written project skills; generator deferred until the list grows | Generating skills from the registry now (four files do not justify it) |
| D7 | Skill routing into the OS | New `--domain` / `--workflow` flags on `ask-cli` that skip the keyword router | Re-routing the skill's request through keywords (can land in a different domain) |
| D8 | Tier selection | Deterministic rules; tier 3 only on explicit trigger | A model-based router (Haiku): adds latency and non-determinism to every request |
| D9 | Tier 3 permissions | Read-only tools plus `Bash(pnpm ask:*)`; no Edit/Write | Full permissions or `--dangerously-skip-permissions` |
| D10 | Job state | Existing in-memory `ask-jobs` (single Next process); durable record stays in the run tables, tier 3 keeps the Claude session id | A new jobs table |

## 3. Section 1: engine swap

**Where:** `core/llm/providers.ts`. Every model call already goes through one client `complete(req)` with `system`, `user`, a JSON `schema`, optional `maxTokens` and `signal`.

**Change:**
- Add a `claudeCodeTransport` next to `anthropicTransport` and the OpenAI-compatible transports.
- When `LLM_ENGINE=claude-code`, the client for provider `anthropic` uses `claudeCodeTransport`; no API key is required for it. Groq and OpenRouter agents are unaffected. With the variable unset, behaviour is identical to today.
- One call = one `claude -p` child process:
  - `--model <model id from frontmatter>`
  - `--system-prompt <req.system>` plus the schema instruction (same text as `schemaInstruction`)
  - no built-in tools enabled
  - `--output-format json`; the `result` field is the reply text, which is then parsed and validated by the existing code path
  - arguments passed as an array (`spawn`/`execFile`, no shell); prompt text via stdin where it may exceed argument limits
  - working directory: a neutral scratch directory outside the repo (D5)
  - `req.signal` kills the process
- Reported `model` and token usage come from the CLI's JSON output when present; missing usage is recorded as 0, not guessed.

**Errors (mapped to the existing error types):**
- not logged in / CLI missing: permanent provider error with a clear message
- subscription usage limit or overload: `TransientProviderError` (same retry delays as HTTP 429)
- non-zero exit, empty or non-JSON output: permanent error; raw output is not copied into error text (same rule as today: run ids point to detail)
- timeout: the run's existing dispatch timeout bounds the call

**Known cost:** each agent step spawns a process (a few seconds of overhead). Multi-specialist research runs get slower in wall time; usage counts against the plan's limits instead of API billing.

**Tests:**
- Unit (fake `claude` executable or injected spawn): argument list, cwd, stdin, JSON parsing, validation failure, each error mapping, abort.
- Live smoke: one agent call with `LLM_ENGINE=claude-code` and no API key.

## 4. Section 2: skill layer

**Current state:** `ENTRYPOINTS` (`core/orchestrator/orchestrate.ts`) registers Research (`run-research`) and Records (`x3lius-music-system`). Tech and Governance have none; `pnpm ask` holds those requests.

**Skills** (in the repo under `.claude/skills/<name>/SKILL.md`):

| Skill | Runs |
|---|---|
| `xyp-research` | `pnpm ask --domain RESEARCH_INTELLIGENCE "<request>"` |
| `xyp-music` | `pnpm ask --domain RECORDS "<request>"` |
| `xyp-song-to-suno` | `pnpm ask --workflow song-to-suno "<request>"` |
| `xyp-retrieve-summarize` | `pnpm ask --workflow retrieve-and-summarize "<request>"` |

Each skill: asks for input only if the request cannot run without it; runs its one command; reads the JSON result; replies with the run id and a summary of at most 600 characters (`MAX_REPLY_CHARS`) written to be spoken.

**`ask-cli` change:** `--domain <RoutableDomain>` builds the plan for that domain directly; `--workflow <id>` loads and runs that workflow. Both skip `routeRequest`. Unknown values exit 2 with usage. `planRequest` itself is unchanged.

**Headless launcher:** new `apps/web/lib/claude-headless.ts`:
- `claude -p "/<skill> <text>" --output-format json`, args as an array, cwd = repo root
- only project skills; style plugins (chisle, caveman) and the `session-start.sh` hook disabled for these runs, so spoken replies stay plain sentences (exact flags confirmed during implementation)
- allowed tools: `Bash(pnpm ask:*)`, `Read`; everything else denied
- returns reply text, session id, exit status

**Mercury:**
- `POST /api/ask` also accepts `{ skill, text }`. `skill` must be one of the four names (server-side allowlist); `text` is only ever passed as the skill argument.
- Same session auth, same-origin check and `runtime.execute` permission as today.
- Runs through `ask-jobs` with a new action `skill`; existing polling and the limit of 2 running jobs per user apply.
- Assistant panel: a row of skill buttons with an optional text field.

**Voice tier 1:** dictated or typed text that starts with a skill's spoken name ("research ...", "music ...", "song to suno ...", "retrieve and summarize ...") runs that skill with the rest of the text.

**Tests:** unit tests for spoken-name matching, launcher arguments (fake process), `ask-cli` flags; live run of each skill from a button.

## 5. Section 3: tiers 2 and 3

**Tier selection** (deterministic, first match wins):
1. starts with a skill name: tier 1
2. starts with the explicit trigger ("Claude, ...") or comes from the "Deep task" button: tier 3
3. a question about existing data (latest, last, status, pending, what did, findings, releases, approvals): tier 2
4. otherwise: current `planRequest` path, unchanged

**Tier 2: answers from existing data**
- New `core/orchestrator/lookup.ts`, read-only queries over `research_findings`, `research_runs`, `workflow_runs`, `agent_runs`, `releases`, `release_schedule_requests`, `approval_queue`.
- Factual questions (counts, latest status) are answered from templates with no model call.
- Open questions pass the matched rows to one headless call with Haiku and no tools (engine transport from Section 1).
- Writes nothing, starts no run, raises no approval. If nothing matches, say so and offer to start a run; never fall through silently to a full run.

**Tier 3: free-form headless Claude Code**
- `claude -p "<text>" --output-format json`, cwd = repo root.
- Allowed tools: Read, Grep, Glob, WebSearch, WebFetch, `Bash(pnpm ask:*)`. No Edit, no Write, no other Bash (D9).
- Runs as an `ask-jobs` job: 20-minute limit, Cancel kills the process, one tier 3 job at a time within the per-user limit of 2.
- The Claude session id is stored on the job view so the session can be reopened with `claude --resume <id>`.

**Speech:** replies from every tier go through the existing `speechText` and Kokoro path, unchanged.

**Tests:** table test of text to tier; lookup queries on the test DB; templated answers; tier 3 arguments and cancel (fake process); live: one open tier 2 question, one tier 3 task.

## 6. Security

- Mercury must run on the same machine and user account where `claude` is logged in. Personal use only: the subscription is never used to serve other users, and no login token is read, copied or embedded; the app only runs the real CLI.
- Every headless run uses an explicit allowed-tool list; no run uses skipped permissions.
- Skill names come from a server allowlist; user text is always an argument, never a command name; no shell interpolation anywhere.
- Mercury's existing auth, same-origin and `runtime.execute` checks gate every new entry point.
- Anything that changes records still goes through the OS's own approvals.

## 7. Build order

1. Section 1: engine swap (usable alone: existing UI, subscription-backed).
2. Section 2: skills, `ask-cli` flags, launcher, skill buttons, tier 1.
3. Section 3: tier selection, tier 2 lookup, tier 3.

Each step ships and is verified on its own before the next starts.
