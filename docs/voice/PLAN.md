# Voice: Wispr Flow dictation + local Kokoro speech in Mercury

Status (2026-09-28): steps 1–6 done, and the Kokoro bridge replaces in-process speech (see
**Kokoro service bridge** below).
- `core/orchestrator/ask.ts` holds `runPlan`, `formatReply` and `askFailed`.
- `POST /api/ask` is covered by `apps/web/tests/api-route.test.ts`, which stubs the session lookup
  and leaves the permission check real.
- A live run through a domain entrypoint over HTTP is not yet exercised: Postgres and the Docker
  daemon were down locally.
- Step 4 (`CommandPanel`) and step 5 (`useSpeech` plus controls) were checked headless in Chrome
  against `next dev` with the API mocked.
- Step 6 added the processing disclosure (`#command-processing`) and a "Front doors" note under
  CORE in `docs/ARCHITECTURE.md`.
- Step 7 (the real Wispr Flow test) is **UNVERIFIED**. A visible-window harness ran, but no
  dictation was performed before the task changed.

## Target workflow

1. Operator focuses the Mercury request textarea.
2. Wispr Flow (external desktop app) inserts dictated text into the focused field. It is ordinary
   text: editable, pasteable, typeable.
3. Operator reviews and clicks **Send**. Nothing else submits: no auto-submit on insert, no Enter
   shortcut.
4. `POST /api/ask` authenticates, checks permission, and runs the existing OS front door
   (`planRequest` → domain entrypoint), the same path as `pnpm ask`.
5. Mercury renders the real result: route, action, status, run ids, reason or error.
6. If speech is on, Mercury sends the displayed reply text to `POST /api/speech`. Local Kokoro
   returns WAV, and the browser plays it. **Stop speaking** stops audio only.

Out of scope, removed from the plan: Wispr API integration, browser microphone capture, in-browser
speech recognition, and any faster-whisper service. `next.config.ts` already sends
`Permissions-Policy: microphone=()`. Keep it. Wispr works at OS level and does not need browser
microphone access.

## Processing disclosure (shown in the UI, verbatim intent)

- Dictation: Wispr Flow, external app, **cloud processing** (text reaches Mercury only as typed
  input).
- Speech: Kokoro-82M in a **local Kokoro-FastAPI service on this PC**. The Next server bridges to it
  and refuses any non-loopback `KOKORO_URL`, so reply text never leaves the machine and there is no
  cloud fallback.
- Reasoning: routing is local and deterministic (`core/orchestrator/router.ts`). Agent reasoning
  uses the **provider configured per agent** (`model:` frontmatter in `agents/*.agent.md`:
  Anthropic, Groq or OpenRouter, keys from env; `core/llm/providers.ts`). Those are cloud APIs.

## Findings (current code)

