# Mercury voice: Wispr Flow dictation + local Kokoro speech

You dictate into Mercury's Assistant box with the **Wispr Flow** desktop app, review and edit the
text, and press **Send**. The request runs through the normal XYP3RN OS front door (the same path
as `pnpm ask`). If you turn speech on, a **local Kokoro** service reads the reply aloud.

Mercury never talks to Wispr, never records audio, and never sends on its own.

## Prerequisites (Windows)

| Need | Check |
|---|---|
| Node.js ≥ 22 and pnpm | `node --version`, `pnpm --version` |
| Docker Desktop running | `docker version` shows a Server version |
| Postgres container `xyp3rn-pg` (pgvector, port 5432) with migrations applied | `pnpm db:status` lists every migration as `applied` |
| Kokoro-FastAPI image (about 5 GB, pulled on first start) | `pnpm voice:status` |
| Wispr Flow desktop app, signed in, with its dictation shortcut set | Wispr Flow tray icon |
| At least one LLM provider key for the agents you use | `pnpm voice:status` shows `set` / `not set` (never values) |
| A Mercury session token | see [Initial setup](#initial-setup) |

`pnpm voice:status` checks all of these at once.

## Initial setup

Do these once, in a PowerShell window at the repository root.

1. **Install dependencies:** `pnpm install`.
2. **Create the Postgres container**, only if `docker ps -a` does not list `xyp3rn-pg`:
   ```powershell
   docker run -d --name xyp3rn-pg -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16
   ```
3. **Apply the Supabase roles, then migrations.** The migrations expect the Supabase roles, so load
   `supabase/local/supabase-roles.sql` into the `postgres` and `template1` databases first:
   ```powershell
   Get-Content supabase\local\supabase-roles.sql | docker exec -i xyp3rn-pg psql -U postgres -v ON_ERROR_STOP=1
   Get-Content supabase\local\supabase-roles.sql | docker exec -i xyp3rn-pg psql -U postgres -d template1 -v ON_ERROR_STOP=1
   pnpm db:up
   ```
4. **Set provider keys** in the environment of the terminal that runs Mercury. Only the providers
   named in your agents' `model:` lines are needed:
   ```powershell
   $env:OPENROUTER_API_KEY = '<your key>'   # and/or ANTHROPIC_API_KEY, GROQ_API_KEY
   ```
5. **Create a login token.** Tokens are random, and only their hash is stored:
   ```powershell
   pnpm governance:user "Your Name" operator C:\Users\<you>\mercury.token
   ```
   - Roles:
     - `viewer`: read only.
     - `operator`: can Send requests.
     - `approver`: can approve or reject.
     - `admin`: everything.
   - Tokens last 8 hours. Run the command again with a new file name to get a new one.

## Start, check, stop

```powershell
pnpm voice:start     # starts xyp3rn-pg and xyp3rn-kokoro (creates the Kokoro container on first run), waits until healthy
pnpm voice:status    # prerequisites, Postgres, Kokoro, Mercury, Wispr Flow process, config names set/not set
pnpm dev             # Mercury (development), or for production:
pnpm build; pnpm start
```

Open <http://127.0.0.1:3000> and sign in with your token.

To stop:
- **Mercury:** press Ctrl+C in its terminal.
- **Kokoro:** `pnpm voice:stop`. This stops `xyp3rn-kokoro` and keeps the container, so the next
  `voice:start` resumes it.
- **Postgres:** `pnpm voice:stop` leaves it running, because the rest of the OS uses it. Stop it
  with `docker stop xyp3rn-pg`.

**Duplicates are avoided.** Containers are reused by name. `voice:start` refuses to start a second
Kokoro if something else already serves port 8880. Nothing is registered to start at OS login.

## Use it

1. **Pick a voice.** In the Assistant panel's **Speech** section, choose a **Voice**. The list
   comes from the running Kokoro service, limited to the supported set: `af_heart`, `af_bella`,
   `am_michael`, `am_fenrir`, `bf_emma`, `bm_george`. Set **Speed** (0.5–2.0×).
2. **Preview a voice.** After any reply, press **Play reply**. It uses the current voice and
   speed.
3. **Dictate.** Click the **Request** box so it has focus. Hold or press your Wispr Flow shortcut
   (set in Wispr Flow's settings; Mercury does not intercept it), speak, and release. Wispr inserts
   the text into the box.
4. **Review.**
   - Edit anything: typing, paste and Wispr text all edit the same way.
   - Enter adds a new line. Nothing is sent on insert, pause, Enter or leaving the box.
5. **Send.** Click **Send** (or Tab to it and press Space/Enter). The Assistant history shows:
   - **Running**, then one of **Succeeded**, **Failed**, **Needs clarification**, **On hold** or
     **Approval required**;
   - the reply;
   - run and artifact ids, a **Live events** link, and **Decide approval** links for approvals.
6. **Speech.**
   - Tick **Speak replies** to hear each new reply. Speech never starts until you tick it or press
     **Play reply**.
   - **Stop speaking** (or **Esc**) stops audio only. The OS work it describes keeps running. Use
     it before dictating a follow-up, since Mercury cannot tell when Wispr starts listening.
7. **Approvals.**
   - Approvals are never decided by dictation or by the Assistant. Saying "approve" just becomes
     request text, and the router answers "On hold".
   - An approver decides in the entity inspector (Decide approval link, or the Governance view),
     with a written reason.

If Send fails, your draft stays in the box. Pressing Send again reuses the same request id, so the
server never runs it twice.

## Where processing happens

| Step | Where | Notes |
|---|---|---|
| Dictation | **Wispr Flow, cloud** | Your voice goes to Wispr's service, and Wispr types the text into the box. Mercury only sees the typed text, and has no Wispr API, SDK or account link. |
| Reasoning | **The configured provider per agent** | Routing is local and deterministic. Each agent's `model:` picks Anthropic, Groq or OpenRouter (cloud APIs, keys from env). Agents with `model: none` run locally. |
| Speech | **Local Kokoro on this PC** | Mercury's server calls Kokoro-FastAPI on `127.0.0.1:8880` only. Non-loopback addresses are refused, and there is no cloud fallback. Before speaking, ids, URLs and secret-like strings are replaced; the full reply stays on screen. |
| Microphone | Wispr only | Mercury sends `Permissions-Policy: microphone=()` and never asks for the mic. |

## Configuration (names only)

| Variable | Default | Purpose |
|---|---|---|
| `XYP_DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5432/postgres` | OS database |
| `KOKORO_URL` | `http://127.0.0.1:8880` | Kokoro-FastAPI base URL; loopback only |
| `KOKORO_API_KEY` | unset | Optional Bearer token, sent only from server to Kokoro |
| `KOKORO_TIMEOUT_MS` | `30000` | Per-synthesis timeout |
| `KOKORO_IMAGE` | pinned `ghcr.io/remsky/kokoro-fastapi-cpu@sha256:ee3111d6…` | Image `voice:start` uses on first run |
| `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` | unset | LLM providers used by agents |

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Speech unavailable. Text reply is unaffected." | `pnpm voice:status`. Kokoro may still be loading, about 15–55 s after start. Run `pnpm voice:start`, then press **Play reply**. |
| "Your browser blocked audio playback" | Press **Play reply** once; the click allows audio. |
| "Speech is busy" | Two syntheses are already running; press **Play reply** again. |
| Voice list is empty / "No supported voices" | The Kokoro image lacks the supported voices. Use the pinned image (`KOKORO_IMAGE` unset). |
| Wispr text doesn't appear | Click inside the **Request** box first. Wispr types into the focused field. Check Wispr Flow's shortcut and that it's running (`pnpm voice:status`). |
| Send is disabled with a permission note | Your role lacks `runtime.execute`; sign in with an operator or admin token. |
| "Run status is no longer available" | Mercury restarted during a run; the run's record is in **Live events**. |
| Research requests fail at a specialist | Known runtime gap: some research specialists have no LLM program registered. It's not a voice issue (see `HANDOFF.md`). |
| `pnpm voice:start`: "no container named xyp3rn-pg" | Do step 2 of Initial setup. |

## Rollback

- **Turn voice off, keep everything else:**
  - Untick **Speak replies**.
  - `pnpm voice:stop` and optionally `docker rm xyp3rn-kokoro`.
  - Typed and Wispr text keep working without Kokoro.
- **Remove the feature entirely:**
  - Revert the voice commits (see `HANDOFF.md` for the exact list).
  - No database migration was added, so no DB rollback is needed.
- **Remove the image:** `docker rmi ghcr.io/remsky/kokoro-fastapi-cpu`.
