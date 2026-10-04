# Skill launcher — design

**Date:** 2026-10-04 · **Status:** awaiting owner review · **Path:** architectural (brainstorming → spec → plan)

## Intent

The owner starts their Claude Code skills — first Suno and lyrics skills — **only from the XYP3RN OS interface** (Tasks workbench), feeds them knowledge files, and gets usable output back in the UI. Every run uses the owner's **Anthropic subscription** (logged-in Claude Code CLI), never Anthropic API credit.

Owner decisions (2026-10-04):

- **Model C — hybrid.** Every listed skill runs natively (A). Frequently used skills can later be promoted to OS workflows (B) for approvals and step tracing.
- **Subscription only.** No run may bill the Anthropic API.
- **First batch:** Suno prompt/song and lyrics-writing skills.

Assumptions (unconfirmed, P1 defaults): single owner, local machine, personal use of the owner's own CLI login. Exposing the launcher to other people is out of scope and would need a separate decision.

## What already exists (verified in code)

| Piece | Location | Reused as |
| --- | --- | --- |
| Headless `claude -p` runner, Windows tree-kill, abort/timeout | `core/llm/claude-cli.ts` | run engine, unchanged |
| API-credential stripping for the child (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`) | `childEnv()` in `core/llm/claude-cli.ts` | subscription guarantee for native runs |
| `LLM_ENGINE=claude-code` routes Anthropic agents through the CLI | `core/llm/providers.ts:248` | subscription guarantee for promoted (B) workflows |
| Logged-out and usage-limit detection | `isLoggedOut`, `isTransient` in `claude-cli.ts` | error states |
| Server-side skill allowlist (4 `pnpm ask` wrappers) | `apps/web/lib/skills.ts` | extended registry |
| Headless args: `--setting-sources project`, `--strict-mcp-config`, `--permission-mode dontAsk`, `.env` deny | `apps/web/lib/claude-headless.ts` | per-skill args builder |
| In-memory job status, cancel, `MAX_RUNNING_PER_USER = 2` | `apps/web/lib/ask-jobs.ts` | live status only |
| Tasks workbench, catalog, knowledge picker, voice input | `apps/web/app/tasks/*`, `apps/web/lib/task-catalog.ts`, `apps/web/server/task-ops.ts` (**uncommitted**) | launcher UI |

The Tasks workbench is uncommitted on `release/official-brand`. It must be committed (own commit) before implementation starts, so this work has a base to diff against.

## Section 1 — Architecture

1. **Vendored skill source.** Each launchable skill's folder is copied into the repo's `.claude/skills/<name>/` and committed. Mercury keeps `--setting-sources project`: user plugins, hooks and MCP servers never load. `pnpm skills:sync` refreshes copies from their recorded source path; a test fails on drift.
2. **Registry.** `apps/web/lib/skills.ts` remains the only server-side allowlist. Entries gain `kind: 'native' | 'os'`, a `source` path (native only) and a per-skill `tools` list. The client can send only a skill name — never a tool, path or flag.
3. **Run.** Reuses `runSkill` → `ask-jobs` (cancel, timeout, Windows kill unchanged). A native skill's args = existing base args + that skill's `--tools`, `Read(./**)`, write access limited to its own run folder, `.env` denies kept.
4. **Subscription only.** The launcher refuses every run unless `LLM_ENGINE=claude-code`. `childEnv()` keeps stripping API variables. A regression test proves that with the engine set, no Anthropic call reads `ANTHROPIC_API_KEY`, even when the key is present.
5. **UI.** The workbench catalog is derived from the registry. Each run shows its reply and output files. **Send to…** starts another skill with an output file as input (lyrics → humanizer → Suno prompt).
6. **Promotion (B), defined not built.** An `os` entry points at a workflow YAML under `records/` or `core/workflows/` and runs via `pnpm ask --workflow`. Promotion happens per skill when its usage justifies approvals or chaining.

### First batch

| Skill | Source | `--tools` | Extra allow rules |
| --- | --- | --- | --- |
| `suno-ai-prompting` | `~/.claude/skills/suno-ai-prompting` | `Read,Write,Skill` | — |
| `suno-prompt-producer` | `~/.claude/skills/suno-prompt-producer` | `Read,Write,Skill` | — |
| `rap-flow-lyricist` | `~/.claude/skills/rap-flow-lyricist` | `Read,Write,Skill` | — |
| `ai-lyric-humanizer` | `~/.claude/skills/ai-lyric-humanizer` | `Read,Write,Skill` | — |
| `suno-song-creator` | `~/.claude/skills/synced/…/suno-song-creator` | `Read,Write,Skill,WebSearch,WebFetch` | `WebSearch`, `WebFetch` |

`Bash` is granted to no skill in batch 1 (`suno-song-creator` references it; it must work without, or Bash access becomes its own decision). **Deferred:** bitwize `lyric-writer` / `lyric-reviewer` — they require `bitwize-music-mcp`, which Mercury's `--strict-mcp-config` excludes and which was not connecting on 2026-10-04.

## Section 2 — Data flow and error states

### Start — `POST /api/tasks`

Body: `{ task, text, knowledge: string[], inputs?: string[], requestId }`. Unknown fields → 400.

Server checks, in order: session → `task` is an allowlisted skill → `LLM_ENGINE=claude-code` → `text` 1–8,000 chars → each `knowledge` id resolves through the existing knowledge rows to a repo-relative path inside the repo → each `inputs` path (Send-to) is a regular file inside a run folder **owned by this user** → fewer than `MAX_RUNNING_PER_USER` running → dedupe on `requestId`.

Then:

- `runId` = server-generated `crypto.randomUUID()`. The client never names a folder.
- Create `records/runs/<runId>/`. Write `run.json` **atomically** (temp file + rename):
  `{ runId, owner, skill, text, knowledge, inputs, state: 'running', startedAt }`.
- Prompt (stdin): `/<skill> <text>` + a blank line + `Knowledge files:` / `Input files:` path lists + `Write every output file to records/runs/<runId>/.`
- Write permission rule scoped to `records/runs/<runId>/**` only. The exact rule form (`Write(...)` vs `Edit(...)` — Claude Code applies Edit rules to all file-writing tools) is pinned by the first plan task against the installed CLI version and recorded in the args test.

### Run

`claude -p` runs in the repo cwd with that skill's args. The UI polls the existing job status endpoint.

### Finish

- Reply text (capped at `MAX_REPLY_CHARS`) → `reply.md`.
- Output listing: regular files directly under or below the run folder, **symlinks excluded**, each ≤ 1 MB for inline preview (larger files listed, not previewed), at most 50 entries.
- `run.json` rewritten atomically with `state`, `endedAt`, `files`, and `reason` when not `done`.

### History

`GET /api/tasks` "Recent" reads `records/runs/*/run.json` for the caller (newest 20) merged with live jobs. A record still `running` with no live job is shown as **interrupted** (server restarted mid-run) — never as running or done. `records/runs/` is added to `.gitignore`: outputs are the owner's data, not source.

### Error states

| Case | UI message | HTTP | `run.json` |
| --- | --- | --- | --- |
| Engine off | "Skills need LLM_ENGINE=claude-code on the Mercury server." | 409 | not created |
| Unknown skill / bad field / bad knowledge id / input outside owned runs | field-specific | 400 | not created |
| Two runs already going | "Two runs already going — wait or cancel one." | 429 | not created |
| CLI missing (`ENOENT`) | "Claude Code CLI not found — install it or set CLAUDE_BIN." | — | `failed`, `reason: cli-missing` |
| Logged out (`isLoggedOut`) | "Claude Code is logged out — run `claude` then `/login`." | — | `failed`, `reason: logged-out` |
| Subscription usage limit (`isTransient`, usage-limit text) | "Subscription usage limit reached — try after the reset." plus reset time if the CLI reports one | — | `failed`, `reason: usage-limit` |
| Cancel | "Stopped." | — | `stopped`, partial files kept |
| Timeout (30 min, `SKILL_TIMEOUT_MS`) | "Stopped after 30 minutes." | — | `stopped`, `reason: timeout` |
| Non-zero exit / unparsable / empty reply | CLI's error text, trimmed | — | `failed`, `reason: error` |
| Server restart mid-run | "Interrupted." | — | stays `running`; reported as interrupted |

No automatic retry: on a subscription, retrying a usage-limit failure only burns the window.

## Section 3 — Testing and done criteria

All unit tests use a fake `ClaudeRunner` (existing pattern); no test spends subscription usage.

### Unit

- **Args per skill:** exact argv for every registry entry — tools, `Read(./**)`, the run-scoped write rule, `.env` denies, `--setting-sources project`, `--strict-mcp-config`, `--permission-mode dontAsk`; no `Bash` anywhere in batch 1.
- **Subscription:** engine off → refusal, runner never called. `childEnv` strips all three API variables. With `LLM_ENGINE=claude-code` and `ANTHROPIC_API_KEY` set, `createLlmClient` for a `claude-*` model takes the CLI path (no API transport call).
- **Validation:** unknown skill, extra field, oversize text, `knowledge` id not in rows, `inputs` path with `..`, absolute path, another user's run, or a symlink → 400 and no folder created.
- **Lifecycle:** running → done / failed(reason) / stopped(timeout|cancel); interrupted reporting; atomic write leaves no partial `run.json`.
- **Listing:** symlink excluded, >1 MB listed without preview, 50-entry cap.
- **Errors:** logged-out, usage-limit and `ENOENT` map to the reasons above.

### Drift

Every native registry entry has `.claude/skills/<name>/SKILL.md`; after `pnpm skills:sync`, content hash equals source. A vendored skill folder not in the registry fails the test.

### Browser e2e — `apps/web/e2e/task-workbench.mjs`

Fake `CLAUDE_BIN` script (writes one file into the run folder, prints a `result` JSON). Covers: launch → reply and file shown → Send-to starts the next skill with that file → Cancel → logged-out message (fake prints the logged-out result).

### Done = all of these, fresh run, outputs read

```
pnpm typecheck
pnpm db:up && pnpm test                # Postgres running
pnpm web:build
node apps/web/e2e/task-workbench.mjs
```

Plus one owner-attested real run on the subscription: `rap-flow-lyricist` → `ai-lyric-humanizer` → `suno-prompt-producer`, screenshots and the three `run.json` files in `docs/proofs/<run-date>-skill-launcher/`.

## Out of scope

Bitwize skills (MCP), research skills, building promotion (B), streaming in-run progress, multi-user access, database tables for runs, test-suite behaviour without Postgres (separate task).