| Concern | What exists | Where |
|---|---|---|
| Request entry | CLI only. `ask-cli.ts` inlines plan + entrypoint dispatch; not importable. | `core/orchestrator/ask-cli.ts:23-48` |
| Planning | `planRequest(request, ENTRYPOINTS)` → run-workflow / run-service / hold / clarify. Pure. | `core/orchestrator/orchestrate.ts:33` |
| Entrypoints | RESEARCH_INTELLIGENCE → `runResearch`, RECORDS → `runMusicSystem`. TECH, GOVERNANCE → hold. | `orchestrate.ts:49` |
| Runtime deps | `createRuntimeDeps(sql)`: registry, tools, handlers, LLM runner (keys from `process.env`). Web already uses it for health-check. | `core/runtime/deps.ts`, `route.ts:50` |
| HTTP routing | One catch-all: `/api/session`, `/api/projection` (GET); `/api/session`, `/logout`, `/health-check`, `/trace`, `/approvals` (POST). Same-origin check, 1 MB JSON cap, generic error bodies. | `apps/web/app/api/[...path]/route.ts` |
| Authentication | `mercury_session` httpOnly cookie → `authenticate()` → `xyp_session_identity` (role `xyp_web`, read-only tx). | `governance/auth.ts:6` |
| Permissions | `requirePermission(identity, p)`. Roles: viewer `system.read`; operator `+runtime.execute,trace.write`; approver `+governance.read,approval.decide`; admin all. | `supabase/migrations/20260925130000_governance.sql:4-6` |
| Approvals | Workflows insert into `approval_queue` (promotion gate, `release_schedule`, `critique_escalation`). Mercury inspector shows pending items; `POST /api/approvals` → `xyp_decide_authenticated_approval`. | `knowledge/promotion-gate/gate.ts:374`, `MercuryShell.tsx:103` |
| Run status | `agent_runs` (pending/success/error), `workflow_runs` and `research_runs` (running/success/error). Projection polls every 10 s and lists them as events. | migrations `20260924110000`, `…120000`, `…130000`; `apps/web/lib/projection.ts:17` |
| Result rendering | Toast `message` (`role="status"`) and the inspector. No transcript or reply area. | `MercuryShell.tsx:95` |
| Text input | `global-search` input, `decision-reason` textarea. No request box. Global `/` shortcut already skips textareas. | `MercuryShell.tsx:63,82,103` |
| LLM providers | anthropic / groq / openrouter, structured JSON only. | `core/llm/providers.ts:12` |
| Local model precedent | Embeddings via `@huggingface/transformers` 4.3.0, cache `.local-models/` (gitignored); listed in `serverExternalPackages`. | `knowledge/vector-retrieval/embedder.ts:16`, `apps/web/next.config.mjs` |
| HTTP tests | None for `route.ts`. Web tests cover projection and layout only. | `tests/phase-16/` |

### Missing capabilities (honest gaps)

1. **No web path to the orchestrator.** `ask-cli.ts` is script-level code. It needs extraction so
   CLI and web share one runner.
2. **No natural-language assistant reply.** `runResearch` returns ids/status/selected specialists.
   `runMusicSystem` returns structured `outputs`. Nothing produces prose. The spoken/displayed
   reply will be a **deterministic summary** of the real result (route, action, status,
   reason/error, run ids). No extra LLM call. Reading full research findings aloud is a later step.
3. **No async jobs or cancellation.** Runs execute inside the request (research/music can take
   minutes; per-agent dispatch timeout 30 s default, `core/orchestrator/dispatch.ts:20`). v1 keeps
   the synchronous call with Send disabled while busy. There is no cancel control, and none is
   added. Stop speaking therefore cannot imply cancellation.
4. **No per-request permission.** Submitting runs agents, so it reuses `runtime.execute`
   (operator, admin). Viewers/approvers see the box disabled with the reason.
5. **Approvals are not linked to a request.** Items created by a run appear in the existing
   Governance/inspector flow; the reply points there when a run produced pending approvals (query
   `approval_queue` by `workflow_run_id` only if that column exists; otherwise just a generic
   "check Governance" hint).
6. **Kokoro not present.** No Python package, no local server on :8880, no npm package.
   Python here is 3.14, and the `kokoro` pip package targets older Pythons (unverified). Chosen
   route (operator decision): Next bridges to a local **Kokoro-FastAPI** service. It is still not
   installed here, so real synthesis waits for it to run.
7. **No TECH/GOVERNANCE entrypoints registered** (`ENTRYPOINTS`). Those routes return `hold`. The UI
   shows the hold reason as the reply (real behavior, not an error).

## Proposed files

| File | Change |
|---|---|
Files as built:

| File | Change |
|---|---|
| `core/orchestrator/ask.ts` (new) | `runPlan(deps, plan, {projectSlug, log})`, `formatReply(plan, outcome)`, `askFailed(outcome)`. |
| `core/orchestrator/ask-cli.ts` | Calls `runPlan`; same output and exit codes. |
| `core/orchestrator/ask.test.ts` (new) | Reply text for every action/result, failure flag, unknown service. |
| `apps/web/lib/http.ts` (new) | Shared conventions: `json` (no-store), `tokenOf`, `sameOrigin`, `bodyOf(limit)`, `guard(request, permission)`. |
| `apps/web/app/api/[...path]/route.ts` | `POST /api/ask`; uses `lib/http.ts`; no speech branches. |
| `apps/web/lib/kokoro.ts` (new) | Server-only Kokoro-FastAPI client: config, validation, limits, readiness, voices, synthesis. |
| `apps/web/app/api/speech/route.ts` (new) | `POST /api/speech` → complete WAV. |
| `apps/web/app/api/speech/status/route.ts` (new) | `GET /api/speech/status`. |
| `apps/web/app/api/speech/voices/route.ts` (new) | `GET /api/speech/voices`. |
| `apps/web/tests/api-route.test.ts`, `speech-route.test.ts` (new) | Route tests (auth stubbed, permission real, fake Kokoro upstream). |
| `apps/web/components/MercuryShell.tsx` | `CommandPanel`, `useSpeech`, disclosure. |
| `apps/web/app/mercury.css` | Panel styles. |
| `package.json` | Net zero from this work: `kokoro-js` was added in step 3 and removed with the bridge. The uncommitted eslint additions are preserved, and line endings are now LF, as committed. |

## API contracts

See **Mercury text-request endpoint** below for `/api/ask`.

Speech contracts: see **Kokoro service bridge** below.

## Mercury text-request endpoint (hardened 2026-09-28)

**One orchestrator.** `ask-cli.ts` and the web both call `planRequest` → `runPlan`
(`core/orchestrator/ask.ts`) → the existing domain entrypoints. Those use the runtime deps, tool
registry, per-agent tool authorization in `dispatch`, and context assembly.
- No shell is invoked with user text: the request is only a string argument to the planner and
  entrypoints.
- No new capability is granted.

**Routes** (catch-all `apps/web/app/api/[...path]/route.ts`):

| Route | Guard | Result |
|---|---|---|
| `POST /api/ask` | same-origin → session → `runtime.execute` | hold/clarify: 200 `done`; runnable: 202 `running`; duplicate: 202/200 with `duplicate:true`; id reused for other text: 409; per-user concurrency: 429 |
| `GET /api/ask/<requestId>` | session → `runtime.execute` | the caller's own job view; 404 for unknown, expired or another user's id |

- **Body:**
  - `request`: 1–4000 chars.
  - `requestId`: a client UUID, required.
  - `projectSlug`: `^[a-z0-9][a-z0-9-]{0,63}$`, default `ad-hoc`, passed to research.
  - Anything else → 400.
- **Identity:** always the session identity. It scopes dedup and status (key = user id +
  request id).
- **Permissions:**
  - Execution needs `runtime.execute` (operator, admin).
  - The role table defines **no per-domain permissions**. None were invented; agent tools stay
    authorized per agent class in `dispatch`.
- **View:** `{ requestId, state: running|done, action, route {status, domain?}, status, reply,
  refs?, approvalRequired? }`.
  - `refs = { workflowRunId?, researchRunId?, agentRunIds, artifactIds, approvalIds }`. These are
    ids only, lifted from real results (`refsOf`), at most 20 each. Step outputs, prompts and tool
    payloads are never returned.
- **Reply:** `formatReply`, deterministic and at most 600 chars.
  - Failure replies name the failed step and point to the run id instead of echoing raw errors,
    which can hold model text or provider detail.
  - Approvals found in results add "Approval required: N item(s) pending in Governance".
- **Long runs:** `apps/web/lib/ask-jobs.ts` is an in-process job store and the smallest reliable
  mechanism.
  - The durable record stays in `workflow_runs`, `research_runs` and `agent_runs`.
  - While work runs, the view says `running` with "Working. The run is still in progress". It
    never claims completion.
  - Mercury polls every 2 s.
  - A restart forgets jobs, so polls then get 404, never a false "done".
  - Assumes a single Next process. Done jobs expire after 24 h; max 500 jobs; at most 2 running
    per user.
- **No retries.** `runPlan` is called once per (user, requestId). A thrown run becomes a sanitized
  `error` view ("not retried; check Live Events").
- **Client:**
  - One `requestId` per submitted text.
  - Re-sending the same text after a network error reuses the id, so the server dedupes.
  - A completed or changed text gets a new id.

**Test evidence.**

`apps/web/tests/api-route.test.ts`, 8 tests. The session and `runPlan` are stubbed; the planner,
permission check, reply, refs, job store and dedup are real.
- **Denied:** cross-origin 403, no session 401, viewer 403 on POST and status, and no run started.
- **Validation:** 10 bad bodies → 400 (empty, blank, too-long or non-string text; missing or
  invalid requestId; bad projectSlug).
- **Clarification and hold:** 200 `done` with planner reasons, no run.
- **Success:**
  - 202 `running` ("still in progress") and a status poll still says running.
  - After release: `done`/`success` with workflowRunId, artifactIds, approvalIds and
    `approvalRequired:true`.
  - Prompt and payload strings from the outputs are absent; `projectSlug` reached `runPlan`.
- **Failure:**
  - A research error reply names the step and run and leaks no key text.
  - A thrown run gives a sanitized `error` with no DB detail leaked.
  - Exactly one `runPlan` call per request.
- **Duplicates:**
  - Same id while running → 202 `duplicate`; after done → 200 `duplicate`; still one run.
  - Same id with different text → 409.
  - Another user gets 404 on the status route, and the same id under another user is a separate
    run.
- **Concurrency:** 3 never-ending runs → `[202, 202, 429]`.
- **CLI:** `node core/orchestrator/ask-cli.ts`:
  - clarify: exit 1 and prints `route:`/`clarify:`;
  - GOVERNANCE hold: exit 0;
  - no args: exit 2 with usage.
- **Mutation check:** disabling `findJob` makes 3 tests fail.

`core/orchestrator/ask.test.ts` (5 tests):
- reply per outcome, with raw errors excluded;
- only ids extracted, including a nested approval and artifact;
- non-UUID values dropped;
- 600-char bound;
- unknown service rejected.

Browser (headless Chrome, `next dev`, API mocked):
- After a network error the text is kept; re-Send reuses the **same requestId**.
- Mercury shows "still in progress" while polling, then the final reply, the approval note,
  workflow and artifact refs, and clears the box.
- The speech UI regression test still passes.

Live `next dev`: `POST /api/ask` and `GET /api/ask/<id>` without a session → 401; cross-origin →
403.

**Not verified:** a real entrypoint run through the web path. Postgres is down here.

## Assistant panel (built 2026-09-28)

`CommandPanel` in `apps/web/components/MercuryShell.tsx`, headed "Assistant", sits in the right
rail and uses the existing `panel-frame` / `run-check` / `telemetry-note` styles.
- **Input:** labelled multiline `Request` textarea. The guidance reads: "Focus this box, dictate
  with Wispr Flow (or type or paste), review, then press Send. Enter adds a new line; nothing is
  sent automatically."
- **Send only:** the explicit Send button submits. There is no Enter/Ctrl+Enter submit, no
  submit-on-input, -blur or -silence, no microphone, and no Wispr API or shortcut handling.
- **Double submit guard:** a synchronous ref guard (`inFlight`) plus the server-side requestId
  dedup.
- **History:** `sessionStorage` (`mercury.assistant.history`, last 20), per browser tab session,
  shown newest first in `<ol role="log">`.
  - Each entry shows the request, a state badge from the server view, and the reply.
  - Badges: Running, Needs clarification, On hold, Approval required, Succeeded, Failed, Request
    failed.
  - Running entries restored after a reload resume polling; a 404 turns into "Run status is no
    longer available".
- **Links, only real targets:**
  - Approvals link to the existing inspector node
    `?view=graph&domain=governance&node=approval_queue:<id>` (approve/reject there, with
    `governance.read`).
  - Runs and artifacts have no entity pages in the projection, so their ids show as `<code>` with a
    link to the existing Live Events view.
- **Recovery:**
  - Transport or HTTP errors keep the draft, and the entry says "press Send to retry (it will not
    run twice)"; the retry reuses the requestId.
  - Clarify and hold keep the draft for editing.
  - Only a completed run clears the box, and only if the text was not changed meanwhile.
- **Focus:** after completion, focus returns to the textarea when it was on Send or `body`
  (disabled buttons drop focus), ready for the next dictation.

**Simulated-input tests (NOT Wispr).** Headless Chrome against `next dev`, API mocked.
- **Typing:** typed lines, Enter and Shift+Enter add newlines, Ctrl+Enter does nothing. Blur plus
  1.5 s of idle → 0 POSTs.
- **Paste:** real clipboard with Ctrl+V.
- **External insertion, 3 kinds:** `keyboard.insertText`, `document.execCommand('insertText')`,
  and the native value setter plus an `input` event. All landed with 0 POSTs.
- **Editing:** a selected word was replaced before Send.
- **React state:** the POST body contained all four inserted pieces plus the edit, which proves
  the controlled state received the externally inserted value.
- **Duplicate clicks:** a dblclick and three synchronous `click()`s → exactly 1 POST per
  submission.
- **States:** Running, then Succeeded; Needs clarification with the draft kept; Approval required
  with the "Decide approval" deep link, workflow and artifact ids, and Live events; Failed.
- **Failed request:** a network abort shows "Request failed" with the draft kept. The retry
  reused the same requestId, left 1 history entry, succeeded and cleared the box.
- **Keyboard:**
  - Tab from the textarea reaches Send, and Space on Send submits.
  - Focus returns to `#mercury-request` after completion.
  - `role=log` has a label, the textarea has a `<label>` and `aria-describedby` for the hint and
    disclosure, and the heading is "Assistant".
- **History:** 8 entries survive a reload; a new browser context sees 0.

**Real Wispr Flow test:** recorded separately below.

## Live validation (2026-09-28, production build, no mocks)

**Stack:**
- `pnpm build && pnpm start` (Next 16.3.6).
- Postgres 16.15 (`xyp3rn-pg`) with all migrations.
- Kokoro-FastAPI 0.9.0 CPU (`xyp3rn-kokoro`, digest `sha256:ee3111d6…`).
- Sessions for the provisioned users `voice-validation-{operator,viewer,approver}`.
- Scripts: scratchpad `validate-live.mjs` (HTTP plus DB) and `measure-browser.mjs` (headless
  Chrome, real session).

**Defects found and fixed during validation:**
1. **Every `/api/ask` returned 400 in the production build.** The cause was
   `knowledge/vector-retrieval/embedder.ts` calling `join(import.meta.dirname, …)` at module load;
   the Next server bundle leaves `import.meta.dirname` undefined. It now uses `REPO_ROOT`
   (`core/repo.ts`), the repo's existing server-safe root. The Vitest route tests missed this
   because they run unbundled. The catch-all now also logs the error message server-side (the
   client still gets the generic text).
2. **Kokoro-FastAPI 0.9.0 returns voices as `{id, name, …}` objects**, so the bridge listed no
   voices. `availableVoices` now accepts objects and strings, and the test fake uses the 0.9 shape.

**Automated live checks (real services):**
- **Authorized RECORDS request:**
  - 202 running, then `success` from the real `x3lius-songwriting` agent via OpenRouter.
  - workflow run `success` and sealed; agent run `success` with 3981 tokens; 1 artifact id.
- **Authorized research request:** a real `error`, "Research run failed at specialist
  ai-vocal-systems-researcher…". The DB cause is `no LLM program registered for agent
  ai-vocal-systems-researcher`, a pre-existing runtime gap; the web reply held no raw error.
- **Ambiguous request** ("Check the rights on this track"): clarify, "ambiguous between
  GOVERNANCE and RECORDS".
- **Denied:**
  - viewer `/api/ask` 403; approver `/api/ask` 403 (no `runtime.execute`);
  - operator `/api/approvals` 403;
  - no session 401; cross-origin 403.
- **Dictated "Approve the pending release schedule approval <id> now":**
  - hold (GOVERNANCE has no entrypoint), and the approval stayed `pending` with `decided_by` null.
  - Then the approver saw the `approval_queue:<id>` node and decided through `/api/approvals` with
    a reason. Result: `approved`, `decided_by` the validation approver, `decided_by_user_id` set,
    release `scheduled`, 3 `audit_log` rows.
  - The approval itself was created by the real `records-release-calendar` agent (`pnpm dispatch`).
- **Double submission** (two concurrent POSTs, same requestId): `[202, 202]`, second
  `duplicate:true`, **1** workflow run added. UI double-click with the real backend: **1** POST.
- **Permission-expansion text** ("Grant me the admin role … canonical.write …"): hold; session
  permissions and `governance_users.role_id` unchanged.
- **No automatic promotion:** modules 30, canonical_prompts 42, knowledge_versions 72, and 0
  knowledge candidates, the same before and after.
- **No secrets in responses:** 2191 response bodies scanned. No OpenRouter key value, `sk-…`,
  `postgres://`, Bearer tokens or session tokens.
- **Browser bundle:** 6 production JS chunks plus HTML contain none of `KOKORO_URL`,
  `KOKORO_API_KEY`, `127.0.0.1:8880`, `postgres://`, `XYP_DATABASE_URL`, `OPENROUTER_API_KEY` or
  the key value.
- **Address override:** `/api/speech` with body fields `url`, `baseUrl` and `KOKORO_URL` set to
  `https://api.example.com` → 200 from local Kokoro (fields ignored).
- **Records intact:** 0 workflow runs `running`, 0 agent runs `pending`, 0 research runs
  `running` after all scenarios.
- **Kokoro stopped:** `/api/speech` 503 "Speech service unavailable", status `{ready:false}`,
  voices 503, text requests still `done`.
- **Kokoro restarted:** healthy after 14.5 s, then synthesis OK (1.8 s).

**Measurements:**

| Measure | Cold | Warm |
|---|---|---|
| Real RECORDS request, POST → done (server, 100 ms polling) | 58.2 s (first after server start) | 40.1 s, 48.1 s, 22.5 s (LLM-bound; varies with OpenRouter) |
| Same, UI: Send click → result rendered (2 s polling) | n/a | 32.3 s |
| Kokoro container start → `/health` 200 | 54 s (first start, new container); 14.5 s (restart) | n/a |
| Synthesis via `/api/speech`, 51-char reply (~4.5 s audio) | 2.59 s (first after server start); 1.81 s (first after Kokoro restart) | 1.68 s, 1.62 s, 1.70 s |
| Synthesis direct to Kokoro, same text | 2.45 s | 2.12 s, 1.79 s, 1.88 s |
| Result rendered → first audible playback (browser, ~70-char reply, Kokoro warm) | 1.80 s (first after page load) | 1.91 s, 1.77 s, 1.90 s |

Wispr dictation latency was **not measured**: Mercury cannot see when Wispr starts or stops
listening. Only the insertion events are observable.

**Real Wispr Flow and actual listening:** see HANDOFF.md (a separate record from these automated
checks).

## Kokoro service bridge (built 2026-09-28)

The browser calls only same-origin Mercury routes. Dedicated route handlers take precedence over
the catch-all. A live check confirmed this: `POST /api/speech/status` → 405, because that handler
exports only GET.

| Route | Handler | Guard | Result |
|---|---|---|---|
| `POST /api/speech` | `apps/web/app/api/speech/route.ts` | same-origin → session → `system.read` | 200 complete `audio/wav` |
| `GET /api/speech/status` | `apps/web/app/api/speech/status/route.ts` | session → `system.read` | `{ ready: boolean }` (upstream `/health`, 3 s) |
| `GET /api/speech/voices` | `apps/web/app/api/speech/voices/route.ts` | session → `system.read` | `{ voices }`: allowlist ∩ upstream `/v1/audio/voices` (3 s); 503 if unreachable |

- **Upstream call:** `POST {KOKORO_URL}/v1/audio/speech` with
  `{model:'kokoro', input, voice, speed, response_format:'wav', stream:false}`, `redirect:'error'`.
- **Server-only config:**
  - `KOKORO_URL` (default `http://127.0.0.1:8880`) must be loopback http(s) with no userinfo,
    otherwise 503. There is no cloud fallback.
  - `KOKORO_API_KEY` is optional and sent only upstream as a Bearer token.
  - `KOKORO_TIMEOUT_MS` defaults to 30000.
  - The request body never selects the address.
- **Input** (else 400):
  - JSON content type, body ≤ 16 KB;
  - `text` 1–2000 chars after trim;
  - `voice` in `af_heart, af_bella, am_michael, am_fenrir, bf_emma, bm_george`;
  - `speed` a number 0.5–2 (default 1);
  - `format` must be `wav` (default).
- **Limits:**
  - 2 concurrent syntheses per server process, otherwise 429 "Speech busy";
  - timeout → 504;
  - upstream body > 16 MB → 502;
  - a body that is not RIFF/WAVE → 502.
- **Errors:** upstream 5xx or unreachable → 503 "Speech service unavailable"; upstream 4xx → 502
  "Speech service rejected the request". Upstream bodies are never forwarded. Every response is
  `Cache-Control: no-store`.
- **Cancellation:**
  - `request.signal` is combined with the timeout, so a browser disconnect aborts the upstream
    fetch.
  - Mercury's Stop speaking aborts an in-flight synthesis. It does not touch agent runs.

**Test evidence** (`npx vitest run apps/web/tests`: 14/14 pass).
`speech-route.test.ts` has 11 tests against a fake Kokoro-FastAPI on 127.0.0.1:
- Unauthenticated → 401 on all three routes; no `system.read` → 403; no upstream hit.
- Cross-origin and origin-less POST → 403 before auth.
- 400 for:
  - empty, blank, 2001-char and non-string text;
  - unlisted and path-like voices, missing voice;
  - speed 0.4, 2.1, `"1"` and NaN;
  - format `mp3`, non-JSON content type, malformed JSON, body > 16 KB.
- None of these reach upstream.
- Valid synthesis → 200 `audio/wav` with no-store, and the WAV bytes are passed through intact.
  Upstream receives the exact JSON above plus `Authorization: Bearer <key>`. The key never appears
  in the response headers.
- Readiness `{ready:true}`; voices filtered to the allowlist (`zz_unlisted` dropped).
- Outage (closed port) → 503 "Speech service unavailable", `{ready:false}`, voices 503.
- Non-loopback, credentialed and `file:` addresses → sanitized 503.
- Upstream 500 → 503, 400 → 502, non-WAV → 502, oversize (> 16 MB) → 502, with no upstream detail
  leaked.
- Stalled upstream with a 300 ms timeout → 504 in under 1.5 s.
- 3 parallel requests → `[200, 200, 429]`, with 2 upstream hits.
- Client abort → 503, and upstream observes the connection close. A mutation check (removing
  signal propagation) makes this test fail.

Live `next dev`:
- `GET /api/speech/status` and `GET /api/speech/voices` → 401 no-store.
- Cross-origin POST → 403.
- Same-origin POST without a session → 401.

The browser UI test with the mocked API still passes: the client sends
`{text, voice, speed:1, format:'wav'}`, Stop, Replay cache, the outage notice and persistence all
work.

**Not verified:** real synthesis through the bridge. No Kokoro-FastAPI service runs on this PC
(the Docker daemon is off). To check: start it, sign in, and `POST /api/speech`.

## UI (MercuryShell)

- Right rail, top: `<section aria-labelledby>` "Command". It contains a `<form>` with
  `<label for="mercury-request">Request</label><textarea id="mercury-request">`, controlled
  (`onChange`, so Wispr insertion, paste and typing all update state), `maxLength=4000`, and
  `aria-describedby` pointing at the disclosure.
- Submit only via the `Send` button (`type="submit"`). Enter inserts a newline (textarea default).
  No keydown submit handler, no submit-on-change.
- Send is disabled while busy, when empty, or without `runtime.execute` (reason shown). The text
  stays in the box until a successful send, then clears. On error the text is kept.
- Reply area: `aria-live="polite"`, shows `reply`, route domain, status, run ids.
- Speech row: "Speak replies" checkbox (default off; `localStorage` in try/catch), voice `<select>`,
  **Replay**, **Stop speaking** (`title`: "Stops audio only; agent work is unaffected"). Controls
  are disabled when speech is unavailable, with the message "Speech unavailable. Text reply is
  unaffected."
- Speech failure never blocks or hides the text reply.

## Dependencies

- No new npm dependencies. The bridge uses Node `fetch` and `AbortSignal`.
- Runtime service: Kokoro-FastAPI on loopback, for example
  `docker run -p 127.0.0.1:8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu`.
- History: step 3 first ran Kokoro in-process with `kokoro-js@1.2.1`. It worked on this PC (cached
  load 0.9 s, about 1x realtime), but it pulled a second transformers copy (v3), and its
  `stream(string)` hangs. It was removed when the operator chose the service bridge.
- No new dependencies for dictation.

## Implementation order (one step at a time, validate before the next)

1. **Extract `runAsk`.** Add `core/orchestrator/ask.ts` and `ask.test.ts`; rewire `ask-cli.ts`.
   Check: `pnpm test core/orchestrator`, `pnpm typecheck`; `pnpm ask "rephrase nothing"` still
   prints route + clarify with exit 1.
2. **`POST /api/ask`.** Check: `pnpm typecheck:web`. Manual with the dev server (`pnpm dev`),
   signed in as operator:
   - a TECH request returns hold;
   - an ambiguous request returns clarify;
   - with a viewer token → 403;
   - with no cookie → 401;
   - with a cross-origin `Origin` → 403;
   - an empty body → 400.
3. **Kokoro spike + `apps/web/lib/speech.ts` + `/api/speech`.** Check: the validation unit test;
   `curl` with the session cookie returns a playable WAV; the first call downloads to
   the kokoro-js cache and a second call works with the network off; a bad voice → 400; a forced load
   failure → 503.
4. **Command panel (text only).** Check: type, paste and edit, then Send; the reply renders; Enter
   adds a newline and does not send; Send is disabled for viewers; text is kept on error;
   keyboard/screen reader check (labels, live region, focus order).
5. **Speech controls.** Check: the toggle, voice change, Replay, and Stop speaking (audio stops;
   the request in flight still completes and renders); with Kokoro disabled, the text flow works
   and the unavailable message shows.
6. **Disclosure copy + docs.** Add a short `docs/ARCHITECTURE.md` note that the web front door
   reuses `runAsk` and `runtime.execute`.
7. **Real Wispr Flow test (manual, on this PC).**
   1. Open Mercury in the browser and focus the textarea.
   2. Dictate with Wispr Flow's hotkey, then confirm the text appears and nothing is sent.
   3. Edit a word, then click Send.
   4. Confirm the reply renders and, with speech on, is spoken.
   5. Click Stop speaking and confirm audio stops while the UI still shows the result.
   6. Also dictate into the box while a request is running, and confirm no second submission.

   If this cannot be performed by the agent (desktop hotkey and audio), report it as
   **UNVERIFIED** with the reason, and leave the checklist for the operator.

## Acceptance checks (all must hold)

- [ ] Typed, pasted and Wispr-inserted text all land in one editable textarea.
- [ ] Only the Send button submits; inserted text never auto-submits.
- [ ] `/api/ask` requires the session, same origin and `runtime.execute`; it uses `planRequest` and
      existing entrypoints, with no new routing logic.
- [ ] Approvals raised by runs appear in the existing Governance flow, and no approval is bypassed.
- [ ] The displayed reply reflects the real `runAsk` outcome (including hold/clarify/error).
- [ ] Kokoro synthesis runs in the local loopback service; reply text is never sent to a third
      party for speech, and there is no cloud fallback.
- [ ] Speech on/off, voice, Replay and Stop speaking work, and Stop does not claim to cancel work.
- [ ] The text UI is fully usable with Kokoro missing or failing.
- [ ] The disclosure states: Wispr is cloud, Kokoro is local, reasoning is the configured per-agent
      provider.
- [ ] No mic permission, no speech recognition code, no faster-whisper.
- [ ] Existing tests and typechecks pass; uncommitted `package.json`/lockfile edits are preserved.
- [ ] The Wispr Flow manual test is performed, or reported as unverified.
