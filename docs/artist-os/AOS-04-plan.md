# AOS-04 — Research mode: implementation plan (Plan A of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Research mode that runs: the 20 specialists produce quote-verified evidence on the OpenRouter free route, runs synthesize into findings, briefs link to songs, lineages, workflows and decisions, and the owner accepts findings into a Findings Library and promotes them to canonical knowledge through the Promotion Gate, from the CLI and a web workbench.

**Architecture:** One migration adds the brief columns, the run deadline, `research_links` + retractions + `research_targets`, kept sources (`research_sources.text`, `research_evidence.quote` with a DB verbatim check), and the owner's finding decisions in `approval_queue` (`xyp_decide_finding`, `findings_library`). One shared LLM program serves all 20 specialists. `runResearch` splits into `openResearch` / `executeResearch` / `sweepResearch`, and a deterministic synthesis step writes findings. The web opens a run and executes it as a detached promise in the `next start` process (Next 14.2 has no `after()`).

**Tech Stack:** TypeScript on Node ≥ 22 (type stripping, no build for OS code), PostgreSQL (local Supabase), `postgres` client, vitest, Next.js 14.2.35 / React 18.3.1 (apps/web), playwright-core (smoke).

**Spec:** [AOS-04-design.md](AOS-04-design.md) §§1–11 and §17. §§12–16 and §§18–21 (Mercury interface) are **Plans B and C**, not this plan.

## Global Constraints

- Branch `claude/aos-04`, worktree `C:\Users\blago\Desktop\oss2\xyp3rn-os-2-aos04`. Never touch the neighbouring `xyp3rn-os-2` checkout or its `main`.
- Red tests first: every task commits its failing test before the code that turns it green (house rule since AOS-01).
- One migration: `supabase/migrations/20260926100000_research_mode.sql` with `supabase/rollbacks/20260926100000_research_mode.down.sql`. Idempotent both ways; no CASCADE; a rollback never deletes the owner's data (it refuses instead).
- R1: every `agents/*-researcher.agent.md` gets `model: openrouter:nvidia/nemotron-3-ultra-550b-a55b:free`. No other model or provider.
- R5 on Next 14.2.35: the server action awaits `openResearch`, then starts `executeResearch(runId)` **without awaiting it**; its rejection is caught and logged, and `executeResearch` seals the run itself. No Next upgrade.
- Research-table writes run as `xyp_research`; web reads as `xyp_web` in read-only transactions (`asWeb`); owner decisions as `service_role` (`OPERATOR_ROLE`).
- The model never supplies a URL; external sources are the brief's `urls` only. No sources means no LLM call.
- A finding gets **one** owner decision (`approval_queue_item_key` is unique on `(item_type, item_id)`), like an artifact version. A second decision is refused.
- Specialist steps run with `timeoutMs: LLM_TIMEOUT_MS` (1 800 000). Dispatch's 30 s default would kill every live specialist.
- Fixture text starts with `[FIXTURE]`; fake model output starts with `[FAKE]` (house rule).
- CI needs no key: the LLM is stubbed through the runner's `fetch` (`tests/helpers/fake-llm.ts`), and page fetches through `createRuntimeTools({ fetch })`.
- Gates before each push: `pnpm typecheck`, `pnpm test`, `pnpm agents:validate`, a migration down/up/down/up on the dev DB (`pnpm db:down` ×1, `pnpm db:up`, again), `pnpm web:build`.
- Commit messages: `AOS-04 red test: …` / `AOS-04: …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A quote that differs only typographically** (curly vs straight quotes, `…` vs `...`, NBSP): expected to be declined with the DB's "not found verbatim" reason, not written, not crash the specialist. Pinned in Task 3 (`declines a quote that differs typographically`).
2. **Brief URLs that fail** (404, timeout, PDF with no text, unsupported type): expected to be skipped with the reason in the output's `failedUrls`. When nothing is citable, there is no LLM call and the decline reason is `no sources`. Pinned in Task 3 (`skips a failing URL`, `no sources`).
3. **The free route overloaded mid-run** (429 after retries): expected to seal the run `error` with the provider message, keep earlier specialists' evidence (labelled partial on the workbench), and allow a re-run. Pinned in Task 5 (`a provider failure seals the run and keeps earlier evidence`).
4. **The server stops mid-run**: expected to leave the run `running` only until `expires_at`, then have the sweep seal it `abandoned`. Pinned in Task 5 (`sweep seals only runs past their deadline`).
5. **A bad brief** (unknown `F999`, a non-root lineage id, a `file://` URL, an unknown specialist name, blank intended use): expected to be refused **before** any row is written, with a message naming the field. Pinned in Task 5 (`refuses a bad brief before writing`).

## File map

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/20260926100000_research_mode.sql`, rollback | all DB changes | 1 |
| `tests/aos-04/research-db.test.ts` | DB contract | 1 |
| `research-intelligence/sources/fetch.ts`, `sources/verify.ts`, `tools/fetch-source.ts` | keep page text; injectable fetch | 2 |
| `research-intelligence/evidence/engine.ts`, `tools/write-evidence.ts` | `quote`; the canonical citation path | 2 |
| `core/runtime/tools.ts` | pass `fetch` to `fetch_source` | 2 |
| `research-intelligence/specialists/program.ts` | the shared grounded-evidence program | 3 |
| `core/runtime/programs.ts`, `agents/*-researcher.agent.md` | registration; R1 model | 3 |
| `research-intelligence/synthesis/synthesize.ts` | evidence → findings | 4 |
| `research-intelligence/orchestrator/select.ts`, `agents/research-orchestrator.ts` | owner override; brief inputs | 5 |
| `research-intelligence/brief.ts` | brief validation, targets, decision keys, workflows | 5 |
| `research-intelligence/entrypoint.ts` | `openResearch`, `executeResearch`, `sweepResearch`, `runResearch` | 5 |
| `research-intelligence/library.ts` | accept/reject, promote, decide promotion | 6 |
| `research-intelligence/cli.ts` | `ask`, `decide`, `promote` | 6 |
| `knowledge/vault-io/spec.ts`, `export.ts`, `import.ts` | research in `xyp-vault-export/v1` | 7 |
| `tests/aos-04/brief-to-canonical.test.ts` | the gate | 8 |
| `apps/web/server/research-loaders.ts`, `research-ops.ts`, `runtime.ts`, `lib/server.ts`, `instrumentation.ts`, `next.config.mjs` | web read/write | 9 |
| `apps/web/app/research/**`, `research-actions.ts`, layout, song/recipe/tag pages | screens | 10 |
| `apps/web/e2e/smoke.ts` | browser journey | 11 |
| docs, proof, spec patch | handoff | 12 |

---

### Task 1: Migration `20260926100000_research_mode`

**Files:**
- Create: `supabase/migrations/20260926100000_research_mode.sql`
- Create: `supabase/rollbacks/20260926100000_research_mode.down.sql`
- Test: `tests/aos-04/research-db.test.ts`

**Interfaces:**
- Produces (DB):
  - `research_questions.intended_use text`, `urls text[] not null default '{}'`, `specialists text[]`;
  - `research_runs.expires_at timestamptz not null` (UPDATE grant to `xyp_research`);
  - `research_sources.text`, `research_evidence.quote` (verbatim trigger);
  - `research_links`, `research_link_retractions`, views `research_targets`, `current_finding_decisions`, `findings_library`;
  - `xyp_decide_finding(uuid, text, text, text) returns uuid` (service_role);
  - `xyp_squash(text) returns text`, `xyp_all_http(text[]) returns boolean`;
  - `approval_item_type` value `research_finding`.

- [ ] **Step 1: Write the failing DB test**

```ts
// tests/aos-04/research-db.test.ts
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRole, createTestDb, expectPgError, type TestDb } from '../helpers/db.ts';
import { insertArtifact } from '../helpers/records-fixture.ts';

// AOS-04 §4: the brief, the run deadline, research_links, kept sources and quotes, and the owner's
// finding decisions. Admin connection sets up; asRole checks what each component role may do.

let db: TestDb;
let questionId: string;
let runId: string;
let webSourceId: string;
beforeAll(async () => {
  db = await createTestDb('aos04_db', { migrated: true });
  const [p] = await db.sql<{ id: string }[]>`insert into research_projects (slug, title) values ('aos04-db', '[FIXTURE] aos04') returning id`;
  const [q] = await db.sql<{ id: string }[]>`
    insert into research_questions (project_id, question, intended_use, urls)
    values (${p!.id}, '[FIXTURE] Where should the vocal descriptor go in a Suno style prompt?', '[FIXTURE] pick the recipe order', ${['https://example.org/suno']})
    returning id`;
  questionId = q!.id;
  const [r] = await db.sql<{ id: string }[]>`insert into research_runs (question_id) values (${questionId}) returning id`;
  runId = r!.id;
  const [s] = await db.sql<{ id: string }[]>`
    insert into research_sources (research_run_id, kind, uri, title, content_sha256, text)
    values (${runId}, 'web', 'https://example.org/suno', '[FIXTURE] Suno notes', ${createHash('sha256').update(randomUUID()).digest('hex')},
            '[FIXTURE] Put the vocal descriptor   first in the style prompt; Suno weighs early words more.')
    returning id`;
  webSourceId = s!.id;
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const evidence = (tx: import('postgres').TransactionSql, quote: string | null) => tx`
  insert into research_evidence (research_run_id, research_source_id, specialist, claim, model_tag, confidence, confidence_inputs, quote)
  values (${runId}, ${webSourceId}, 'suno-researcher', '[FIXTURE] descriptor first', 'suno-v5', 0.6, ${tx.json({ basis: 'fixture' })}, ${quote})`;

describe('the brief (§4)', () => {
  it('stores intended use, urls and the owner override; refuses a non-http url and an empty override', async () => {
    const [q] = await db.sql<{ intended_use: string; urls: string[]; specialists: string[] | null }[]>`
      select intended_use, urls, specialists from research_questions where id = ${questionId}`;
    expect(q).toEqual({ intended_use: '[FIXTURE] pick the recipe order', urls: ['https://example.org/suno'], specialists: null });
    const [p] = await db.sql<{ id: string }[]>`select id from research_projects where slug = 'aos04-db'`;
    await expectPgError(() => db.sql`insert into research_questions (project_id, question, urls) values (${p!.id}, '[FIXTURE] x', ${['file:///etc/passwd']})`, '23514');
    await expectPgError(() => db.sql`insert into research_questions (project_id, question, specialists) values (${p!.id}, '[FIXTURE] x', ${[] as string[]})`, '23514');
  });

  it('keeps the brief immutable for xyp_research (only status is updatable)', async () => {
    await expectPgError(() => asRole(db.sql, 'xyp_research', (tx) => tx`update research_questions set intended_use = 'changed' where id = ${questionId}`), '42501');
  });
});

describe('the run deadline (§4)', () => {
  it('defaults expires_at to about ten minutes out and lets xyp_research raise it', async () => {
    const [r] = await db.sql<{ mins: number }[]>`select extract(epoch from expires_at - created_at) / 60 as mins from research_runs where id = ${runId}`;
    expect(Number(r!.mins)).toBeGreaterThan(9);
    expect(Number(r!.mins)).toBeLessThan(11);
    await asRole(db.sql, 'xyp_research', (tx) => tx`update research_runs set expires_at = now() + interval '1 hour' where id = ${runId}`);
  });
});

describe('kept sources and quotes (§4, §5)', () => {
  it('accepts a quote found verbatim (whitespace squashed) and a null quote (the human paths)', async () => {
    await asRole(db.sql, 'xyp_research', async (tx) => {
      await evidence(tx, 'Put the vocal descriptor first in the style prompt');
      await evidence(tx, null);
    });
  });

  it('refuses a quote the source does not contain, including a typographic variant', async () => {
    await expectPgError(() => asRole(db.sql, 'xyp_research', (tx) => evidence(tx, 'Put the vocal descriptor last')), '23514');
    await expectPgError(() => asRole(db.sql, 'xyp_research', (tx) => evidence(tx, 'Suno weighs early words more…')), '23514');
  });

  it('verifies a quote of an ingested source against the canonical bodies quoting it', async () => {
    const sha = createHash('sha256').update(randomUUID()).digest('hex');
    const [src] = await db.sql<{ id: string }[]>`
      insert into sources (uri, title, kind, checksum_sha256) values ('file:///fixture/suno.md', '[FIXTURE] suno.md', 'markdown', ${sha}) returning id`;
    const [m] = await db.sql<{ id: string }[]>`select id from modules limit 1`;
    await db.sql`
      insert into canonical_prompts (slug, title, body, domain, source_id, module_id)
      values ('fixture-suno-order', '[FIXTURE] order', '[FIXTURE] Lead with the vocal descriptor.', 'RECORDS', ${src!.id}, ${m?.id ?? null})`;
    const [rs] = await db.sql<{ id: string }[]>`
      insert into research_sources (research_run_id, source_id, kind, uri, title, content_sha256)
      values (${runId}, ${src!.id}, 'ingested', 'file:///fixture/suno.md', '[FIXTURE] suno.md', ${sha}) returning id`;
    await asRole(db.sql, 'xyp_research', (tx) => tx`
      insert into research_evidence (research_run_id, research_source_id, specialist, claim, model_tag, confidence, confidence_inputs, quote)
      values (${runId}, ${rs!.id}, 'suno-researcher', '[FIXTURE] lead with it', 'model-agnostic', 0.7, ${tx.json({ basis: 'fixture' })}, 'Lead with the vocal descriptor.')`);
  });
});

describe('research_links (R2)', () => {
  it('links a lineage root, a workflow and a decision; refuses a second target, a non-root, a bad key and a duplicate live link', async () => {
    const root = await insertArtifact(db.sql, 'x3lius.style-recipe/v1', { name: '[FIXTURE] recipe', style: '[FIXTURE] dark pop', excludeStyles: [], mood: [], production: [], notes: [] });
    await asRole(db.sql, 'xyp_research', async (tx) => {
      await tx`insert into research_links (question_id, artifact_lineage_id) values (${questionId}, ${root})`;
      await tx`insert into research_links (question_id, workflow_name, workflow_sha256) values (${questionId}, 'build-suno-package', ${'a'.repeat(64)})`;
      await tx`insert into research_links (question_id, decision_key, role) values (${questionId}, 'F41', 'informs')`;
      const t = await tx<{ kind: string; target: string }[]>`select kind, target from research_targets where question_id = ${questionId} order by kind`;
      expect(t.map((x) => x.kind)).toEqual(['decision', 'lineage', 'workflow']);
    });
    await expectPgError(() => db.sql`insert into research_links (question_id, decision_key, workflow_name, workflow_sha256) values (${questionId}, 'F1', 'x', ${'a'.repeat(64)})`, '23514');
    await expectPgError(() => db.sql`insert into research_links (question_id, decision_key) values (${questionId}, 'D2')`, '23514');
    await expectPgError(() => db.sql`insert into research_links (question_id, workflow_name) values (${questionId}, 'build-suno-package')`, '23514');
    await db.sql`insert into research_links (question_id, decision_key) values (${questionId}, 'F40')`;
    await expectPgError(() => db.sql`insert into research_links (question_id, decision_key) values (${questionId}, 'F40')`, '23505');
  });

  it('retracts without deleting: the link leaves research_targets, and a re-link is then allowed', async () => {
    const [l] = await db.sql<{ id: string }[]>`insert into research_links (question_id, decision_key) values (${questionId}, 'F39') returning id`;
    await asRole(db.sql, 'xyp_research', (tx) => tx`insert into research_link_retractions (research_link_id, reason) values (${l!.id}, '[FIXTURE] wrong decision')`);
    await db.sql`insert into research_link_retractions (research_link_id, reason) values (${l!.id}, '[FIXTURE] wrong decision')`;
    expect(await db.sql`select 1 from research_targets where link_id = ${l!.id}`).toHaveLength(0);
    await db.sql`insert into research_links (question_id, decision_key) values (${questionId}, 'F39')`;
    await expectPgError(() => db.sql`update research_links set role = 'x' where id = ${l!.id}`, '55000');
    await expectPgError(() => db.sql`delete from research_links where id = ${l!.id}`, '55000');
  });

  it('shows songs that link the brief (song_links, A1) as song targets', async () => {
    const [runRow] = await db.sql<{ id: string }[]>`insert into agent_runs (agent_name, agent_class, status, input) values ('records-songs', 'Records', 'success', '{}') returning id`;
    const [song] = await db.sql<{ id: string }[]>`insert into songs (agent_run_id) values (${runRow!.id}) returning id`;
    await db.sql`insert into song_links (song_id, research_question_id, agent_run_id) values (${song!.id}, ${questionId}, ${runRow!.id})`;
    const t = await db.sql<{ kind: string; target: string }[]>`select kind, target from research_targets where question_id = ${questionId} and kind = 'song'`;
    expect(t).toEqual([{ kind: 'song', target: song!.id }]);
  });
});

describe('the owner\'s finding decisions (R3)', () => {
  let findingId: string;
  beforeAll(async () => {
    const [f] = await db.sql<{ id: string }[]>`
      insert into research_findings (research_run_id, claim, model_tag, confidence, confidence_inputs, claim_topic, claim_value)
      values (${runId}, '[FIXTURE] descriptor first', 'suno-v5', 0.6, ${db.sql.json({ basis: 'fixture' })}, 'suno.vocal-descriptor-position', ${db.sql.json('first')})
      returning id`;
    findingId = f!.id;
  });

  it('records one decision as service_role, shows it in the library, refuses a second one and every other role', async () => {
    await expectPgError(() => asRole(db.sql, 'xyp_research', (tx) => tx`select xyp_decide_finding(${findingId}, 'accept', 'owner', 'x')`), '42501');
    await expectPgError(() => db.sql`select xyp_decide_finding(${findingId}, 'maybe', 'owner', 'x')`, '22023');
    await expectPgError(() => db.sql`select xyp_decide_finding(${findingId}, 'accept', 'owner', ' ')`, '22023');
    await asRole(db.sql, 'service_role', (tx) => tx`select xyp_decide_finding(${findingId}, 'accept', 'owner', '[FIXTURE] reusable')`);
    await db.sql`select xyp_decide_finding(${findingId}, 'accept', 'owner', '[FIXTURE] reusable')`;
    await expectPgError(() => db.sql`select xyp_decide_finding(${findingId}, 'reject', 'owner', '[FIXTURE] changed my mind')`, '23505');
    const lib = await db.sql<{ finding_id: string; canonical_status: string; evidence_count: number }[]>`
      select finding_id, canonical_status, evidence_count from findings_library`;
    expect(lib).toEqual([{ finding_id: findingId, canonical_status: 'none', evidence_count: 0 }]);
    const [d] = await db.sql<{ decision: string }[]>`select decision from current_finding_decisions where finding_id = ${findingId}`;
    expect(d!.decision).toBe('accept');
  });

  it('touches no canonical table', async () => {
    expect(await db.sql`select 1 from knowledge_candidates where finding_id = ${findingId}`).toHaveLength(0);
  });

  it('lets xyp_web read the library, the targets and the research chain', async () => {
    await asRole(db.sql, 'xyp_web', async (tx) => {
      await tx`select * from findings_library`;
      await tx`select * from research_targets`;
      await tx`select * from research_finding_evidence`;
      await tx`select * from contradictions`;
      await tx`select * from knowledge_candidates`;
      await tx`select * from current_finding_decisions`;
    });
  });
});
```

Before relying on the `sources`, `canonical_prompts`, `agent_runs` and `songs` column lists in the fixture inserts above, read them with `\d` (or `select column_name, is_nullable from information_schema.columns where table_name = …`) on the dev DB and adjust **only the fixture inserts** to the real required columns. The assertions stay as written.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/aos-04/research-db.test.ts`
Expected: FAIL, first on `column "intended_use" of relation "research_questions" does not exist`.

- [ ] **Step 3: Commit the red test**

```bash
git add tests/aos-04/research-db.test.ts
git commit -m "AOS-04 red test: the research_mode migration (brief, deadline, links, kept quotes, finding decisions)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Write the migration**

```sql
-- supabase/migrations/20260926100000_research_mode.sql
-- AOS-04: Research mode (docs/artist-os/AOS-04-design.md §4). What it adds:
-- - the brief                 research_questions.intended_use, urls, specialists; set at insert (xyp_research may
--                             update status only, as before)
-- - the run deadline          research_runs.expires_at; the sweep seals a running run past it as abandoned
-- - research_links (R2)       a brief's typed targets: an artifact lineage root, a workflow (name + spec sha256) or
--                             an ARCHITECTURE decision (F<n>); research_link_retractions unlink; research_targets
--                             adds the songs that link the brief (song_links, A1)
-- - kept sources              research_sources.text (what a fetch read) and research_evidence.quote (the passage behind
--                             a claim), checked verbatim against its source on insert
-- - the Findings Library (R3) xyp_decide_finding: the owner's accept/reject, one per finding, recorded decided in
--                             approval_queue; current_finding_decisions; findings_library
-- Rows written before AOS-04 stay as they are. Idempotent. Rollback: supabase/rollbacks/20260926100000_research_mode.down.sql

alter type public.approval_item_type add value if not exists 'research_finding';

-- ─── helpers ────────────────────────────────────────────────────────────────────────────────────
create or replace function public.xyp_squash(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select btrim(regexp_replace(p, '[[:space:]]+', ' ', 'g')) $$;

create or replace function public.xyp_all_http(p text[])
returns boolean
language sql
immutable
set search_path = ''
as $$ select coalesce(bool_and(u is not null and u ~ '^https?://[^[:space:]]+$'), true) from unnest(p) u $$;

-- ─── the brief ──────────────────────────────────────────────────────────────────────────────────
alter table public.research_questions add column if not exists intended_use text;
alter table public.research_questions add column if not exists urls text[] not null default '{}';
alter table public.research_questions add column if not exists specialists text[];

do $$ begin
  if not exists (select from pg_constraint where conname = 'research_questions_intended_use_check') then
    alter table public.research_questions add constraint research_questions_intended_use_check
      check (intended_use is null or length(btrim(intended_use)) > 0);
  end if;
  if not exists (select from pg_constraint where conname = 'research_questions_urls_check') then
    alter table public.research_questions add constraint research_questions_urls_check check (public.xyp_all_http(urls));
  end if;
  if not exists (select from pg_constraint where conname = 'research_questions_specialists_check') then
    alter table public.research_questions add constraint research_questions_specialists_check
      check (specialists is null or cardinality(specialists) > 0);
  end if;
end $$;

-- ─── the run deadline ───────────────────────────────────────────────────────────────────────────
-- A non-volatile default fills existing rows at ALTER time without an UPDATE (sealed runs refuse updates).
alter table public.research_runs add column if not exists expires_at timestamptz not null default (now() + interval '10 minutes');
grant update (expires_at) on table public.research_runs to xyp_research;

-- ─── kept sources and quotes ────────────────────────────────────────────────────────────────────
alter table public.research_sources add column if not exists text text;
alter table public.research_evidence add column if not exists quote text;

do $$ begin
  if not exists (select from pg_constraint where conname = 'research_sources_text_check') then
    alter table public.research_sources add constraint research_sources_text_check check (text is null or length(text) <= 20000);
  end if;
  if not exists (select from pg_constraint where conname = 'research_evidence_quote_check') then
    alter table public.research_evidence add constraint research_evidence_quote_check check (quote is null or length(btrim(quote)) > 0);
  end if;
end $$;

-- SECURITY DEFINER: reads the source's stored text and the canonical bodies quoting an ingested source.
create or replace function public.xyp_research_evidence_quote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_text text;
  v_source uuid;
  v_q text;
begin
  if new.quote is null then
    return new;
  end if;
  v_q := public.xyp_squash(new.quote);
  select s.text, s.source_id into v_text, v_source from public.research_sources s where s.id = new.research_source_id;
  if not found then
    return new; -- the foreign key reports it
  end if;
  if v_text is not null and position(v_q in public.xyp_squash(v_text)) > 0 then
    return new;
  end if;
  if v_source is not null and exists (
    select from public.canonical_prompts c where c.source_id = v_source and position(v_q in public.xyp_squash(c.body)) > 0
  ) then
    return new;
  end if;
  raise exception 'research_evidence: quote not found verbatim in research source %: "%"', new.research_source_id, left(v_q, 120)
    using errcode = 'check_violation';
end;
$$;

create or replace trigger trg_research_evidence_quote before insert on public.research_evidence
  for each row execute function public.xyp_research_evidence_quote();
revoke execute on function public.xyp_research_evidence_quote() from public, anon, authenticated;

-- ─── research_links (R2) ────────────────────────────────────────────────────────────────────────
create table if not exists public.research_links (
  id                  uuid primary key default gen_random_uuid(),
  question_id         uuid not null references public.research_questions (id) on delete restrict,
  role                text,
  artifact_lineage_id uuid references public.creative_artifacts (id) on delete restrict,
  workflow_name       text,
  workflow_sha256     text,
  decision_key        text,
  created_at          timestamptz not null default now(),
  -- A song target is song_links.research_question_id (A1), never a column here.
  constraint research_links_target_check check (num_nonnulls(artifact_lineage_id, workflow_name, decision_key) = 1),
  constraint research_links_workflow_check check ((workflow_name is null) = (workflow_sha256 is null)),
  constraint research_links_workflow_name_check check (workflow_name is null or workflow_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint research_links_workflow_sha256_check check (workflow_sha256 is null or workflow_sha256 ~ '^[0-9a-f]{64}$'),
  constraint research_links_decision_key_check check (decision_key is null or decision_key ~ '^F[0-9]+$'),
  constraint research_links_role_check check (role is null or length(btrim(role)) > 0)
);

create table if not exists public.research_link_retractions (
  research_link_id uuid primary key references public.research_links (id) on delete restrict,
  reason           text not null,
  created_at       timestamptz not null default now(),
  constraint research_link_retractions_reason_check check (length(btrim(reason)) > 0)
);

create index if not exists research_links_question_id_idx on public.research_links (question_id);
create index if not exists research_links_artifact_lineage_id_idx on public.research_links (artifact_lineage_id);

-- SECURITY DEFINER: reads creative_artifacts (the root check) and every link of the brief.
create or replace function public.xyp_research_links_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('xyp:research_links:' || new.question_id::text));
  if new.artifact_lineage_id is not null
     and not exists (select from public.creative_artifacts a where a.id = new.artifact_lineage_id and a.lineage_id = a.id) then
    raise exception 'research_links: artifact % is not a lineage root; link the lineage''s first version', new.artifact_lineage_id
      using errcode = 'check_violation';
  end if;
  if exists (
    select from public.research_links l
    where l.question_id = new.question_id
      and l.artifact_lineage_id is not distinct from new.artifact_lineage_id
      and l.workflow_name is not distinct from new.workflow_name
      and l.workflow_sha256 is not distinct from new.workflow_sha256
      and l.decision_key is not distinct from new.decision_key
      and not exists (select from public.research_link_retractions r where r.research_link_id = l.id)
  ) then
    raise exception 'research_links: brief % already has a live link to this target', new.question_id using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_research_links_guard before insert on public.research_links
  for each row execute function public.xyp_research_links_guard();
revoke execute on function public.xyp_research_links_guard() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['research_links', 'research_link_retractions'] loop
    execute format('create or replace trigger %I before update or delete on public.%I for each row execute function public.xyp_vault_immutable()',
      'trg_' || t || '_immutable', t);
  end loop;
end $$;

create or replace view public.research_targets with (security_invoker = true) as
  select l.research_question_id as question_id, 'song'::text as kind, l.song_id::text as target, l.role, l.id as link_id,
         'song_links'::text as via, l.created_at
  from public.current_song_links l
  where l.research_question_id is not null
  union all
  select r.question_id,
         case when r.artifact_lineage_id is not null then 'lineage' when r.workflow_name is not null then 'workflow' else 'decision' end,
         coalesce(r.artifact_lineage_id::text, r.workflow_name || '@' || r.workflow_sha256, r.decision_key),
         r.role, r.id, 'research_links', r.created_at
  from public.research_links r
  where not exists (select from public.research_link_retractions x where x.research_link_id = r.id);

-- ─── the owner's finding decisions (R3) ─────────────────────────────────────────────────────────
-- Recorded already decided, like xyp_decide_artifact: one decision per finding (approval_queue_item_key).
-- 'accept' puts the finding in the Findings Library; neither decision touches a canonical table.
create or replace function public.xyp_decide_finding(p_finding_id uuid, p_decision text, p_approver text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f record;
  v_id uuid;
begin
  if p_decision is null or p_decision not in ('accept', 'reject') then
    raise exception 'decision must be accept or reject, got %', p_decision using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_approver), '') = '' or coalesce(btrim(p_reason), '') = '' then
    raise exception 'a decision needs an approver and a reason' using errcode = 'invalid_parameter_value';
  end if;
  select f.id, f.research_run_id, f.claim, f.claim_topic into v_f from public.research_findings f where f.id = p_finding_id;
  if not found then
    raise exception 'no finding %', p_finding_id using errcode = 'foreign_key_violation';
  end if;
  insert into public.approval_queue (item_type, item_id, request, status, decided_at, decided_by, decision_reason)
  values ('research_finding', p_finding_id,
          jsonb_build_object('reason', 'the owner''s decision on a research finding (the Findings Library; not canonical)',
                             'findingId', v_f.id, 'researchRunId', v_f.research_run_id, 'claimTopic', v_f.claim_topic, 'claim', v_f.claim),
          (case p_decision when 'accept' then 'approved' else 'rejected' end)::public.approval_status,
          now(), p_approver, p_reason)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.xyp_decide_finding(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.xyp_decide_finding(uuid, text, text, text) to service_role;

create or replace view public.current_finding_decisions with (security_invoker = true) as
  select q.item_id as finding_id, case q.status::text when 'approved' then 'accept' else 'reject' end as decision,
         q.id as approval_id, q.decided_by, q.decided_at, q.decision_reason
  from public.approval_queue q
  where q.item_type::text = 'research_finding';

create or replace view public.findings_library with (security_invoker = true) as
  select f.id as finding_id, f.claim, f.claim_topic, f.claim_value, f.model_tag, f.confidence, f.created_at,
         f.research_run_id, rr.question_id, q.question, q.intended_use, d.decided_by, d.decided_at, d.decision_reason,
         (select count(*)::int from public.research_finding_evidence fe where fe.finding_id = f.id) as evidence_count,
         coalesce((select case when bool_or(k.status::text = 'promoted') then 'promoted'
                               when bool_or(k.status::text in ('proposed', 'pending_approval')) then 'candidate'
                               else 'rejected' end
                   from public.knowledge_candidates k where k.finding_id = f.id), 'none') as canonical_status
  from public.research_findings f
  join public.current_finding_decisions d on d.finding_id = f.id and d.decision = 'accept'
  join public.research_runs rr on rr.id = f.research_run_id
  join public.research_questions q on q.id = rr.question_id;

-- ─── RLS + grants ───────────────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['research_links', 'research_link_retractions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'research_select') then
      execute format('create policy research_select on public.%I for select to xyp_research using (true)', t);
    end if;
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'research_insert') then
      execute format('create policy research_insert on public.%I for insert to xyp_research with check (true)', t);
    end if;
  end loop;
  foreach t in array array['research_links', 'research_link_retractions', 'research_finding_evidence', 'contradictions', 'knowledge_candidates'] loop
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'web_select') then
      execute format('create policy web_select on public.%I for select to xyp_web using (true)', t);
    end if;
  end loop;
end $$;

grant select, insert on table public.research_links, public.research_link_retractions to xyp_research;
grant select on table public.research_targets, public.current_song_links to xyp_research;
grant select on table public.research_links, public.research_link_retractions, public.research_targets, public.research_finding_evidence,
  public.contradictions, public.knowledge_candidates, public.current_finding_decisions, public.findings_library to xyp_web;
```

`research_targets` is `security_invoker`, so `xyp_research` also needs SELECT on `song_links` and `song_link_retractions` for its song half. If the Step 5 run shows `42501` on `research_targets` as `xyp_research`, add those two tables to the `grant select … to xyp_research` line and create `research_select` policies on them in the loop.

- [ ] **Step 5: Write the rollback**

```sql
-- supabase/rollbacks/20260926100000_research_mode.down.sql
-- Rollback for 20260926100000_research_mode.sql. Idempotent. No CASCADE.
-- Refuses while the owner has decided a finding, linked a brief, or a specialist has written a quote or a
-- page's text: dropping them would lose the owner's data or the sources' proof, and a rollback never deletes data.
-- The enum value research_finding stays (Postgres can't drop one), as in the Phase 14 rollback.

-- Nested IFs: a table or column a second run already dropped must not be named in the condition testing for it.
do $$ begin
  if exists (select from public.approval_queue where item_type::text = 'research_finding') then
    raise exception 'rollback 20260926100000: the owner has decided research findings; a rollback never deletes decisions';
  end if;
  if to_regclass('public.research_links') is not null then
    if exists (select from public.research_links) then
      raise exception 'rollback 20260926100000: briefs have research links; retracting is not deleting';
    end if;
  end if;
  if exists (select from information_schema.columns where table_schema = 'public' and table_name = 'research_evidence' and column_name = 'quote') then
    if exists (select from public.research_evidence where quote is not null) then
      raise exception 'rollback 20260926100000: evidence carries quotes; dropping them would lose the claims'' proof';
    end if;
  end if;
  if exists (select from information_schema.columns where table_schema = 'public' and table_name = 'research_sources' and column_name = 'text') then
    if exists (select from public.research_sources where text is not null) then
      raise exception 'rollback 20260926100000: research sources keep page text; dropping it would lose the sources';
    end if;
  end if;
  if exists (select from information_schema.columns where table_schema = 'public' and table_name = 'research_questions' and column_name = 'intended_use') then
    if exists (select from public.research_questions where intended_use is not null or urls <> '{}' or specialists is not null) then
      raise exception 'rollback 20260926100000: briefs carry an intended use, urls or an owner selection';
    end if;
  end if;
end $$;

drop view if exists public.findings_library;
drop view if exists public.current_finding_decisions;
drop function if exists public.xyp_decide_finding(uuid, text, text, text);
drop view if exists public.research_targets;
drop table if exists public.research_link_retractions;
drop table if exists public.research_links;
drop function if exists public.xyp_research_links_guard();

do $$ begin
  if to_regclass('public.research_evidence') is not null then
    drop trigger if exists trg_research_evidence_quote on public.research_evidence;
  end if;
end $$;
drop function if exists public.xyp_research_evidence_quote();

alter table if exists public.research_evidence drop constraint if exists research_evidence_quote_check;
alter table if exists public.research_evidence drop column if exists quote;
alter table if exists public.research_sources drop constraint if exists research_sources_text_check;
alter table if exists public.research_sources drop column if exists text;
do $$ begin
  if to_regclass('public.research_runs') is not null then
    revoke update (expires_at) on table public.research_runs from xyp_research;
  end if;
end $$;
alter table if exists public.research_runs drop column if exists expires_at;
alter table if exists public.research_questions drop constraint if exists research_questions_specialists_check;
alter table if exists public.research_questions drop constraint if exists research_questions_urls_check;
alter table if exists public.research_questions drop constraint if exists research_questions_intended_use_check;
alter table if exists public.research_questions drop column if exists specialists;
alter table if exists public.research_questions drop column if exists urls;
alter table if exists public.research_questions drop column if exists intended_use;
drop function if exists public.xyp_all_http(text[]);
drop function if exists public.xyp_squash(text);
```

- [ ] **Step 6: Run the test and a round trip**

Run: `pnpm vitest run tests/aos-04/research-db.test.ts tests/phase-01`
Expected: PASS. `tests/phase-01/migrations.test.ts` walks every migration up and down, so the new pair is exercised there too.

Run on the dev DB: `pnpm db:up && pnpm db:down && pnpm db:up && pnpm db:down && pnpm db:up`. Each `db:down` rolls back only the latest migration.
Expected: each command exits 0.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260926100000_research_mode.sql supabase/rollbacks/20260926100000_research_mode.down.sql tests/aos-04/research-db.test.ts
git commit -m "AOS-04: migration research_mode (brief, run deadline, research_links, verified quotes, owner finding decisions, findings_library)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Kept sources and the evidence write path

**Files:**
- Modify: `research-intelligence/sources/fetch.ts` (`fetchSource` takes a fetch)
- Modify: `research-intelligence/sources/verify.ts` (`RegisterSourceInput.text`)
- Modify: `research-intelligence/tools/fetch-source.ts`
- Modify: `research-intelligence/evidence/engine.ts`
- Modify: `research-intelligence/tools/write-evidence.ts`
- Test: `tests/aos-04/evidence-tools.test.ts`

**Interfaces:**
- Consumes: Task 1's `research_sources.text`, `research_evidence.quote` and its trigger.
- Produces:
  - `fetchSource(url: string, fetchFn?: typeof fetch): Promise<FetchedSource>`;
  - `registerResearchSource(sql, { …, text?: string })`;
  - `createFetchSourceTool(deps: { sql: Sql; fetch?: typeof fetch })` stores `text`;
  - `EvidenceInput.quote?: unknown`;
  - `write_evidence` args: `quote` (required when the caller is an agent) plus exactly one of `research_source_id` or `canonical_prompt_id`. Returns `{ evidence_id, research_source_id }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/aos-04/evidence-tools.test.ts
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { insertResearchRun } from '../helpers/tech-fixture.ts';

// AOS-04 §5 step 4: fetch_source keeps the page's text; write_evidence requires a quote from an agent and
// cites either a fetched page or an ingested source through a canonical row; the DB verifies the quote.

let db: TestDb;
let researchRunId: string;
const PAGE = '<html><head><title>[FIXTURE] Suno tips</title></head><body><p>[FIXTURE] Put the vocal descriptor first.</p></body></html>';
const fetchStub: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('missing')) return new Response('nope', { status: 404 });
  return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
};
const ctx = (agentName = 'suno-researcher') => ({ runId: randomUUID(), agentName, researchRunId, log: () => {} });

beforeAll(async () => {
  db = await createTestDb('aos04_evidence', { migrated: true });
  researchRunId = await insertResearchRun(db.sql);
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const tools = () => createRuntimeTools({ sql: db.sql, env: {}, fetch: fetchStub });
const call = (name: string, args: unknown, c = ctx()) => tools().get(name)!.handler(c as never, args);

describe('fetch_source', () => {
  it('stores the text it read, so a quote can be re-verified later', async () => {
    const r = (await call('fetch_source', { url: 'https://example.org/suno-tips' })) as { research_source_id: string; text: string };
    expect(r.text).toContain('Put the vocal descriptor first.');
    const [s] = await db.sql<{ text: string }[]>`select text from research_sources where id = ${r.research_source_id}`;
    expect(s!.text).toContain('Put the vocal descriptor first.');
  });

  it('fails loudly on a non-2xx page', async () => {
    await expect(call('fetch_source', { url: 'https://example.org/missing' })).rejects.toThrow(/HTTP 404/);
  });
});

describe('write_evidence', () => {
  const base = { claim: '[FIXTURE] descriptor first', claim_topic: 'suno.vocal-descriptor-position', claim_value: 'first', model_tag: 'suno-v5', confidence: 0.6, confidence_inputs: { basis: 'fixture', directness: 'direct' } };

  it('writes a quoted claim against a fetched page', async () => {
    const page = (await call('fetch_source', { url: 'https://example.org/suno-tips' })) as { research_source_id: string };
    const r = (await call('write_evidence', { ...base, research_source_id: page.research_source_id, quote: 'Put the vocal descriptor first.' })) as { evidence_id: string };
    const [e] = await db.sql<{ quote: string; specialist: string }[]>`select quote, specialist from research_evidence where id = ${r.evidence_id}`;
    expect(e).toEqual({ quote: 'Put the vocal descriptor first.', specialist: 'suno-researcher' });
  });

  it('refuses an agent write without a quote, and one with both or neither source', async () => {
    const page = (await call('fetch_source', { url: 'https://example.org/suno-tips' })) as { research_source_id: string };
    await expect(call('write_evidence', { ...base, research_source_id: page.research_source_id })).rejects.toThrow(/quote is required/);
    await expect(call('write_evidence', { ...base, quote: 'x' })).rejects.toThrow(/exactly one of research_source_id or canonical_prompt_id/);
    await expect(call('write_evidence', { ...base, quote: 'x', research_source_id: page.research_source_id, canonical_prompt_id: randomUUID() }))
      .rejects.toThrow(/exactly one of research_source_id or canonical_prompt_id/);
  });

  it('refuses a quote the page does not contain (the DB check)', async () => {
    const page = (await call('fetch_source', { url: 'https://example.org/suno-tips' })) as { research_source_id: string };
    await expect(call('write_evidence', { ...base, research_source_id: page.research_source_id, quote: 'Put the vocal descriptor last.' }))
      .rejects.toThrow(/quote not found verbatim/);
  });

  it('cites an ingested source through a canonical row and verifies the quote in its body', async () => {
    const sha = createHash('sha256').update(randomUUID()).digest('hex');
    const [src] = await db.sql<{ id: string }[]>`insert into sources (uri, title, kind, checksum_sha256) values ('file:///fixture/rules.md', '[FIXTURE] rules', 'markdown', ${sha}) returning id`;
    const [cp] = await db.sql<{ id: string }[]>`
      insert into canonical_prompts (slug, title, body, domain, source_id) values ('fixture-rules', '[FIXTURE] rules', '[FIXTURE] Lead with the vocal descriptor.', 'RECORDS', ${src!.id}) returning id`;
    const r = (await call('write_evidence', { ...base, canonical_prompt_id: cp!.id, quote: 'Lead with the vocal descriptor.' })) as { evidence_id: string; research_source_id: string };
    const [s] = await db.sql<{ kind: string; source_id: string }[]>`select kind::text, source_id from research_sources where id = ${r.research_source_id}`;
    expect(s).toEqual({ kind: 'ingested', source_id: src!.id });
  });

  it('refuses a canonical row with no source (not citable)', async () => {
    const [cp] = await db.sql<{ id: string }[]>`
      insert into canonical_prompts (slug, title, body, domain) values ('fixture-nosource', '[FIXTURE] x', '[FIXTURE] body', 'RECORDS') returning id`;
    await expect(call('write_evidence', { ...base, canonical_prompt_id: cp!.id, quote: 'body' })).rejects.toThrow(/has no source; not citable/);
  });
});
```

As in Task 1, check the real required columns of `sources` and `canonical_prompts` (`\d`) and adjust only the fixture inserts. `tools().get(name)` assumes `ToolRegistry` exposes `get`; if it exposes something else (read `core/tool-registry/registry.ts`), use that accessor.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/aos-04/evidence-tools.test.ts`
Expected: FAIL, first on the real network fetch or `text` being null.

- [ ] **Step 3: Commit the red test**

```bash
git add tests/aos-04/evidence-tools.test.ts
git commit -m "AOS-04 red test: fetch_source keeps page text; write_evidence requires a verified quote and cites canonical rows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Implement**

`research-intelligence/sources/fetch.ts`: change the signature and the one fetch call.

```ts
export const fetchSource = async (url: string, fetchFn: typeof fetch = fetch): Promise<FetchedSource> => {
  if (!/^https?:\/\//i.test(url)) throw new Error(`fetch_source: only http(s) URLs are allowed: ${url}`);
  const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  // … unchanged below
```

`research-intelligence/sources/verify.ts`: add `readonly text?: string;` to `RegisterSourceInput`, and write it in the insert.

```ts
      insert into research_sources (research_run_id, source_id, kind, uri, title, content_sha256, excerpt, text, reliability, reliability_inputs)
      values (${input.researchRunId}, ${input.sourceId ?? null}, ${input.kind}, ${input.uri}, ${input.title}, ${input.contentSha256},
              ${input.excerpt ?? null}, ${input.text ?? null}, ${rel.score}, ${tx.json({ class: rel.class, ...rel.inputs })})
```

`research-intelligence/tools/fetch-source.ts`:

```ts
export const createFetchSourceTool = (deps: { readonly sql: Sql; readonly fetch?: typeof fetch }): Tool =>
  defineTool({
    name: 'fetch_source',
    capability: 'web.read',
    description: `Fetch an http(s) URL, register it as a research source with its text (dedup by content), return up to ${TEXT_LIMIT} chars of text.`,
    handler: async (ctx, args) => {
      if (!ctx.researchRunId) throw new Error('fetch_source requires a research run');
      const url = (args as { url?: unknown } | null)?.url;
      if (typeof url !== 'string') throw new Error('fetch_source: url must be a string');
      const page = await fetchSource(url, deps.fetch);
      const src = await registerResearchSource(deps.sql, {
        researchRunId: ctx.researchRunId, kind: 'web', uri: page.uri, title: page.title,
        contentSha256: page.sha256, excerpt: page.text.slice(0, 500), text: page.text,
      });
      ctx.log('info', `fetch_source ${page.uri} → ${src.deduplicated ? 'existing' : 'new'} source ${src.id} (reliability ${src.reliability})`);
      return { research_source_id: src.id, deduplicated: src.deduplicated, reliability: src.reliability, uri: page.uri, title: page.title, text: page.text };
    },
  });
```

`core/runtime/tools.ts`: pass the fetch: `createFetchSourceTool(external),` (`external` already carries `sql` and the optional `fetch`).

`research-intelligence/evidence/engine.ts`: add `readonly quote?: unknown;` to `EvidenceInput`. In `validateEvidence`, add:

```ts
  if (input.quote !== undefined && input.quote !== null && !nonEmpty(input.quote)) errors.push('quote must be a non-empty string when given');
```

In `writeEvidence`, add `quote` to the column list and the value `${(input.quote as string | undefined) ?? null}`.

`research-intelligence/tools/write-evidence.ts`:

```ts
import type { Sql } from '../../core/db/client.ts';
import { defineTool, type Tool } from '../../core/tool-registry/registry.ts';
import { asRole, RESEARCH_ROLE } from '../db.ts';
import { writeEvidence, type EvidenceInput } from '../evidence/engine.ts';
import { citeIngestedSource } from '../sources/verify.ts';

/**
 * write_evidence (capability research.write): the Evidence Engine exposed as a tool. The specialist and
 * agent run come from the run context, never from the caller's arguments. AOS-04: an agent's claim carries
 * the verbatim `quote` behind it and cites exactly one of a fetched page (`research_source_id`) or an ingested
 * source through the canonical row that quotes it (`canonical_prompt_id`); the DB verifies the quote.
 * @param deps - pool the write runs through (as xyp_research)
 * @returns the tool definition
 */
export const createWriteEvidenceTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'write_evidence',
    capability: 'research.write',
    description: 'Record one model/version-tagged claim with the verbatim quote behind it, citing a fetched page or a canonical row\'s source (Evidence Engine).',
    handler: async (ctx, args) => {
      if (!ctx.researchRunId) throw new Error('write_evidence requires a research run');
      const a = (args ?? {}) as EvidenceInput & { canonical_prompt_id?: unknown };
      if (typeof a.quote !== 'string' || a.quote.trim() === '') throw new Error('evidence rejected: quote is required (the verbatim passage behind the claim)');
      const hasPage = typeof a.research_source_id === 'string';
      const hasCanonical = typeof a.canonical_prompt_id === 'string';
      if (hasPage === hasCanonical) throw new Error('evidence rejected: exactly one of research_source_id or canonical_prompt_id');
      let researchSourceId = a.research_source_id as string | undefined;
      if (hasCanonical) {
        const [cp] = await asRole(deps.sql, RESEARCH_ROLE, (tx) => tx<{ source_id: string | null }[]>`
          select source_id from canonical_prompts where id = ${a.canonical_prompt_id as string}`);
        if (!cp) throw new Error(`evidence rejected: no canonical row ${String(a.canonical_prompt_id)}`);
        if (!cp.source_id) throw new Error(`evidence rejected: canonical row ${String(a.canonical_prompt_id)} has no source; not citable`);
        researchSourceId = (await citeIngestedSource(deps.sql, { researchRunId: ctx.researchRunId, sourceId: cp.source_id, excerpt: a.quote })).researchSourceId;
      }
      const { canonical_prompt_id: _c, ...fields } = a;
      const id = await writeEvidence(deps.sql, { researchRunId: ctx.researchRunId, agentRunId: ctx.runId, specialist: ctx.agentName },
        { ...fields, research_source_id: researchSourceId });
      ctx.log('info', `write_evidence → ${id}`);
      return { evidence_id: id, research_source_id: researchSourceId };
    },
  });
```

Read `citeIngestedSource`'s return value first (verify.ts line ~150). If it returns the research source id under another name (`id`), use that name. The field is written `researchSourceId` above.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/aos-04/evidence-tools.test.ts tests/phase-06c tests/phase-14`
Expected: PASS. Phase 6C and 14 write evidence through `writeEvidence` directly with no quote, which stays allowed.

- [ ] **Step 6: Commit**

```bash
git add research-intelligence/sources research-intelligence/evidence research-intelligence/tools core/runtime/tools.ts
git commit -m "AOS-04: fetch_source keeps page text (injectable fetch); write_evidence takes a verified quote and cites canonical rows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The shared specialist program (R1, R4)

**Files:**
- Create: `research-intelligence/specialists/program.ts`
- Modify: `core/runtime/programs.ts`
- Modify: `agents/*-researcher.agent.md` (20 files: the `model:` line only)
- Modify: `tests/phase-06b/roster.test.ts:48` (the pinned model)
- Test: `tests/aos-04/specialist-program.test.ts`

**Interfaces:**
- Consumes: `retrieve_context` → `ContextBundle` (`core/context-engine/context-engine.ts`); `fetch_source` (Task 2) → `{ research_source_id, uri, title, text }`; `write_evidence` (Task 2).
- Produces:
  - `SPECIALISTS: readonly string[]` (the 20 names);
  - `SPECIALIST_SCHEMA_ID = 'research.specialist-claims/v1'`;
  - `PASSAGE_BUDGET = 24_000`;
  - `specialistProgram: LlmProgram`. Input `{ question: string; intendedUse?: string | null; urls?: string[] | null }`. Output `{ status: 'done' | 'no-sources'; evidenceIds: string[]; declined: { claim?: string; reason: string }[]; failedUrls: { url: string; reason: string }[]; passages: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/aos-04/specialist-program.test.ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { createToolRegistry } from '../../core/tool-registry/registry.ts';
import { SPECIALISTS } from '../../research-intelligence/specialists/program.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FAKE_KEYS, fakeModel } from '../helpers/fake-llm.ts';
import { insertResearchRun } from '../helpers/tech-fixture.ts';

// AOS-04 §5 (R4): the one program the 20 specialists share. FAKE MODEL: replies are scripted from the
// passages the real prompt listed. Real: passage gathering, the prompt, the checks, the writes and the DB's
// verbatim quote check. retrieve_context is replaced by a stub returning no canonical rows, so the test
// needs no embedder; the gate test (Task 8) runs the real one.

let db: TestDb;
let researchRunId: string;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const PAGE = '<html><head><title>[FIXTURE] Suno tips</title></head><body><p>[FIXTURE] Put the vocal descriptor first. Suno weighs early words more.</p></body></html>';
const pageFetch: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('broken')) return new Response('gone', { status: 404 });
  return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
};

beforeAll(async () => {
  db = await createTestDb('aos04_program', { migrated: true });
  researchRunId = await insertResearchRun(db.sql);
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

type Claim = { passage: number; quote: string; claim: string; claim_topic: string; claim_value: string; model_tag: string; confidence: number; confidence_inputs: { basis: string; directness: string } };
const claim = (over: Partial<Claim> = {}): Claim => ({
  passage: 1, quote: 'Put the vocal descriptor first.', claim: '[FAKE] the vocal descriptor goes first', claim_topic: 'suno.vocal-descriptor-position',
  claim_value: '"first"', model_tag: 'suno-v5', confidence: 0.6, confidence_inputs: { basis: '[FAKE] one vendor-adjacent page', directness: 'direct' }, ...over,
});
const scripted = (claims: Claim[]) => fakeModel({ override: (schema) => ('claims' in ((schema.properties ?? {}) as object) ? { claims, declined: [] } : undefined) });

const run = async (model: ReturnType<typeof fakeModel>, input: unknown) => {
  const real = createRuntimeTools({ sql: db.sql, env: {}, fetch: pageFetch });
  const noCanonical = { ...real.get('retrieve_context')!, handler: async () => ({ query: '', scope: null, model: 'stub', generation: 'stub', cache: 'miss', items: [], diagnostics: { vectorHits: 0, edgesConsidered: 0, skippedPredicates: [], skippedEntityTypes: [] } }) };
  const tools = createToolRegistry([...real.list().filter((t) => t.name !== 'retrieve_context'), noCanonical]);
  const deps: DispatchDeps = { sql: db.sql, registry, tools, handlers: HANDLERS, llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }) };
  return dispatch(deps, 'suno-researcher', input, { researchRunId, timeoutMs: 60_000 });
};
type Out = { status: string; evidenceIds: string[]; declined: { claim?: string; reason: string }[]; failedUrls: { url: string; reason: string }[]; passages: number };

describe('registration (R1)', () => {
  it('registers the program for exactly the Research agents with a Scope, all on the OpenRouter free route', () => {
    const roster = registry.list().filter((a) => a.class === 'Research' && a.sections.Scope).map((a) => a.name).sort();
    expect([...SPECIALISTS].sort()).toEqual(roster);
    for (const name of SPECIALISTS) {
      expect(LLM_PROGRAMS[name]).toBeTypeOf('function');
      expect(registry.get(name)!.model).toBe('openrouter:nvidia/nemotron-3-ultra-550b-a55b:free');
    }
  });
});

describe('the specialist program (R4)', () => {
  it('writes a claim whose quote the page contains, with the quote kept', async () => {
    const model = scripted([claim()]);
    const r = await run(model, { question: '[FIXTURE] Where does the vocal descriptor go?', intendedUse: '[FIXTURE] recipe order', urls: ['https://example.org/suno'] });
    expect(r.status).toBe('success');
    const out = r.output as Out;
    expect(out).toMatchObject({ status: 'done', passages: 1, declined: [], failedUrls: [] });
    const [e] = await db.sql<{ quote: string; claim_topic: string; claim_value: unknown }[]>`
      select quote, claim_topic, claim_value from research_evidence where id = ${out.evidenceIds[0]!}`;
    expect(e).toEqual({ quote: 'Put the vocal descriptor first.', claim_topic: 'suno.vocal-descriptor-position', claim_value: 'first' });
    expect(model.calls[0]!.user).toContain('[1]');
    expect(model.calls[0]!.user).toContain('[FIXTURE] recipe order');
    expect(model.calls[0]!.system).toContain('Suno Researcher');
  });

  it('declines a fabricated quote, a typographic variant, an unknown passage, a bad topic and a non-JSON value, writing none of them', async () => {
    const model = scripted([
      claim({ quote: 'Put the vocal descriptor last.' }),
      claim({ quote: 'Suno weighs early words more…' }),
      claim({ passage: 7 }),
      claim({ claim_topic: 'Vocal Position' }),
      claim({ claim_value: 'first, obviously' }),
    ]);
    const before = await db.sql`select id from research_evidence`;
    const out = (await run(model, { question: '[FIXTURE] q', urls: ['https://example.org/suno'] })).output as Out;
    expect(out.evidenceIds).toEqual([]);
    expect(out.declined.map((d) => d.reason)).toEqual([
      expect.stringMatching(/quote not found verbatim/),
      expect.stringMatching(/quote not found verbatim/),
      expect.stringMatching(/passage 7 is not one of the 1 given/),
      expect.stringMatching(/claim_topic .* is not dotted kebab/),
      expect.stringMatching(/claim_value is not JSON/),
    ]);
    expect(await db.sql`select id from research_evidence`).toHaveLength(before.length);
  });

  it('skips a failing URL and reports it', async () => {
    const out = (await run(scripted([claim()]), { question: '[FIXTURE] q', urls: ['https://example.org/broken', 'https://example.org/suno'] })).output as Out;
    expect(out.failedUrls).toEqual([{ url: 'https://example.org/broken', reason: expect.stringMatching(/HTTP 404/) }]);
    expect(out.evidenceIds).toHaveLength(1);
  });

  it('with no sources, makes no model call and declines', async () => {
    const model = scripted([claim()]);
    const out = (await run(model, { question: '[FIXTURE] q', urls: ['https://example.org/broken'] })).output as Out;
    expect(out).toMatchObject({ status: 'no-sources', evidenceIds: [], declined: [{ reason: expect.stringMatching(/^no sources/) }] });
    expect(model.calls).toHaveLength(0);
  });

  it('accepts a null intended use and null urls (optional workflow inputs bind as null)', async () => {
    const out = (await run(scripted([]), { question: '[FIXTURE] q', intendedUse: null, urls: null })).output as Out;
    expect(out.status).toBe('no-sources');
  });

  it('caps passages at the budget', async () => {
    const big = `<html><body><p>${'[FIXTURE] word '.repeat(3000)}</p></body></html>`;
    const bigFetch: typeof fetch = async () => new Response(big, { status: 200, headers: { 'content-type': 'text/html' } });
    const real = createRuntimeTools({ sql: db.sql, env: {}, fetch: bigFetch });
    expect(real.get('fetch_source')).toBeDefined();
    // Two 20 000-char pages exceed the 24 000 budget: the second is dropped, and the output says so.
    const model = scripted([]);
    const deps: DispatchDeps = {
      sql: db.sql, registry, handlers: HANDLERS,
      tools: createToolRegistry([...real.list().filter((t) => t.name !== 'retrieve_context'),
        { ...real.get('retrieve_context')!, handler: async () => ({ items: [] }) }]),
      llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
    };
    const r = await dispatch(deps, 'suno-researcher', { question: '[FIXTURE] q', urls: [`https://example.org/a-${randomUUID()}`, `https://example.org/b-${randomUUID()}`] }, { researchRunId, timeoutMs: 60_000 });
    expect((r.output as Out).passages).toBe(1);
  });
});
```

`real.list()` and `real.get()` assume the `ToolRegistry` shape. Read `core/tool-registry/registry.ts` for the exact method names and use them.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/aos-04/specialist-program.test.ts`
Expected: FAIL: `Cannot find module '../../research-intelligence/specialists/program.ts'`.

- [ ] **Step 3: Commit the red test**

```bash
git add tests/aos-04/specialist-program.test.ts
git commit -m "AOS-04 red test: the shared specialist program (passages, verified quotes, declines, no-sources, budget, R1 model)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Implement the program**

```ts
// research-intelligence/specialists/program.ts
import type { ContextBundle } from '../../core/context-engine/context-engine.ts';
import { arr, num, obj, str, type JsonSchema } from '../../core/llm/json-schema.ts';
import type { LlmProgram } from '../../core/llm/runner.ts';

/**
 * The 20 Research specialists' one program (AOS-04 R4). Deterministic steps around one model call:
 *   passages   canonical rows from retrieve_context (citable through their source) + the brief's URLs via
 *              fetch_source (the model never supplies a URL); capped at PASSAGE_BUDGET chars
 *   no sources no model call; the specialist declines (it never asserts from model memory)
 *   one call   the agent's own Role, Scope and Refuses as the system prompt; claims must quote a passage
 *   write      each claim through write_evidence; the DB verifies the quote verbatim. A claim that fails a
 *              check or the write is declined with the reason, never written.
 */

export const SPECIALISTS = [
  'ai-vocal-systems-researcher', 'artist-identity-researcher', 'benchmark-scoring-methodology-researcher', 'brand-persona-consistency-researcher',
  'composition-arrangement-researcher', 'evaluation-researcher', 'frontier-tool-scanner-researcher', 'genre-style-researcher',
  'lyrics-rhyme-systems-researcher', 'mix-master-ai-tooling-researcher', 'model-version-changelog-researcher', 'negative-prompt-failure-mode-researcher',
  'prompt-engineering-researcher', 'prompt-formula-template-researcher', 'release-strategy-platform-algo-researcher', 'rights-licensing-researcher',
  'songwriting-structure-researcher', 'suno-researcher', 'udio-alt-platform-researcher', 'voice-cloning-researcher',
] as const;

export const SPECIALIST_SCHEMA_ID = 'research.specialist-claims/v1';
export const PASSAGE_BUDGET = 24_000;
const TOPIC = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;
const MODEL_TAG = /^[a-z0-9][a-z0-9.-]*$/;

export const SPECIALIST_SCHEMA: JsonSchema = obj({
  claims: arr(obj({
    passage: num('The number of the passage the quote is from, as given in brackets'),
    quote: str('Copied verbatim from that passage: the exact words, no paraphrase, no ellipsis'),
    claim: str('What the quote shows, in one sentence, within your scope'),
    claim_topic: str('Dotted kebab topic, e.g. suno.vocal-descriptor-position'),
    claim_value: str('The claim\'s value as JSON text, e.g. "\\"first\\"", "true", "3"'),
    model_tag: str('<tool>-<version> the quote was observed on (e.g. suno-v5), or model-agnostic'),
    confidence: num('0 to 1'),
    confidence_inputs: obj({ basis: str('Why this confidence'), directness: { type: 'string', enum: ['direct', 'inferred'], description: 'Does the quote state the claim, or is it inferred?' } }),
  })),
  declined: arr(obj({ reason: str('Why a relevant claim was not made (e.g. out of scope, no passage supports it)') })),
});

type Passage = { readonly n: number; readonly title: string; readonly text: string; readonly cite: { research_source_id: string } | { canonical_prompt_id: string } };
type Claim = { passage: number; quote: string; claim: string; claim_topic: string; claim_value: string; model_tag: string; confidence: number; confidence_inputs: { basis: string; directness: string } };
export type Declined = { readonly claim?: string; readonly reason: string };

const RULES = `RULES
- Answer only within your Scope. Decline what belongs to another specialist.
- Every claim quotes one numbered passage VERBATIM: copy the exact words; no paraphrase, no ellipsis, no changed quotation marks.
- One claim per quote. No claim without a passage. Context marked NOT CITABLE is background only.
- claim_topic is dotted kebab (a.b-c); claim_value is JSON text; model_tag is <tool>-<version> or model-agnostic.
- Confidence reflects the passage: a vendor's own page is a claim, a measured observation is stronger.`;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * @param ctx - run context: retrieve_context, fetch_source, write_evidence, log_message
 * @param input - the brief: `{ question, intendedUse?, urls? }` (optional inputs arrive as null)
 * @param llm - the model client for the agent's frontmatter model (R1)
 * @returns evidence ids written, declined claims with reasons, failed URLs, passages given
 */
export const specialistProgram: LlmProgram = async (ctx, input, llm) => {
  const i = (input ?? {}) as { question?: unknown; intendedUse?: unknown; urls?: unknown };
  if (typeof i.question !== 'string' || i.question.trim() === '') throw new Error(`${ctx.agent.name}: question must be a non-empty string`);
  const intendedUse = typeof i.intendedUse === 'string' && i.intendedUse.trim() !== '' ? i.intendedUse.trim() : null;
  const urls = Array.isArray(i.urls) ? i.urls.filter((u): u is string => typeof u === 'string') : [];

  const passages: Passage[] = [];
  const context: string[] = [];
  const failedUrls: { url: string; reason: string }[] = [];
  let used = 0;
  let dropped = 0;
  const add = (title: string, text: string, cite: Passage['cite']) => {
    if (used + text.length > PASSAGE_BUDGET) {
      dropped += 1;
      return;
    }
    used += text.length;
    passages.push({ n: passages.length + 1, title, text, cite });
  };

  const bundle = (await ctx.useTool('retrieve_context', { query: i.question })) as Partial<ContextBundle>;
  for (const item of bundle.items ?? []) {
    if (item.ref.table === 'canonical_prompts') add(item.title, item.text, { canonical_prompt_id: item.ref.id });
    else context.push(`- ${item.title}: ${item.snippet}`);
  }
  for (const url of urls) {
    try {
      const page = (await ctx.useTool('fetch_source', { url })) as { research_source_id: string; title: string; uri: string; text: string };
      add(`${page.title} <${page.uri}>`, page.text, { research_source_id: page.research_source_id });
    } catch (e) {
      failedUrls.push({ url, reason: message(e) });
      await ctx.useTool('log_message', { level: 'warn', message: `${ctx.agent.name}: skipped ${url}: ${message(e)}` });
    }
  }
  if (dropped > 0) await ctx.useTool('log_message', { level: 'warn', message: `${ctx.agent.name}: ${dropped} passage(s) over the ${PASSAGE_BUDGET}-char budget dropped` });

  if (passages.length === 0) {
    const reason = `no sources: no citable canonical row matched and ${urls.length === 0 ? 'the brief lists no URL' : 'no URL could be read'}`;
    await ctx.useTool('log_message', { message: `${ctx.agent.name}: ${reason}; no model call` });
    return { output: { status: 'no-sources', evidenceIds: [], declined: [{ reason }], failedUrls, passages: 0 }, tokensUsed: 0 };
  }

  const s = ctx.agent.sections;
  const res = await llm.complete({
    system: `You are the ${ctx.agent.name.replace(/-/g, ' ')} (XYP3RN Research).\n# ${titleOf(ctx.agent.path, ctx.agent.name)}\n## Role\n${s.Role ?? ''}\n## Scope\n${s.Scope ?? ''}\n## Refuses\n${s.Refuses ?? ''}\n\n${RULES}`,
    user: [
      `QUESTION: ${i.question.trim()}`,
      `INTENDED USE: ${intendedUse ?? 'not stated'}`,
      `PASSAGES (${passages.length}):`,
      ...passages.map((p) => `[${p.n}] ${p.title}\n${p.text}`),
      ...(context.length > 0 ? ['CONTEXT (NOT CITABLE):', ...context] : []),
    ].join('\n\n'),
    schema: { name: SPECIALIST_SCHEMA_ID, schema: SPECIALIST_SCHEMA },
    signal: ctx.signal,
  });
  const reply = res.json as { claims: Claim[]; declined: { reason: string }[] };

  const evidenceIds: string[] = [];
  const declined: Declined[] = reply.declined.map((d) => ({ reason: `model: ${d.reason}` }));
  for (const c of reply.claims) {
    const p = passages.find((x) => x.n === c.passage);
    let value: unknown;
    let reason: string | null =
      !p ? `passage ${c.passage} is not one of the ${passages.length} given`
        : c.quote.trim() === '' ? 'quote is blank'
          : !TOPIC.test(c.claim_topic) ? `claim_topic ${JSON.stringify(c.claim_topic)} is not dotted kebab`
            : !MODEL_TAG.test(c.model_tag) ? `model_tag ${JSON.stringify(c.model_tag)} is not <tool>-<version> or model-agnostic`
              : !(c.confidence >= 0 && c.confidence <= 1) ? `confidence ${c.confidence} is outside [0, 1]`
                : null;
    if (!reason) {
      try {
        value = JSON.parse(c.claim_value);
      } catch {
        reason = `claim_value is not JSON: ${c.claim_value}`;
      }
    }
    if (reason) {
      declined.push({ claim: c.claim, reason });
      continue;
    }
    try {
      const w = (await ctx.useTool('write_evidence', {
        ...p!.cite, quote: c.quote, claim: c.claim, claim_topic: c.claim_topic, claim_value: value, model_tag: c.model_tag,
        confidence: c.confidence, confidence_inputs: { ...c.confidence_inputs, passage: p!.n },
      })) as { evidence_id: string };
      evidenceIds.push(w.evidence_id);
    } catch (e) {
      declined.push({ claim: c.claim, reason: message(e) });
    }
  }
  await ctx.useTool('log_message', {
    message: `${ctx.agent.name}: ${passages.length} passage(s); ${evidenceIds.length} claim(s) written, ${declined.length} declined, ${failedUrls.length} URL(s) failed`,
  });
  return { output: { status: 'done', evidenceIds, declined, failedUrls, passages: passages.length }, tokensUsed: res.usage.inputTokens + res.usage.outputTokens };
};

// The agent file's H1 ("# Suno Researcher") names the specialist the way its contract does.
const titleOf = (_path: string, name: string): string => name.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
```

`core/runtime/programs.ts`: import and register.

```ts
import { SPECIALISTS, specialistProgram } from '../../research-intelligence/specialists/program.ts';
// …inside LLM_PROGRAMS:
  // AOS-04 (R4): the 20 Research specialists share one grounded-evidence program.
  ...Object.fromEntries(SPECIALISTS.map((name) => [name, specialistProgram])),
```

Also update the comment above `LLM_PROGRAMS` ("the Phase 6B specialists, until their runner exists" → "every LLM agent in agents/ has one").

The 20 agent files: replace `model: claude-sonnet-5` with `model: openrouter:nvidia/nemotron-3-ultra-550b-a55b:free`:

```bash
for f in agents/*-researcher.agent.md; do sed -i 's/^model: claude-sonnet-5$/model: openrouter:nvidia\/nemotron-3-ultra-550b-a55b:free/' "$f"; done
grep -c "^model: openrouter:nvidia/nemotron-3-ultra-550b-a55b:free$" agents/*-researcher.agent.md | grep -v ":1$"   # must print nothing
```

`tests/phase-06b/roster.test.ts:48`: change the pinned model to `'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free'`, with a comment `// AOS-04 R1: the specialists run on the OpenRouter free route.`

Regenerate the specialists doc and check it: `pnpm specialists:table`, then `git diff --stat docs/research/SPECIALISTS.md`. The table has no model column today, so no change is expected. Commit it only if it changed.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/aos-04/specialist-program.test.ts tests/phase-06b tests/phase-08 && pnpm agents:validate`
Expected: PASS; `agents:validate` reports 51 agents valid.

- [ ] **Step 6: Commit**

```bash
git add research-intelligence/specialists/program.ts core/runtime/programs.ts agents/*-researcher.agent.md tests/phase-06b/roster.test.ts
git commit -m "AOS-04: the specialists run (R1 OpenRouter free route, R4 one grounded-evidence program with verified quotes)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Synthesis (evidence → findings)

**Files:**
- Create: `research-intelligence/synthesis/synthesize.ts`
- Test: `tests/aos-04/synthesis.test.ts`

**Interfaces:**
- Consumes: `recordFinding(sql, { researchRunId, claim, claim_topic, claim_value, model_tag, evidenceIds })` (existing, `synthesis/findings.ts`).
- Produces: `synthesizeRun(sql: Sql, researchRunId: string): Promise<{ findings: { findingId: string; claimTopic: string; evidenceIds: string[] }[]; unsynthesized: string[] }>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/aos-04/synthesis.test.ts
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeEvidence } from '../../research-intelligence/evidence/engine.ts';
import { registerResearchSource } from '../../research-intelligence/sources/verify.ts';
import { synthesizeRun } from '../../research-intelligence/synthesis/synthesize.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { insertResearchRun } from '../helpers/tech-fixture.ts';

// AOS-04 §6: synthesis groups a run's evidence by (topic, value, model tag) into findings through the
// existing recordFinding; two values for one topic are two findings; evidence without a topic is listed.

let db: TestDb;
let runId: string;
beforeAll(async () => {
  db = await createTestDb('aos04_synth', { migrated: true });
  runId = await insertResearchRun(db.sql);
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const ev = async (specialist: string, topic: string | undefined, value: unknown, confidence: number, claim: string, tag = 'suno-v5') => {
  const text = `[FIXTURE] ${claim} ${randomUUID()}`;
  const src = await registerResearchSource(db.sql, { researchRunId: runId, kind: 'web', uri: `https://example.org/${randomUUID()}`, title: '[FIXTURE] page', contentSha256: createHash('sha256').update(text).digest('hex'), text });
  return writeEvidence(db.sql, { researchRunId: runId, agentRunId: null, specialist }, {
    research_source_id: src.id, claim: `[FIXTURE] ${claim}`, model_tag: tag, confidence, confidence_inputs: { basis: 'fixture' }, quote: text.slice(0, 20),
    ...(topic ? { claim_topic: topic, claim_value: value } : {}),
  });
};

describe('synthesizeRun', () => {
  it('writes one finding per (topic, value, tag), claim text from the most confident evidence; lists untopical evidence', async () => {
    const a = await ev('suno-researcher', 'suno.vocal-descriptor-position', 'first', 0.5, 'first, weakly');
    const b = await ev('prompt-engineering-researcher', 'suno.vocal-descriptor-position', 'first', 0.8, 'first, strongly');
    const c = await ev('genre-style-researcher', 'suno.vocal-descriptor-position', 'last', 0.4, 'last');
    const d = await ev('suno-researcher', undefined, undefined, 0.3, 'no topic');
    const r = await synthesizeRun(db.sql, runId);
    expect(r.unsynthesized).toEqual([d]);
    expect(r.findings.map((f) => f.evidenceIds.sort())).toEqual(expect.arrayContaining([[a, b].sort(), [c]]));
    const rows = await db.sql<{ claim: string; claim_value: unknown }[]>`select claim, claim_value from research_findings where research_run_id = ${runId} order by claim`;
    expect(rows.map((x) => x.claim_value).sort()).toEqual(['first', 'last']);
    expect(rows.find((x) => x.claim_value === 'first')!.claim).toMatch(/^\[FIXTURE\] first, strongly/);
  });

  it('is idempotent: a second call writes nothing new', async () => {
    const before = await db.sql`select id from research_findings where research_run_id = ${runId}`;
    const r = await synthesizeRun(db.sql, runId);
    expect(r.findings).toEqual([]);
    expect(await db.sql`select id from research_findings where research_run_id = ${runId}`).toHaveLength(before.length);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/aos-04/synthesis.test.ts`
Expected: FAIL: cannot find `synthesize.ts`.

- [ ] **Step 3: Commit the red test**

```bash
git add tests/aos-04/synthesis.test.ts
git commit -m "AOS-04 red test: synthesis groups a run's evidence into findings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Implement**

```ts
// research-intelligence/synthesis/synthesize.ts
import type { Sql } from '../../core/db/client.ts';
import { asRole, RESEARCH_ROLE } from '../db.ts';
import { recordFinding } from './findings.ts';

/**
 * Synthesis (AOS-04 §6), deterministic: a run's evidence not yet in any finding, grouped by (claim_topic,
 * claim_value as JSON, model_tag), becomes one finding per group through recordFinding (which computes the
 * confidence and runs the contradiction engine). The finding's claim is its most confident evidence's claim.
 * Two values for one topic are two findings: the workbench shows them side by side. Evidence without a
 * topic is returned, not synthesized. Idempotent: evidence already in a finding is skipped.
 * @param sql - pool allowed to SET ROLE xyp_research
 * @param researchRunId - the run
 * @returns the findings written and the untopical evidence ids
 */
export const synthesizeRun = async (sql: Sql, researchRunId: string) => {
  const rows = await asRole(sql, RESEARCH_ROLE, (tx) => tx<{ id: string; claim: string; claim_topic: string | null; value: string | null; model_tag: string; confidence: string }[]>`
    select e.id, e.claim, e.claim_topic, e.claim_value::text as value, e.model_tag, e.confidence
    from research_evidence e
    where e.research_run_id = ${researchRunId}
      and not exists (select from research_finding_evidence fe where fe.evidence_id = e.id)
    order by e.created_at, e.id`);
  const unsynthesized = rows.filter((r) => r.claim_topic === null).map((r) => r.id);
  const groups = new Map<string, typeof rows>();
  for (const r of rows.filter((x) => x.claim_topic !== null)) {
    const key = JSON.stringify([r.claim_topic, r.value, r.model_tag]);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const findings: { findingId: string; claimTopic: string; evidenceIds: string[] }[] = [];
  for (const g of groups.values()) {
    const best = [...g].sort((x, y) => Number(y.confidence) - Number(x.confidence) || x.id.localeCompare(y.id))[0]!;
    const f = await recordFinding(sql, {
      researchRunId, claim: best.claim, claim_topic: best.claim_topic!, claim_value: JSON.parse(best.value!),
      model_tag: best.model_tag, evidenceIds: g.map((x) => x.id),
    } as never);
    findings.push({ findingId: (f as { findingId?: string; id?: string }).findingId ?? (f as { id: string }).id, claimTopic: best.claim_topic!, evidenceIds: g.map((x) => x.id) });
  }
  return { findings, unsynthesized };
};
```

Read `recordFinding`'s `FindingInput` type and return value (`synthesis/findings.ts` lines 1–57 and the return at its end). Replace the `as never` cast and the `findingId ?? id` fallback with the real field names, so the code type-checks without casts.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/aos-04/synthesis.test.ts tests/phase-06c`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add research-intelligence/synthesis/synthesize.ts
git commit -m "AOS-04: synthesis writes a run's evidence into findings by (topic, value, model tag)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The brief and the run (`openResearch`, `executeResearch`, `sweepResearch`)

**Files:**
- Create: `research-intelligence/brief.ts`
- Modify: `research-intelligence/orchestrator/select.ts`, `research-intelligence/orchestrator/select.test.ts`
- Modify: `research-intelligence/agents/research-orchestrator.ts`
- Modify: `research-intelligence/entrypoint.ts`
- Test: `tests/aos-04/research-run.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4. `LLM_TIMEOUT_MS` (`core/llm/runner.ts`); `loadWorkflow` (`core/workflow-engine/engine.ts`).
- Produces:
  - `type ResearchTarget = { kind: 'lineage'; artifactLineageId: string; role?: string } | { kind: 'workflow'; workflowName: string; role?: string } | { kind: 'decision'; decisionKey: string; role?: string }`;
  - `type Brief = { projectSlug: string; question: string; intendedUse?: string; urls?: readonly string[]; specialists?: readonly string[]; targets?: readonly ResearchTarget[] }`;
  - `validateBrief(brief, known: { specialists: ReadonlySet<string>; decisions: ReadonlySet<string> }, opts?: { requireIntendedUse?: boolean }): string[]`;
  - `decisionKeys(repoRoot?: string): Set<string>`;
  - `workflowFiles(repoRoot?: string): { name: string; path: string }[]`;
  - `retractResearchLink(sql, linkId, reason): Promise<void>`;
  - `openResearch(deps: EngineDeps, brief: Brief, opts?: { requireIntendedUse?: boolean }): Promise<{ researchRunId: string; questionId: string; selected: string[] }>`;
  - `executeResearch(deps, researchRunId, opts?: { log?: (l: string) => void }): Promise<ResearchResult>`;
  - `sweepResearch(sql, now?: Date): Promise<string[]>`;
  - `runResearch(deps, brief, opts?)` = open + execute, keeping the Phase 6A behaviour;
  - `planResearch(question, scopes, owner?: readonly string[])` with `selection.owner?: true`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/aos-04/research-run.test.ts
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import type { DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { decisionKeys, validateBrief, workflowFiles } from '../../research-intelligence/brief.ts';
import { executeResearch, openResearch, runResearch, sweepResearch } from '../../research-intelligence/entrypoint.ts';
import { SPECIALISTS } from '../../research-intelligence/specialists/program.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FAKE_KEYS, fakeModel } from '../helpers/fake-llm.ts';
import { insertArtifact } from '../helpers/records-fixture.ts';

// AOS-04 §6: the brief (validated before any write), links, the owner's selection, the specialist steps
// with LLM_TIMEOUT_MS, synthesis, sealing, the deadline sweep. FAKE MODEL, stubbed page fetch.

let db: TestDb;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const PAGE = '<html><head><title>[FIXTURE] Suno tips</title></head><body><p>[FIXTURE] Put the vocal descriptor first.</p></body></html>';
const pageFetch: typeof fetch = async () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
const answer = fakeModel({
  override: (schema) => ('claims' in ((schema.properties ?? {}) as object)
    ? { claims: [{ passage: 1, quote: 'Put the vocal descriptor first.', claim: '[FAKE] descriptor first', claim_topic: 'suno.vocal-descriptor-position', claim_value: '"first"', model_tag: 'suno-v5', confidence: 0.6, confidence_inputs: { basis: '[FAKE] page', directness: 'direct' } }], declined: [] }
    : undefined),
});
const deps = (model = answer): DispatchDeps => ({
  sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql, env: {}, fetch: pageFetch }), handlers: HANDLERS,
  llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
});
const known = () => ({ specialists: new Set<string>(SPECIALISTS), decisions: decisionKeys(REPO_ROOT) });

beforeAll(async () => {
  db = await createTestDb('aos04_run', { migrated: true });
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

describe('the brief', () => {
  it('reads decision keys from ARCHITECTURE.md and the checked-in workflows', () => {
    expect(decisionKeys(REPO_ROOT).has('F41')).toBe(true);
    expect(workflowFiles(REPO_ROOT).map((w) => w.name)).toContain('build-suno-package');
  });

  it('refuses a bad brief before writing, naming each field', async () => {
    const bad = { projectSlug: 'x', question: '[FIXTURE] q', intendedUse: ' ', urls: ['file:///c'], specialists: ['nobody'], targets: [{ kind: 'decision' as const, decisionKey: 'F999' }, { kind: 'workflow' as const, workflowName: 'no-such-flow' }] };
    expect(validateBrief(bad, known(), { requireIntendedUse: true })).toEqual([
      'intendedUse is required',
      'urls[0] is not an http(s) URL: file:///c',
      'specialists: unknown nobody',
      'targets[0]: no decision F999 in docs/ARCHITECTURE.md',
      'targets[1]: no workflow no-such-flow',
    ]);
    const before = await db.sql`select id from research_questions`;
    await expect(openResearch(deps(), bad, { requireIntendedUse: true })).rejects.toThrow(/intendedUse is required/);
    expect(await db.sql`select id from research_questions`).toHaveLength(before.length);
  });

  it('refuses a lineage target that is not a root (the DB guard), writing nothing', async () => {
    const root = await insertArtifact(db.sql, 'x3lius.style-recipe/v1', { name: '[FIXTURE] r', style: '[FIXTURE] s', excludeStyles: [], mood: [], production: [], notes: [] });
    const [v2] = await db.sql<{ id: string }[]>`
      insert into creative_artifacts (lineage_id, parent_id, version, schema_id, agent_name, body, agent_run_id)
      select lineage_id, id, 2, schema_id, agent_name, body, agent_run_id from creative_artifacts where id = ${root} returning id`;
    const before = await db.sql`select id from research_questions`;
    await expect(openResearch(deps(), { projectSlug: 'aos04', question: '[FIXTURE] q', intendedUse: '[FIXTURE] u', targets: [{ kind: 'lineage', artifactLineageId: v2!.id }] }))
      .rejects.toThrow(/not a lineage root/);
    expect(await db.sql`select id from research_questions`).toHaveLength(before.length);
  });
});

describe('open → execute', () => {
  it('opens a brief with links and the owner selection, raises the deadline, runs the specialists and synthesizes', async () => {
    const root = await insertArtifact(db.sql, 'x3lius.style-recipe/v1', { name: '[FIXTURE] r2', style: '[FIXTURE] s', excludeStyles: [], mood: [], production: [], notes: [] });
    const opened = await openResearch(deps(), {
      projectSlug: 'aos04', question: '[FIXTURE] Where does the vocal descriptor go in a Suno style prompt?', intendedUse: '[FIXTURE] recipe order',
      urls: ['https://example.org/suno'], specialists: ['suno-researcher'],
      targets: [{ kind: 'lineage', artifactLineageId: root }, { kind: 'workflow', workflowName: 'build-suno-package' }, { kind: 'decision', decisionKey: 'F41', role: 'informs' }],
    }, { requireIntendedUse: true });
    expect(opened.selected).toEqual(['suno-researcher']);
    const [run] = await db.sql<{ status: string; mins: number; selection: { owner?: boolean } }[]>`
      select status::text, extract(epoch from expires_at - created_at) / 60 as mins, selection from research_runs where id = ${opened.researchRunId}`;
    expect(run!.status).toBe('running');
    expect(Number(run!.mins)).toBeGreaterThan(30);
    expect(run!.selection.owner).toBe(true);
    expect((await db.sql`select kind from research_targets where question_id = ${opened.questionId}`).length).toBe(3);

    const r = await executeResearch(deps(), opened.researchRunId, { log: () => {} });
    expect(r).toMatchObject({ status: 'success', selected: ['suno-researcher'] });
    const f = await db.sql<{ claim_topic: string }[]>`select claim_topic from research_findings where research_run_id = ${opened.researchRunId}`;
    expect(f).toEqual([{ claim_topic: 'suno.vocal-descriptor-position' }]);
  });

  it('a provider failure seals the run and keeps earlier evidence', async () => {
    const overloaded = fakeModel({ override: () => { throw Object.assign(new Error('openrouter API error 429: overloaded'), { status: 429 }); } });
    const opened = await openResearch(deps(overloaded), { projectSlug: 'aos04', question: '[FIXTURE] q', intendedUse: '[FIXTURE] u', urls: ['https://example.org/suno'], specialists: ['suno-researcher', 'prompt-engineering-researcher'] });
    const r = await executeResearch(deps(overloaded), opened.researchRunId, { log: () => {} });
    expect(r.status).toBe('error');
    const [run] = await db.sql<{ status: string; error_detail: string }[]>`select status::text, error_detail from research_runs where id = ${opened.researchRunId}`;
    expect(run!.status).toBe('error');
    expect(run!.error_detail).toMatch(/specialist step .* failed/);
  });

  it('keeps the Phase 6A call shape: runResearch({ question, projectSlug }) still works', async () => {
    const r = await runResearch(deps(), { question: '[FIXTURE] What should we eat tonight?', projectSlug: 'aos04' }, { log: () => {} });
    expect(r).toMatchObject({ status: 'success', selected: [] });
  });
});

describe('sweepResearch', () => {
  it('seals only runs past their deadline, as abandoned', async () => {
    const live = await openResearch(deps(), { projectSlug: 'aos04', question: '[FIXTURE] live', intendedUse: '[FIXTURE] u', specialists: ['suno-researcher'] });
    const dead = await openResearch(deps(), { projectSlug: 'aos04', question: '[FIXTURE] dead', intendedUse: '[FIXTURE] u', specialists: ['suno-researcher'] });
    await db.sql`update research_runs set expires_at = now() - interval '1 minute' where id = ${dead.researchRunId}`;
    const sealed = await sweepResearch(db.sql);
    expect(sealed).toEqual([dead.researchRunId]);
    const rows = await db.sql<{ id: string; status: string; error_detail: string | null }[]>`
      select id, status::text, error_detail from research_runs where id in (${live.researchRunId}, ${dead.researchRunId})`;
    expect(rows.find((x) => x.id === dead.researchRunId)).toMatchObject({ status: 'error', error_detail: expect.stringMatching(/^abandoned: no result by /) });
    expect(rows.find((x) => x.id === live.researchRunId)!.status).toBe('running');
  });
});
```

The `fakeModel` override that throws surfaces as a fetch rejection. If the runner turns a thrown fetch into a different message, keep the assertion on `research_runs.status = 'error'` and `error_detail` matching `specialist step`, and drop the specific wording. The `creative_artifacts` v2 insert uses the columns `insertArtifact` writes: read `tests/helpers/records-fixture.ts:21` and mirror them.

Also update `research-intelligence/orchestrator/select.test.ts` (lines 51–53). The steps now bind the brief from the workflow input:

```ts
    expect(plan.workflow.steps).toEqual([
      { id: 'ai-vocal-systems-researcher', agent: 'ai-vocal-systems-researcher', input: BRIEF_INPUT },
      { id: 'suno-researcher', agent: 'suno-researcher', input: BRIEF_INPUT },
    ]);
```

with `const BRIEF_INPUT = { question: { $from: 'input.question' }, intendedUse: { $from: 'input.intendedUse' }, urls: { $from: 'input.urls' } };` at the top, plus a new case:

```ts
  it('uses the owner\'s picks when given, marking the selection as the owner\'s', () => {
    const plan = planResearch('What should we eat tonight?', [SUNO, VOCAL, MIX], ['suno-researcher']);
    expect(plan.selection.selected.map((s) => s.name)).toEqual(['suno-researcher']);
    expect(plan.selection.owner).toBe(true);
    expect(() => planResearch('q', [SUNO], ['nobody'])).toThrow(/unknown specialist nobody/);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/aos-04/research-run.test.ts research-intelligence/orchestrator/select.test.ts`
Expected: FAIL: cannot find `brief.ts`; `openResearch` is not exported.

- [ ] **Step 3: Commit the red tests**

```bash
git add tests/aos-04/research-run.test.ts research-intelligence/orchestrator/select.test.ts
git commit -m "AOS-04 red test: the brief (validation, links, owner selection), open/execute/sweep" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Implement `select.ts` and the orchestrator handler**

```ts
// research-intelligence/orchestrator/select.ts (replace ResearchPlan and planResearch)
export type ResearchPlan = {
  readonly selection: Selection & { readonly owner?: true };
  readonly workflow: {
    readonly name: string;
    readonly description: string;
    readonly input: { readonly required: readonly string[]; readonly optional: readonly string[] };
    readonly steps: ReadonlyArray<{ readonly id: string; readonly agent: string; readonly input: Readonly<Record<string, { readonly $from: string }>> }>;
  };
};

const BRIEF_INPUT = { question: { $from: 'input.question' }, intendedUse: { $from: 'input.intendedUse' }, urls: { $from: 'input.urls' } } as const;

/**
 * Turns a selection into a Workflow Engine spec: one independent step per selected specialist, each bound to
 * the brief through the workflow input (AOS-04). Synthesis runs after the workflow (entrypoint.ts).
 * @param question - research question
 * @param scopes - the roster
 * @param owner - the owner's picks (AOS-04): used instead of the keyword threshold, scores kept for the record
 * @returns selection evidence + workflow spec
 * @throws Error for an owner pick not in the roster
 */
export const planResearch = (question: string, scopes: readonly AgentScope[], owner?: readonly string[]): ResearchPlan => {
  const scored = selectByScope(question, scopes);
  let selection: ResearchPlan['selection'] = scored;
  if (owner) {
    const names = new Set(scopes.map((s) => s.name));
    const unknown = owner.filter((n) => !names.has(n));
    if (unknown.length > 0) throw new Error(`unknown specialist ${unknown.join(', ')}`);
    const all = [...scored.selected, ...scored.notSelected];
    selection = { selected: all.filter((s) => owner.includes(s.name)), notSelected: all.filter((s) => !owner.includes(s.name)), threshold: scored.threshold, owner: true };
  }
  return {
    selection,
    workflow: {
      name: 'research-specialists',
      description: `Evidence gathering for: ${question}`,
      input: { required: ['question'], optional: ['intendedUse', 'urls'] },
      steps: selection.selected.map((s) => ({ id: s.name, agent: s.name, input: BRIEF_INPUT })),
    },
  };
};
```

`research-intelligence/agents/research-orchestrator.ts`: accept `owner` in the input and pass it through.

```ts
  const i = (input ?? {}) as { question?: unknown; roster?: unknown; owner?: unknown };
  // …existing checks…
  if (i.owner !== undefined && (!Array.isArray(i.owner) || !i.owner.every((n) => typeof n === 'string'))) throw new Error('owner must be a list of specialist names');
  const plan = planResearch(i.question, scopes, i.owner as string[] | undefined);
```

Check the workflow spec parser accepts `input.optional` (AOS-03 added it: `core/workflow-engine/spec.ts:110`) and `input.required`. If the key names differ, match the parser.

- [ ] **Step 5: Implement `brief.ts`**

```ts
// research-intelligence/brief.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from '../core/db/client.ts';
import { asRole, RESEARCH_ROLE } from './db.ts';

/**
 * The research brief (AOS-04 §4, R2): a question, its intended use, the URLs the owner allows, an optional
 * owner selection, and its targets. Validated before anything is written; the DB checks again.
 */

export type ResearchTarget =
  | { readonly kind: 'lineage'; readonly artifactLineageId: string; readonly role?: string }
  | { readonly kind: 'workflow'; readonly workflowName: string; readonly role?: string }
  | { readonly kind: 'decision'; readonly decisionKey: string; readonly role?: string };

export type Brief = {
  readonly projectSlug: string;
  readonly question: string;
  readonly intendedUse?: string;
  readonly urls?: readonly string[];
  readonly specialists?: readonly string[];
  readonly targets?: readonly ResearchTarget[];
};

const REPO = join(import.meta.dirname, '..');
const WORKFLOW_DIRS = ['core/workflows', 'records/workflows', 'records/x3lius', 'tech/workflows'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @returns every `**F<n>.` decision heading in docs/ARCHITECTURE.md */
export const decisionKeys = (repoRoot = REPO): Set<string> =>
  new Set([...readFileSync(join(repoRoot, 'docs', 'ARCHITECTURE.md'), 'utf8').matchAll(/^\*\*(F\d+)\./gm)].map((m) => m[1]!));

/** @returns the checked-in workflow files, named by their `name:` line */
export const workflowFiles = (repoRoot = REPO): { name: string; path: string }[] =>
  WORKFLOW_DIRS.flatMap((d) => {
    let files: string[];
    try {
      files = readdirSync(join(repoRoot, d));
    } catch {
      return [];
    }
    return files.filter((f) => f.endsWith('.workflow.yaml')).map((f) => {
      const path = join(repoRoot, d, f);
      const name = /^name:\s*(\S+)/m.exec(readFileSync(path, 'utf8'))?.[1] ?? f.replace(/\.workflow\.yaml$/, '');
      return { name, path };
    });
  });

/**
 * @param b - the brief
 * @param known - registered specialists and ARCHITECTURE decision keys
 * @param opts - `requireIntendedUse` for the AOS-04 brief ops (web form, `pnpm research ask`)
 * @returns every problem, empty when valid
 */
export const validateBrief = (b: Brief, known: { readonly specialists: ReadonlySet<string>; readonly decisions: ReadonlySet<string> }, opts: { readonly requireIntendedUse?: boolean } = {}): string[] => {
  const errors: string[] = [];
  if (b.question.trim() === '') errors.push('question is required');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.projectSlug)) errors.push(`projectSlug must be kebab case: ${b.projectSlug}`);
  if (opts.requireIntendedUse && (b.intendedUse ?? '').trim() === '') errors.push('intendedUse is required');
  (b.urls ?? []).forEach((u, i) => {
    if (!/^https?:\/\/\S+$/.test(u)) errors.push(`urls[${i}] is not an http(s) URL: ${u}`);
  });
  const unknown = (b.specialists ?? []).filter((s) => !known.specialists.has(s));
  if (unknown.length > 0) errors.push(`specialists: unknown ${unknown.join(', ')}`);
  if (b.specialists && b.specialists.length === 0) errors.push('specialists: pick at least one, or leave it unset for the keyword selection');
  const flows = new Set(workflowFiles().map((w) => w.name));
  (b.targets ?? []).forEach((t, i) => {
    if (t.kind === 'decision' && !known.decisions.has(t.decisionKey)) errors.push(`targets[${i}]: no decision ${t.decisionKey} in docs/ARCHITECTURE.md`);
    if (t.kind === 'workflow' && !flows.has(t.workflowName)) errors.push(`targets[${i}]: no workflow ${t.workflowName}`);
    if (t.kind === 'lineage' && !UUID.test(t.artifactLineageId)) errors.push(`targets[${i}]: artifactLineageId is not a uuid`);
  });
  return errors;
};

/**
 * Unlinks a brief target without deleting it (research_link_retractions).
 * @param sql - pool allowed to SET ROLE xyp_research
 * @param linkId - research_links id
 * @param reason - why
 */
export const retractResearchLink = async (sql: Sql, linkId: string, reason: string): Promise<void> => {
  if (reason.trim() === '') throw new Error('a retraction needs a reason');
  await asRole(sql, RESEARCH_ROLE, (tx) => tx`insert into research_link_retractions (research_link_id, reason) values (${linkId}, ${reason})`);
};
```

- [ ] **Step 6: Implement the entrypoint split**

Replace `runResearch` in `research-intelligence/entrypoint.ts` with the four functions below. Keep `RESEARCH_ROLE`, `ORCHESTRATOR_AGENT`, `ResearchResult` and `asResearch` as they are.

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LLM_TIMEOUT_MS } from '../core/llm/runner.ts';
import { decisionKeys, validateBrief, workflowFiles, type Brief } from './brief.ts';
import { synthesizeRun } from './synthesis/synthesize.ts';
// (existing imports stay)

/** Minutes a run may take beyond its specialists' timeouts before the sweep calls it abandoned. */
const DEADLINE_MARGIN_MS = 5 * 60_000;

const rosterOf = (deps: EngineDeps) => deps.registry.list().filter((a) => a.class === 'Research' && a.sections.Scope).map((a) => ({ name: a.name, scope: a.sections.Scope! }));

/**
 * Opens a research run for a brief (AOS-04 §6): validates it, writes the question with its brief fields and
 * research links and the run, then asks the Research Orchestrator for the plan and records the selection
 * and the deadline (n specialists × LLM_TIMEOUT_MS + 5 min). A song target is linked by the caller through
 * link_song (A1), since that is a Records agent run.
 * @param deps - dispatch/engine dependencies
 * @param brief - the brief
 * @param opts - `requireIntendedUse` for the AOS-04 ops
 * @returns run id, question id, selected specialists
 * @throws Error "brief rejected: …" before any write; the orchestrator's error after the run is sealed
 */
export const openResearch = async (deps: EngineDeps, brief: Brief, opts: { readonly requireIntendedUse?: boolean } = {}) => {
  const roster = rosterOf(deps);
  const errors = validateBrief(brief, { specialists: new Set(roster.map((r) => r.name)), decisions: decisionKeys() }, opts);
  if (errors.length > 0) throw new Error(`brief rejected: ${errors.join('; ')}`);
  const flows = new Map(workflowFiles().map((w) => [w.name, w.path]));
  const { researchRunId, questionId } = await asResearch(deps, async (tx) => {
    await tx`insert into research_projects (slug, title) values (${brief.projectSlug}, ${brief.projectSlug}) on conflict (slug) do nothing`;
    const [p] = await tx<{ id: string }[]>`select id from research_projects where slug = ${brief.projectSlug}`;
    const [q] = await tx<{ id: string }[]>`
      insert into research_questions (project_id, question, intended_use, urls, specialists)
      values (${p!.id}, ${brief.question.trim()}, ${brief.intendedUse?.trim() || null}, ${[...(brief.urls ?? [])]}, ${brief.specialists ? [...brief.specialists] : null})
      returning id`;
    for (const t of brief.targets ?? []) {
      if (t.kind === 'lineage') await tx`insert into research_links (question_id, artifact_lineage_id, role) values (${q!.id}, ${t.artifactLineageId}, ${t.role ?? null})`;
      if (t.kind === 'decision') await tx`insert into research_links (question_id, decision_key, role) values (${q!.id}, ${t.decisionKey}, ${t.role ?? null})`;
      if (t.kind === 'workflow') {
        const sha = createHash('sha256').update(readFileSync(flows.get(t.workflowName)!, 'utf8')).digest('hex');
        await tx`insert into research_links (question_id, workflow_name, workflow_sha256, role) values (${q!.id}, ${t.workflowName}, ${sha}, ${t.role ?? null})`;
      }
    }
    const [r] = await tx<{ id: string }[]>`insert into research_runs (question_id) values (${q!.id}) returning id`;
    return { researchRunId: r!.id, questionId: q!.id };
  });

  const seal = (error: string) => asResearch(deps, (tx) => tx`
    update research_runs set status = 'error', error_detail = ${error}, completed_at = clock_timestamp() where id = ${researchRunId}`);
  if (roster.length === 0) {
    await seal('no Research specialists with a ## Scope are registered (roster is empty)');
    return { researchRunId, questionId, selected: [] as string[] };
  }
  const decided = await dispatch(deps, ORCHESTRATOR_AGENT, { question: brief.question, roster, ...(brief.specialists ? { owner: [...brief.specialists] } : {}) }, { researchRunId });
  if (decided.status === 'error') {
    await seal(`research-orchestrator failed: ${decided.error}`);
    return { researchRunId, questionId, selected: [] as string[] };
  }
  const plan = decided.output as ResearchPlan;
  const selected = plan.selection.selected.map((s) => s.name);
  const expires = new Date(Date.now() + selected.length * LLM_TIMEOUT_MS + DEADLINE_MARGIN_MS);
  await asResearch(deps, (tx) => tx`
    update research_runs set selected_specialists = ${selected}, selection = ${tx.json(plan.selection as unknown as postgres.JSONValue)},
                             expires_at = ${expires}
    where id = ${researchRunId}`);
  return { researchRunId, questionId, selected };
};

/**
 * Executes an opened run: one workflow step per selected specialist (timeout LLM_TIMEOUT_MS each), then
 * synthesis, then the seal. Seals the run itself on every path, so a caller may start it without awaiting.
 * @param deps - dispatch/engine dependencies (with the LLM runner)
 * @param researchRunId - an open run
 * @param options - `log` for the workflow failure line
 * @returns the result as runResearch returned it
 */
export const executeResearch = async (deps: EngineDeps, researchRunId: string, options: { readonly log?: (line: string) => void } = {}): Promise<ResearchResult> => {
  const [run] = await asResearch(deps, (tx) => tx<{ status: string; error_detail: string | null; selected: string[]; selection: ResearchPlan['selection']; question: string; intended_use: string | null; urls: string[] }[]>`
    select r.status::text, r.error_detail, r.selected_specialists as selected, r.selection, q.question, q.intended_use, q.urls
    from research_runs r join research_questions q on q.id = r.question_id where r.id = ${researchRunId}`);
  if (!run) throw new Error(`no research run ${researchRunId}`);
  // Already sealed (openResearch sealed it: empty roster, orchestrator failure): report that, run nothing.
  if (run.status !== 'running') {
    return { researchRunId, status: run.status === 'success' ? 'success' : 'error', selected: run.selected, workflowRunId: null, ...(run.error_detail ? { error: run.error_detail } : {}) };
  }
  const close = async (status: 'success' | 'error', fields: { error?: string; workflowRunId?: string | null }) => {
    await asResearch(deps, (tx) => tx`
      update research_runs set status = ${status}, error_detail = ${fields.error ?? null}, workflow_run_id = ${fields.workflowRunId ?? null},
                               completed_at = clock_timestamp()
      where id = ${researchRunId} and status = 'running'`);
  };
  try {
    if (run.selected.length === 0) {
      await close('success', {});
      return { researchRunId, status: 'success', selected: [], workflowRunId: null };
    }
    const plan = planResearch(run.question, rosterOf(deps).map((r) => parseScope(r.name, r.scope)), run.selection.owner ? run.selected : undefined);
    const wf = compileWorkflow(toYaml(plan.workflow), deps.registry, `generated:${ORCHESTRATOR_AGENT}:${researchRunId}`);
    const result = await runWorkflow(deps, wf, { question: run.question, intendedUse: run.intended_use, urls: run.urls },
      { researchRunId, timeoutMs: LLM_TIMEOUT_MS, ...(options.log ? { log: options.log } : {}) });
    if (result.status === 'error') {
      const error = `specialist step ${result.failedStep} failed: ${result.error}`;
      await synthesizeRun(deps.sql, researchRunId); // partial evidence still becomes findings, labelled by the run's error
      await close('error', { error, workflowRunId: result.workflowRunId });
      return { researchRunId, status: 'error', selected: run.selected, workflowRunId: result.workflowRunId, error };
    }
    await synthesizeRun(deps.sql, researchRunId);
    await close('success', { workflowRunId: result.workflowRunId });
    return { researchRunId, status: 'success', selected: run.selected, workflowRunId: result.workflowRunId };
  } catch (e) {
    const error = `research run failed: ${e instanceof Error ? e.message : String(e)}`;
    await close('error', { error });
    return { researchRunId, status: 'error', selected: run.selected, workflowRunId: null, error };
  }
};

/**
 * Seals every running run past its deadline as abandoned (the server stopped, or a step hung past its
 * timeouts). Called at web server boot and before any run starts.
 * @param sql - pool allowed to SET ROLE xyp_research
 * @param now - the clock (tests)
 * @returns the run ids sealed
 */
export const sweepResearch = async (sql: Sql, now: Date = new Date()): Promise<string[]> =>
  (await asRole(sql, RESEARCH_ROLE, (tx) => tx<{ id: string }[]>`
    update research_runs set status = 'error', error_detail = 'abandoned: no result by ' || to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                             completed_at = clock_timestamp()
    where status = 'running' and expires_at < ${now}
    returning id`)).map((r) => r.id);

/**
 * Opens and executes a brief (CLI, tests). The Phase 6A call `{ question, projectSlug }` still works.
 */
export const runResearch = async (deps: EngineDeps, brief: Brief, options: { readonly log?: (line: string) => void } = {}): Promise<ResearchResult> => {
  const opened = await openResearch(deps, brief);
  return executeResearch(deps, opened.researchRunId, options);
};
```

The Phase 6A test (`tests/phase-06a/research-orchestrator.test.ts`) must pass unchanged. It covers the roster-empty message through the early return above, and the first specialist failing with `LLM runner unavailable` when `deps` has no `llmRunner`.

Imports needed in `entrypoint.ts`: `parseScope`, `planResearch` from `./orchestrator/select.ts`; `asRole` from `./db.ts`; `type Sql` from `../core/db/client.ts`.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run tests/aos-04/research-run.test.ts research-intelligence tests/phase-06a tests/phase-06b`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add research-intelligence/brief.ts research-intelligence/entrypoint.ts research-intelligence/orchestrator research-intelligence/agents/research-orchestrator.ts
git commit -m "AOS-04: briefs (validated, linked, owner selection), openResearch/executeResearch with LLM timeouts and synthesis, the deadline sweep" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The Findings Library and promotion (R3), and the CLI

**Files:**
- Create: `research-intelligence/library.ts`
- Modify: `research-intelligence/cli.ts`
- Test: `tests/aos-04/library.test.ts`

**Interfaces:**
- Consumes: Task 1's `xyp_decide_finding`; `proposeCandidate`, `CandidateInput` (`synthesis/findings.ts`); `runGate`, `decideQueueItem`, `OPERATOR_ROLE` (`knowledge/promotion-gate/gate.ts`); `embedPending` / `loadEmbedder` (the same propagation `pnpm gate` uses).
- Produces:
  - `decideFinding(sql, findingId, d: { decision: 'accept' | 'reject'; approver: string; reason: string }): Promise<{ approvalId: string }>`;
  - `promoteFinding(sql, input: Omit<CandidateInput, never>): Promise<{ candidateId: string; gate: GateResult }>`;
  - `decidePromotion(sql, approvalId, d: { decision: 'approve' | 'reject'; approver: string; reason: string }, rerun: (candidateId: string) => Promise<unknown>)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/aos-04/library.test.ts
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGate } from '../../knowledge/promotion-gate/gate.ts';
import { writeEvidence } from '../../research-intelligence/evidence/engine.ts';
import { decideFinding, decidePromotion, promoteFinding } from '../../research-intelligence/library.ts';
import { registerResearchSource } from '../../research-intelligence/sources/verify.ts';
import { synthesizeRun } from '../../research-intelligence/synthesis/synthesize.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { insertResearchRun } from '../helpers/tech-fixture.ts';

// AOS-04 §7 (R3): accept/reject into the Findings Library (never canonical), promotion only from an
// accepted finding, the gate's pending approval decided by the owner.

let db: TestDb;
let findingId: string;
const canonicalCount = async () => Number((await db.sql<{ n: string }[]>`select count(*) as n from canonical_prompts`)[0]!.n);

beforeAll(async () => {
  db = await createTestDb('aos04_library', { migrated: true });
  const runId = await insertResearchRun(db.sql);
  const text = `[FIXTURE] Put the vocal descriptor first. ${randomUUID()}`;
  const src = await registerResearchSource(db.sql, { researchRunId: runId, kind: 'web', uri: 'https://example.org/a', title: '[FIXTURE] a', contentSha256: createHash('sha256').update(text).digest('hex'), text });
  await writeEvidence(db.sql, { researchRunId: runId, agentRunId: null, specialist: 'suno-researcher' }, {
    research_source_id: src.id, claim: '[FIXTURE] descriptor first', model_tag: 'suno-v5', confidence: 0.7, confidence_inputs: { basis: 'fixture' },
    claim_topic: 'suno.vocal-descriptor-position', claim_value: 'first', quote: 'Put the vocal descriptor first.',
  });
  findingId = (await synthesizeRun(db.sql, runId)).findings[0]!.findingId;
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const candidate = () => ({ findingId, proposed_kind: 'canonical_prompt' as const, target_slug: 'suno-vocal-descriptor-first', title: '[FIXTURE] Lead with the vocal descriptor', body: '[FIXTURE] Put the vocal descriptor first in a Suno style prompt.', domain: 'RECORDS' as const });

describe('the Findings Library (R3)', () => {
  it('refuses promotion of a finding the owner has not accepted', async () => {
    await expect(promoteFinding(db.sql, candidate())).rejects.toThrow(/only an accepted finding can be promoted/);
  });

  it('accepts once, touching no canonical table; a second decision is refused in the owner\'s terms', async () => {
    const before = await canonicalCount();
    await decideFinding(db.sql, findingId, { decision: 'accept', approver: 'owner', reason: '[FIXTURE] reusable' });
    await expect(decideFinding(db.sql, findingId, { decision: 'reject', approver: 'owner', reason: '[FIXTURE] no' })).rejects.toThrow(/already decided/);
    expect(await canonicalCount()).toBe(before);
  });

  it('promotes an accepted finding to a pending approval, still touching no canonical table, then the owner approves', async () => {
    const before = await canonicalCount();
    const p = await promoteFinding(db.sql, candidate());
    expect(p.gate.outcome).toBe('pending_approval');
    expect(await canonicalCount()).toBe(before);
    const d = await decidePromotion(db.sql, p.gate.approvalId!, { decision: 'approve', approver: 'owner', reason: '[FIXTURE] make it canonical' }, (id) => runGate(db.sql, id));
    expect(d.approval).toBe('approved');
    expect(await canonicalCount()).toBe(before + 1);
    const [lib] = await db.sql<{ canonical_status: string }[]>`select canonical_status from findings_library where finding_id = ${findingId}`;
    expect(lib!.canonical_status).toBe('promoted');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/aos-04/library.test.ts`
Expected: FAIL: cannot find `library.ts`.

- [ ] **Step 3: Commit the red test**

```bash
git add tests/aos-04/library.test.ts
git commit -m "AOS-04 red test: the Findings Library (accept once, promote only accepted, owner approves canonical)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Implement `library.ts`**

```ts
// research-intelligence/library.ts
import type { Sql } from '../core/db/client.ts';
import { decideQueueItem, OPERATOR_ROLE, runGate, type GateResult } from '../knowledge/promotion-gate/gate.ts';
import { asRole } from './db.ts';
import { proposeCandidate, type CandidateInput } from './synthesis/findings.ts';

/**
 * The two approval tiers (AOS-04 R3). Tier 1, the Findings Library: the owner accepts or rejects a finding,
 * once (xyp_decide_finding, recorded decided in approval_queue); no canonical table changes. Tier 2, canonical:
 * only an accepted finding may become a candidate; the Promotion Gate queues it (D2) and the owner decides.
 */

/**
 * @param sql - pool that may SET ROLE service_role (the operator)
 * @param findingId - the finding
 * @param d - accept or reject, who, why
 * @returns the approval_queue row id
 * @throws Error "finding … already decided" on a second decision
 */
export const decideFinding = async (sql: Sql, findingId: string, d: { readonly decision: 'accept' | 'reject'; readonly approver: string; readonly reason: string }) => {
  try {
    const [r] = await asRole(sql, OPERATOR_ROLE, (tx) => tx<{ id: string }[]>`select xyp_decide_finding(${findingId}, ${d.decision}, ${d.approver}, ${d.reason})::text as id`);
    return { approvalId: r!.id };
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new Error(`finding ${findingId} is already decided; a decision is final (run the brief again for a new finding)`);
    throw e;
  }
};

/**
 * Proposes an accepted finding as a canonical candidate and runs it through the gate.
 * @param sql - pool allowed to SET ROLE xyp_research and run the gate
 * @param input - what the canonical entry would be (claim and model tag come from the finding)
 * @returns the candidate and the gate's result (pending_approval when it passes: D2)
 * @throws Error when the finding's current decision is not accept
 */
export const promoteFinding = async (sql: Sql, input: CandidateInput): Promise<{ candidateId: string; gate: GateResult }> => {
  const [d] = await sql<{ decision: string }[]>`select decision from current_finding_decisions where finding_id = ${input.findingId}`;
  if (d?.decision !== 'accept') throw new Error(`only an accepted finding can be promoted; finding ${input.findingId} is ${d?.decision ?? 'undecided'}`);
  const candidateId = await proposeCandidate(sql, input);
  return { candidateId, gate: await runGate(sql, candidateId) };
};

/**
 * The owner's decision on a pending canonical approval (the gate re-runs on approve).
 * @param rerun - what `pnpm gate` passes: run the gate again and embed a promotion
 */
export const decidePromotion = (
  sql: Sql,
  approvalId: string,
  d: { readonly decision: 'approve' | 'reject'; readonly approver: string; readonly reason: string },
  rerun: (candidateId: string) => Promise<unknown>,
) => decideQueueItem(sql, approvalId, d, rerun);
```

- [ ] **Step 5: Extend the CLI**

Add to the usage comment and the switch in `research-intelligence/cli.ts`:

```ts
//   pnpm research ask     '{"projectSlug":"…","question":"…","intendedUse":"…","urls":["https://…"],"specialists"?:["…"],"targets"?:[{"kind":"decision","decisionKey":"F41"}],"songId"?:"…"}'
//     sweep, open, run the selected specialists live (OPENROUTER_API_KEY), synthesize; prints run, evidence, findings
//   pnpm research decide  <findingId> accept|reject "<reason>"
//   pnpm research promote '{"findingId":"…","proposed_kind":"canonical_prompt","target_slug":"…","title":"…","body":"…","domain":"RECORDS"}'
```

```ts
    case 'ask': {
      const brief = json(arg1) as unknown as Brief & { songId?: string };
      const deps = { ...createRuntimeDeps(sql), llmRunner: createRuntimeLlmRunner() };
      await sweepResearch(sql);
      const opened = await openResearch(deps, brief, { requireIntendedUse: true });
      if (brief.songId) await songLink(deps, { songId: brief.songId, researchQuestionId: opened.questionId });
      const r = await executeResearch(deps, opened.researchRunId, { log: (l) => console.error(l) });
      const evidence = await sql`select specialist, claim, quote, confidence from research_evidence where research_run_id = ${r.researchRunId} order by created_at`;
      const findings = await sql`select id, claim_topic, claim_value, claim, confidence from research_findings where research_run_id = ${r.researchRunId} order by created_at`;
      out = { ...r, evidence, findings };
      break;
    }
    case 'decide':
      if (arg2 !== 'accept' && arg2 !== 'reject') throw new Error('decision must be accept or reject');
      out = await decideFinding(sql, arg1!, { decision: arg2, approver: process.env.XYP_OWNER || 'owner', reason: arg3 ?? '' });
      break;
    case 'promote':
      out = await promoteFinding(sql, json(arg1) as never);
      break;
```

Imports: `createRuntimeLlmRunner` (`core/runtime/programs.ts`); `openResearch`, `executeResearch`, `sweepResearch` (`./entrypoint.ts`); `type Brief` (`./brief.ts`); `decideFinding`, `promoteFinding` (`./library.ts`); `songLink` (`apps/web/server/ops.ts` exports it, but a CLI must not import the web app). Dispatch `records-songs` with the `link_song` input directly, the way `songLink` does: read `apps/web/server/ops.ts:80` and copy its one-line `dispatch` call.

`createRuntimeDeps(sql)` already exists (`core/runtime/deps.ts`). Check whether it already sets `llmRunner`; if so, drop the spread.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/aos-04/library.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add research-intelligence/library.ts research-intelligence/cli.ts
git commit -m "AOS-04: the Findings Library and promotion (R3); pnpm research ask/decide/promote" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Research in the Vault export (`xyp-vault-export/v1`)

**Files:**
- Modify: `knowledge/vault-io/spec.ts` (`EXPORT_TABLES`)
- Modify: `knowledge/vault-io/export.ts` (closure rules)
- Modify: `knowledge/vault-io/import.ts` (only if the round trip exposes an ordering or trigger issue)
- Test: `tests/aos-04/research-export.test.ts`

**Interfaces:**
- Consumes: the export/import functions used by `tests/aos-03/idea-to-take.test.ts`. Read that test's export/import calls and mirror them exactly.
- Produces: `EXPORT_TABLES` gains `research_links`, `research_link_retractions`, `research_sources`, `research_evidence`, `research_findings`, `research_finding_evidence`, `contradictions`.

- [ ] **Step 1: Write the failing test**

Copy the export/import scaffolding (DB pair, vault dir, the export and import calls) from `tests/aos-03/idea-to-take.test.ts`. Then:

```ts
// tests/aos-04/research-export.test.ts — the body after the copied scaffolding
it('exports a song-linked brief with its links, runs, evidence (quotes), sources (text), findings and decisions, and re-imports them', async () => {
  // In the source DB: a song; a brief linked to the song (song_links) and to a decision (research_links);
  // a run with one quoted piece of evidence on a fetched page, synthesized into a finding; the owner accepts it.
  // (Build these with openResearch + executeResearch using the Task 5 fake model and page fetch, then
  //  songLink, then decideFinding.)
  const file = await exportVault(src.sql);
  const tables = new Set(file.rows.map((r: { table: string }) => r.table));
  for (const t of ['research_questions', 'research_runs', 'research_links', 'research_evidence', 'research_sources', 'research_findings', 'research_finding_evidence']) {
    expect(tables.has(t)).toBe(true);
  }
  expect(tables.has('knowledge_candidates')).toBe(false);
  await importVault(dst.sql, file);
  const [e] = await dst.sql<{ quote: string; text: string }[]>`
    select e.quote, s.text from research_evidence e join research_sources s on s.id = e.research_source_id`;
  expect(e!.quote).toBe('Put the vocal descriptor first.');
  expect(e!.text).toContain('Put the vocal descriptor first.');
  const [d] = await dst.sql<{ decision: string }[]>`select decision from current_finding_decisions`;
  expect(d!.decision).toBe('accept');
  expect(await dst.sql`select kind from research_targets`).toHaveLength(2);
});
```

`exportVault`/`importVault` and `file.rows` stand for the real function and field names in `knowledge/vault-io/export.ts` and `import.ts`. Read those two files and use their exported names. The assertions stay as written.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/aos-04/research-export.test.ts`
Expected: FAIL: `research_links` is not in the export.

- [ ] **Step 3: Commit the red test**

```bash
git add tests/aos-04/research-export.test.ts
git commit -m "AOS-04 red test: research survives a Vault export and re-import" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Implement**

`knowledge/vault-io/spec.ts`, after the AOS-03 line:

```ts
  // AOS-04 (design §9): an exported brief's links, and its runs' evidence, sources and findings. Candidates
  // stay out: canonical knowledge moves only through the gate.
  'research_links', 'research_link_retractions', 'research_sources', 'research_evidence', 'research_findings',
  'research_finding_evidence', 'contradictions',
```

`knowledge/vault-io/export.ts`, inside the closure loop after the AOS-03 block:

```ts
    // AOS-04: what belongs to an exported brief (a research question reached through song_links): its
    // research links and their retractions, its runs, the runs' evidence (sources follow by FK), findings,
    // the findings' evidence joins and contradictions, and the owner's decisions on those findings.
    added += add('research_runs', await fetchRows(tx, 'research_runs', 'question_id = any($2::uuid[])', [idsOf('research_questions')]));
    added += add('research_links', await fetchRows(tx, 'research_links', 'question_id = any($2::uuid[])', [idsOf('research_questions')]));
    added += add('research_link_retractions', await fetchRows(tx, 'research_link_retractions', 'research_link_id = any($2::uuid[])', [idsOf('research_links')]));
    added += add('research_evidence', await fetchRows(tx, 'research_evidence', 'research_run_id = any($2::uuid[])', [idsOf('research_runs')]));
    added += add('research_findings', await fetchRows(tx, 'research_findings', 'research_run_id = any($2::uuid[])', [idsOf('research_runs')]));
    added += add('research_finding_evidence', await fetchRows(tx, 'research_finding_evidence', 'finding_id = any($2::uuid[])', [idsOf('research_findings')]));
    added += add('contradictions', await fetchRows(tx, 'contradictions', 'finding_id = any($2::uuid[])', [idsOf('research_findings')]));
    added += add('approval_queue', await fetchRows(tx, 'approval_queue', `item_type::text = 'research_finding' and item_id = any($2::uuid[])`, [idsOf('research_findings')]));
```

`research_finding_evidence` has a composite primary key. Check that `rowKey` (export.ts) and `schema.pk` handle composite keys; `song_links` rows are keyed by `id`. If they don't, key that table by `finding_id|evidence_id`.

- [ ] **Step 5: Run the round trip and every export test**

Run: `pnpm vitest run tests/aos-04/research-export.test.ts tests/aos-01/vault-export.test.ts tests/aos-02/export.test.ts tests/aos-03`
Expected: PASS. If the import fails on an insert trigger (for example the quote trigger when a source row arrives after its evidence), fix the ordering in `order()` the way AOS-03 did for submissions, with a comment naming the trigger.

- [ ] **Step 6: Commit**

```bash
git add knowledge/vault-io
git commit -m "AOS-04: an exported brief carries its links, runs, quoted evidence, sources, findings and the owner's decisions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The gate test (PLAN §5 Phase 4)

**Files:**
- Test: `tests/aos-04/brief-to-canonical.test.ts`

**Interfaces:**
- Consumes: everything in Tasks 1–7, and `songLink`'s dispatch shape (from Task 6).

- [ ] **Step 1: Write the gate test**

```ts
// tests/aos-04/brief-to-canonical.test.ts
// AOS-04 gate (PLAN §5 Phase 4): reusable findings retain their sources and cannot silently become canonical
// without approval. One flow: a brief linked to a song, a recipe lineage and a decision, with one URL → a run
// whose fabricated quote is declined → findings that chain to quoted evidence and a source with its text →
// accepted into the library (canonical unchanged) → promoted (pending, canonical unchanged) → approved (canonical
// row chaining back to the quote) → the brief survives an export and re-import. FAKE MODEL; stubbed page fetch;
// the real retrieve_context (embedder) runs.
```

Build it from the helpers the earlier tasks wrote. Deps as in Task 5, with the real `createRuntimeTools({ sql, env: {}, fetch: pageFetch })`. The fake model replies with two claims: one with a real quote, one fabricated. Then assert:

1. `research_evidence` for the run holds exactly one row, `quote = 'Put the vocal descriptor first.'`, and the agent run's output `declined[0].reason` matches `/quote not found verbatim/`.
2. `select count(*) from research_targets where question_id = $q` is 3 (song, lineage, decision).
3. Snapshot `count(*)` from `canonical_prompts` and `knowledge_versions`. Unchanged after `decideFinding(accept)`, unchanged after `promoteFinding` (gate outcome `pending_approval`), and exactly +1 each after `decidePromotion(approve)`.
4. The chain query returns one row with a non-null quote and text:

```sql
select cp.id, kc.id as candidate, f.id as finding, e.quote, s.text
from canonical_prompts cp
join knowledge_candidates kc on kc.target_slug = cp.slug
join research_findings f on f.id = kc.finding_id
join research_finding_evidence fe on fe.finding_id = f.id
join research_evidence e on e.id = fe.evidence_id
join research_sources s on s.id = e.research_source_id
where cp.slug = 'suno-vocal-descriptor-first'
```

5. Export and import as in Task 7. The imported DB has the brief, its three targets, the quote and the decision.

The honest note, as in AOS-03, goes in the file header: this test is written after the features it drives, so it is not red first. The DB, program, synthesis, run, library and export tests were.

- [ ] **Step 2: Run it**

Run: `pnpm vitest run tests/aos-04/brief-to-canonical.test.ts`
Expected: PASS. If it fails, fix the code it exposes in the task that owns that code, and name the fix in the commit.

- [ ] **Step 3: Commit**

```bash
git add tests/aos-04/brief-to-canonical.test.ts
git commit -m "AOS-04 gate test: a brief to a canonical row; the quote and source survive, nothing canonical without the owner" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Web read/write for Research (loaders, ops, background run, boot sweep)

**Files:**
- Create: `apps/web/server/research-loaders.ts`, `apps/web/server/research-ops.ts`, `apps/web/server/research.test.ts`
- Create: `apps/web/instrumentation.ts`
- Modify: `apps/web/server/runtime.ts` (`llmRunner`), `apps/web/lib/server.ts` (doors), `apps/web/next.config.mjs` (`instrumentationHook`)

**Interfaces:**
- Consumes: Tasks 5–6; `asWeb` (`apps/web/server/loaders.ts`); `songLink` (`apps/web/server/ops.ts`).
- Produces:
  - `researchIndex(sql): Promise<{ asOf: string; briefs: BriefRow[]; specialists: { name: string; scope: string }[]; workflows: string[]; decisions: string[] }>`;
  - `previewSelection(registry, question): Selection`;
  - `runDetail(sql, runId): Promise<RunDetail | null>`;
  - `library(sql, filter?: { kind?: string; target?: string }): Promise<LibraryRow[]>`;
  - `researchFor(sql, target: { songId?: string; lineageId?: string }): Promise<{ briefs: BriefRow[]; findings: LibraryRow[] }>`;
  - `startBrief(deps, brief & { songIds?: string[] }, log?): Promise<{ researchRunId: string }>` (awaits open, detaches execute);
  - `rerun(deps, runId)`;
  - `decideFindingOp(sql, findingId, decision, reason, owner)`;
  - `promoteOp(sql, input)`;
  - `decidePromotionOp(sql, approvalId, decision, reason, owner)`;
  - `retractLinkOp(sql, linkId, reason)`.

Shapes (`research-loaders.ts`):

```ts
export type BriefRow = { questionId: string; question: string; intendedUse: string | null; createdAt: string; targets: TargetRow[]; latestRun: { id: string; status: string; createdAt: string } | null };
export type TargetRow = { kind: 'song' | 'lineage' | 'workflow' | 'decision'; target: string; label: string; role: string | null; linkId: string; via: 'song_links' | 'research_links' };
export type EvidenceRow = { id: string; specialist: string; claim: string; quote: string | null; claimTopic: string | null; claimValue: unknown; modelTag: string; confidence: number; confidenceInputs: Record<string, unknown>; source: { id: string; kind: string; uri: string; title: string; reliability: number | null } };
export type FindingRow = { id: string; claim: string; claimTopic: string; claimValue: unknown; modelTag: string; confidence: number; evidenceIds: string[]; contradictions: { id: string; targetType: string; targetId: string; status: string; detail: unknown }[]; decision: { decision: 'accept' | 'reject'; by: string; at: string; reason: string } | null; candidates: { id: string; status: string; approvalId: string | null; approvalStatus: string | null }[] };
export type AgentOutcome = { specialist: string; status: string; error: string | null; declined: { claim?: string; reason: string }[]; failedUrls: { url: string; reason: string }[]; passages: number | null };
export type RunDetail = { run: { id: string; status: string; error: string | null; createdAt: string; completedAt: string | null; expiresAt: string; selection: unknown; selected: string[] }; brief: BriefRow; outcomes: AgentOutcome[]; evidence: EvidenceRow[]; topics: { topic: string; findings: FindingRow[] }[]; unsynthesized: EvidenceRow[] };
export type LibraryRow = { findingId: string; claim: string; claimTopic: string; claimValue: unknown; modelTag: string; confidence: number; questionId: string; question: string; runId: string; evidenceCount: number; canonicalStatus: 'none' | 'candidate' | 'promoted' | 'rejected'; decidedAt: string; targets: TargetRow[]; quotes: { quote: string; uri: string; title: string }[] };
```

- [ ] **Step 1: Write the failing test**

`apps/web/server/research.test.ts`: follow `apps/web/server/studio.test.ts` for the scaffolding. `beforeAll` does four things:
- creates the DB (`createTestDb('aos04_web', { migrated: true })`);
- builds `deps` with `createRuntimeTools({ sql, env: {}, fetch: pageFetch })` and an `llmRunner` from the Task 5 fake model;
- creates `songId` with `songCreate(deps, { title: '[FIXTURE] Night City', artist: 'X3LIUS', language: 'en' })`;
- declares `let findingId: string`.

The first case assigns `findingId` from `select id from research_findings where research_run_id = $run`. Cases:

```ts
describe('research ops and loaders (AOS-04 §8)', () => {
  it('startBrief returns once the run is open; the run finishes in the background; runDetail shows it', async () => {
    const { researchRunId } = await startBrief(deps, { projectSlug: 'web', question: '[FIXTURE] q', intendedUse: '[FIXTURE] u', urls: ['https://example.org/suno'], specialists: ['suno-researcher'], songIds: [songId] });
    const first = await runDetail(db.sql, researchRunId);
    expect(['running', 'success']).toContain(first!.run.status);
    await waitFor(async () => (await runDetail(db.sql, researchRunId))!.run.status !== 'running');
    const d = (await runDetail(db.sql, researchRunId))!;
    expect(d.run.status).toBe('success');
    expect(d.brief.targets.map((t) => t.kind)).toEqual(['song']);
    expect(d.evidence[0]!.quote).toBe('Put the vocal descriptor first.');
    expect(d.outcomes[0]).toMatchObject({ specialist: 'suno-researcher', status: 'success', passages: 1 });
    expect(d.topics[0]!.topic).toBe('suno.vocal-descriptor-position');
  });

  it('refuses a bad brief with the field-level message and writes nothing', async () => {
    await expect(startBrief(deps, { projectSlug: 'web', question: '[FIXTURE] q', intendedUse: '', urls: [] })).rejects.toThrow(/intendedUse is required/);
  });

  it('accept → library; promote → pending; approve → promoted, as the owner', async () => {
    // findingId from the first test's run
    await decideFindingOp(db.sql, findingId, 'accept', '[FIXTURE] reusable', 'owner');
    expect((await library(db.sql)).map((l) => l.findingId)).toEqual([findingId]);
    const p = await promoteOp(db.sql, { findingId, proposed_kind: 'canonical_prompt', target_slug: 'web-descriptor-first', title: '[FIXTURE] t', body: '[FIXTURE] b', domain: 'RECORDS' });
    expect(p.gate.outcome).toBe('pending_approval');
    await decidePromotionOp(db.sql, p.gate.approvalId!, 'approve', '[FIXTURE] yes', 'owner');
    expect((await library(db.sql))[0]!.canonicalStatus).toBe('promoted');
  });

  it('researchFor(song) lists the brief and its library findings; previewSelection scores a question', async () => {
    const r = await researchFor(db.sql, { songId });
    expect(r.briefs).toHaveLength(1);
    expect(r.findings).toHaveLength(1);
    expect(previewSelection(deps.registry, 'How do Suno meta-tags work?').selected.map((s) => s.name)).toContain('suno-researcher');
  });
});
const waitFor = async (ok: () => Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
};
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/web/server/research.test.ts`
Expected: FAIL: cannot find `research-ops.ts`.

- [ ] **Step 3: Commit the red test**

```bash
git add apps/web/server/research.test.ts
git commit -m "AOS-04 red web tests: research loaders (index, run, library, song section) and ops (start in background, decide, promote)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Implement `research-ops.ts`**

```ts
// apps/web/server/research-ops.ts
import type { Sql } from '../../../core/db/client.ts';
import type { DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { embedPending } from '../../../knowledge/vector-retrieval/pipeline.ts';
import { loadEmbedder } from '../../../knowledge/vector-retrieval/embedder.ts';
import { runGate } from '../../../knowledge/promotion-gate/gate.ts';
import { retractResearchLink, type Brief } from '../../../research-intelligence/brief.ts';
import { executeResearch, openResearch, sweepResearch } from '../../../research-intelligence/entrypoint.ts';
import { decideFinding, decidePromotion, promoteFinding } from '../../../research-intelligence/library.ts';
import type { CandidateInput } from '../../../research-intelligence/synthesis/findings.ts';
import { songLink } from './ops.ts';

/**
 * Research's writes (AOS-04 §8). A run is opened here and awaited (so a bad brief comes back as the form's
 * error); its execution is started and NOT awaited (R5 on Next 14.2: `next start` is one long-lived Node
 * process, and executeResearch seals the run on every path). A server stop mid-run is the sweep's job.
 */

export const startBrief = async (deps: DispatchDeps, b: Brief & { readonly songIds?: readonly string[] }, log: (l: string) => void = (l) => console.error(l)) => {
  await sweepResearch(deps.sql);
  const { songIds, ...brief } = b;
  const opened = await openResearch(deps, brief, { requireIntendedUse: true });
  for (const songId of songIds ?? []) await songLink(deps, { songId, researchQuestionId: opened.questionId });
  void executeResearch(deps, opened.researchRunId, { log }).catch((e) => log(`research run ${opened.researchRunId}: ${e instanceof Error ? e.message : String(e)}`));
  return { researchRunId: opened.researchRunId };
};

export const rerun = async (deps: DispatchDeps, runId: string) => {
  const [q] = await deps.sql<{ slug: string; question: string; intended_use: string | null; urls: string[]; specialists: string[] | null }[]>`
    select p.slug, q.question, q.intended_use, q.urls, q.specialists
    from research_runs r join research_questions q on q.id = r.question_id join research_projects p on p.id = q.project_id where r.id = ${runId}`;
  if (!q) throw new Error(`no research run ${runId}`);
  // A re-run is a new brief row with the same fields; its links are the old brief's live research links.
  const links = await deps.sql<{ artifact_lineage_id: string | null; workflow_name: string | null; decision_key: string | null; role: string | null }[]>`
    select l.artifact_lineage_id, l.workflow_name, l.decision_key, l.role from research_links l join research_runs r on r.question_id = l.question_id
    where r.id = ${runId} and not exists (select from research_link_retractions x where x.research_link_id = l.id)`;
  const songs = await deps.sql<{ song_id: string }[]>`
    select l.song_id from current_song_links l join research_runs r on r.question_id = l.research_question_id where r.id = ${runId}`;
  return startBrief(deps, {
    projectSlug: q.slug, question: q.question, intendedUse: q.intended_use ?? '', urls: q.urls, ...(q.specialists ? { specialists: q.specialists } : {}),
    targets: links.map((l) => (l.artifact_lineage_id ? { kind: 'lineage' as const, artifactLineageId: l.artifact_lineage_id, ...(l.role ? { role: l.role } : {}) }
      : l.workflow_name ? { kind: 'workflow' as const, workflowName: l.workflow_name, ...(l.role ? { role: l.role } : {}) }
        : { kind: 'decision' as const, decisionKey: l.decision_key!, ...(l.role ? { role: l.role } : {}) })),
    songIds: songs.map((s) => s.song_id),
  });
};

export const decideFindingOp = (sql: Sql, findingId: string, decision: 'accept' | 'reject', reason: string, owner: string) =>
  decideFinding(sql, findingId, { decision, approver: owner, reason });

export const promoteOp = (sql: Sql, input: CandidateInput) => promoteFinding(sql, input);

const propagate = async (sql: Sql, candidateId: string) => {
  const r = await runGate(sql, candidateId);
  if (r.outcome === 'promoted') await embedPending(sql, await loadEmbedder());
  return r;
};
export const decidePromotionOp = (sql: Sql, approvalId: string, decision: 'approve' | 'reject', reason: string, owner: string) =>
  decidePromotion(sql, approvalId, { decision, approver: owner, reason }, (id) => propagate(sql, id));

export const retractLinkOp = (sql: Sql, linkId: string, reason: string) => retractResearchLink(sql, linkId, reason);
```

The re-run makes a new question row (a brief is immutable). Its song links are re-made through `songLink`, and its research links are copied. Name that behaviour in the workbench's Re-run button label: "Re-run (a new run of this brief)".

- [ ] **Step 5: Implement `research-loaders.ts`**

Write each loader as one `asWeb(sql, async (tx) => …)` in the style of `studio-loaders.ts`, with these queries:

- `researchIndex`:
  - briefs: `research_questions` newest first, limit 100;
  - targets: `research_targets`;
  - latest run: `distinct on (question_id) … order by created_at desc` on `research_runs`;
  - `specialists` from `deps.registry` (pass the registry in);
  - `workflows` from `workflowFiles()`;
  - `decisions` from `[...decisionKeys()]` sorted numerically.
- Target labels:
  - song: `songs` current title (`current_songs`);
  - lineage: `creative_artifacts.body->>'name'` of the root, else its `schema_id`;
  - workflow: `name@sha[0..8]`;
  - decision: the key.
- `runDetail`:
  - the run with `research_questions` and the brief's targets;
  - outcomes from `agent_runs where research_run_id = $1 and agent_name <> 'research-orchestrator'`, parsing `output` for `declined`, `failedUrls` and `passages`, and `error` for failures;
  - evidence joined to `research_sources`;
  - findings with `research_finding_evidence`, `contradictions`, `current_finding_decisions`, and `knowledge_candidates` left-joined to `approval_queue` (`item_type = 'knowledge_candidate'`), grouped by `claim_topic`;
  - `unsynthesized` = evidence with `claim_topic is null`.
- `library`: `findings_library` plus targets through `question_id`, plus quotes. Filter in SQL when `filter.kind` / `filter.target` are given (`exists (select from research_targets t where t.question_id = fl.question_id and t.kind = $kind and t.target = $target)`).
- `researchFor({ songId })`: briefs whose `research_targets` has `kind = 'song' and target = $songId`, and the library rows of those briefs. `researchFor({ lineageId })` does the same with `kind = 'lineage'`.
- `previewSelection(registry, question)`: `selectByScope(question, roster)` with `roster` built as in `entrypoint.ts` (`parseScope(a.name, a.sections.Scope!)`).

Every timestamp is returned as `toISOString()`; the page renders it with `<Time>`.

- [ ] **Step 6: Web runtime, doors, boot sweep**

`apps/web/server/runtime.ts`: add the LLM runner to the web's dispatch deps.

```ts
import { createRuntimeLlmRunner } from '../../../core/runtime/programs.ts';
// …
    const deps: DispatchDeps = { sql, registry: createAgentRegistry({ dir: join(import.meta.dirname, '..', '..', '..', 'agents') }), tools: createRuntimeTools({ sql }), handlers: HANDLERS, llmRunner: createRuntimeLlmRunner() };
```

`apps/web/lib/server.ts`:

```ts
type ResearchLoaders = typeof import('../server/research-loaders.ts');
type ResearchOps = typeof import('../server/research-ops.ts');
export const researchLoaders = () => osImport<ResearchLoaders>('apps/web/server/research-loaders.ts');
export const researchOps = () => osImport<ResearchOps>('apps/web/server/research-ops.ts');
```

`apps/web/next.config.mjs`: `experimental: { serverActions: { bodySizeLimit: '256mb' }, instrumentationHook: true },` with the comment `// AOS-04: instrumentation.ts sweeps research runs a stopped server left running (Next 14.2 needs the flag).`

`apps/web/instrumentation.ts`:

```ts
// AOS-04 (R5): at server boot, seal research runs that a previous server process left running past their
// deadline. Runs started by this process execute in it (research-ops startBrief); a stop kills them.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { researchOps, runtime } = await import('./lib/server');
  const rt = await runtime();
  const ro = await researchOps();
  const sealed = await ro.sweepOnBoot(rt.sql);
  if (sealed.length > 0) console.error(`research: sealed ${sealed.length} abandoned run(s): ${sealed.join(', ')}`);
}
```

and in `research-ops.ts`: `export const sweepOnBoot = (sql: Sql) => sweepResearch(sql);`.

- [ ] **Step 7: Run the tests and the build**

Run: `pnpm vitest run apps/web/server && pnpm typecheck && pnpm web:build`
Expected: PASS, build succeeds.

- [ ] **Step 8: Commit**

```bash
git add apps/web/server apps/web/lib/server.ts apps/web/instrumentation.ts apps/web/next.config.mjs
git commit -m "AOS-04: web research loaders and ops; runs start in the background of next start (R5 on Next 14.2); boot sweep" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Research screens

**Files:**
- Create: `apps/web/app/research-actions.ts`, `apps/web/app/research/page.tsx`, `apps/web/app/research/research-ui.tsx`, `apps/web/app/research/runs/[id]/page.tsx`, `apps/web/app/research/library/page.tsx`
- Modify: `apps/web/app/layout.tsx` (nav), `apps/web/app/songs/[id]/page.tsx`, `apps/web/app/studio/recipes/[id]/page.tsx`, `apps/web/app/studio/tags/[id]/page.tsx`

**Interfaces:**
- Consumes: Task 9's `researchLoaders()` and `researchOps()`; `attempt`, `text`, `opt`, `local` (`action-kit.ts`); `ErrorBanner`, `Time`, `Status` (`ui.tsx`).

These screens use the current shell and `ui.tsx`. Plan B re-skins them with the Mercury tokens and layout (§§13–14), and Plan C adds the sphere and graph neighbourhoods. Built here: §17's content and behaviour. Readable text, labelled fields, reasons required, status words and not only colour, and a refresh that doesn't steal focus.

- [ ] **Step 1: Server actions**

```ts
// apps/web/app/research-actions.ts
'use server';

import { attempt, local, opt, text } from './action-kit';
import { researchOps, runtime } from '../lib/server';

// Research's writes (AOS-04 §8) through apps/web/server/research-ops.ts. A refusal comes back as ?error=.

const lines = (v: string) => v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

export async function briefAction(form: FormData) {
  return attempt('/research', async () => {
    const rt = await runtime();
    const targets = [
      ...form.getAll('lineageId').map(String).filter(Boolean).map((id) => ({ kind: 'lineage' as const, artifactLineageId: id })),
      ...form.getAll('workflowName').map(String).filter(Boolean).map((n) => ({ kind: 'workflow' as const, workflowName: n })),
      ...lines(text(form, 'decisionKeys').replace(/[ ,]+/g, '\n')).map((k) => ({ kind: 'decision' as const, decisionKey: k })),
    ];
    const picked = form.getAll('specialist').map(String);
    return (await researchOps()).startBrief(rt.deps, {
      projectSlug: opt(form, 'projectSlug') ?? 'research', question: text(form, 'question'), intendedUse: text(form, 'intendedUse'),
      urls: lines(text(form, 'urls')), targets, songIds: form.getAll('songId').map(String).filter(Boolean),
      ...(form.get('override') === 'on' ? { specialists: picked } : {}),
    });
  }, (r) => `/research/runs/${r.researchRunId}`);
}

export async function rerunAction(form: FormData) {
  const runId = text(form, 'runId');
  return attempt(`/research/runs/${runId}`, async () => (await researchOps()).rerun((await runtime()).deps, runId), (r) => `/research/runs/${r.researchRunId}`);
}

export async function decideFindingAction(form: FormData) {
  const decision = text(form, 'decision') === 'accept' ? 'accept' : 'reject';
  return attempt(local(text(form, 'back'), '/research/library'), async () => {
    const rt = await runtime();
    return (await researchOps()).decideFindingOp(rt.sql, text(form, 'findingId'), decision, text(form, 'reason'), rt.owner);
  });
}

export async function promoteAction(form: FormData) {
  return attempt(local(text(form, 'back'), '/research/library'), async () => (await researchOps()).promoteOp((await runtime()).sql, {
    findingId: text(form, 'findingId'), proposed_kind: text(form, 'kind') === 'module' ? 'module' : 'canonical_prompt',
    target_slug: text(form, 'targetSlug'), title: text(form, 'title'), body: text(form, 'body'), domain: text(form, 'domain') as never,
  }));
}

export async function decidePromotionAction(form: FormData) {
  const decision = text(form, 'decision') === 'approve' ? 'approve' : 'reject';
  return attempt(local(text(form, 'back'), '/research/library'), async () => {
    const rt = await runtime();
    return (await researchOps()).decidePromotionOp(rt.sql, text(form, 'approvalId'), decision, text(form, 'reason'), rt.owner);
  });
}

export async function retractLinkAction(form: FormData) {
  return attempt(local(text(form, 'back'), '/research'), async () => (await researchOps()).retractLinkOp((await runtime()).sql, text(form, 'linkId'), text(form, 'reason')));
}
```

Replace the `as never` on `domain` with the `Domain` type from `core/contracts/taxonomy.ts`, after validating the value is one of its keys (throw `domain must be one of …`).

- [ ] **Step 2: `/research` (brief list and new brief)**

```tsx
// apps/web/app/research/page.tsx
import { researchLoaders, runtime } from '../../lib/server';
import { ErrorBanner, Status, Time, first } from '../ui';
import { BriefForm, TargetChips } from './research-ui';

export const dynamic = 'force-dynamic';

export default async function Research({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const rl = await researchLoaders();
  const rt = await runtime();
  const r = await rl.researchIndex(rt.sql, rt.deps.registry);
  const q = first(searchParams.q) ?? '';
  const preview = q ? rl.previewSelection(rt.deps.registry, q) : null;
  return (
    <section>
      <h1>Research</h1>
      <p className="meta mt-1">
        A brief asks a question for a stated use. The selected specialists read the brief&apos;s URLs and the canonical knowledge, and every claim quotes its source.
        Findings enter the <a href="/research/library">Findings Library</a> only when you accept them, and become canonical only when you approve their promotion. Read at <Time at={r.asOf} />.
      </p>
      <ErrorBanner error={searchParams.error} />

      <h2>Briefs</h2>
      <table>
        <thead><tr><th>Question</th><th>Intended use</th><th>Targets</th><th>Latest run</th><th>Opened</th></tr></thead>
        <tbody>
          {r.briefs.map((b) => (
            <tr key={b.questionId}>
              <td>{b.latestRun ? <a href={`/research/runs/${b.latestRun.id}`}>{b.question}</a> : b.question}</td>
              <td>{b.intendedUse ?? <span className="meta">not stated (before AOS-04)</span>}</td>
              <td><TargetChips targets={b.targets} /></td>
              <td>{b.latestRun ? <Status status={b.latestRun.status} /> : <span className="meta">none</span>}</td>
              <td className="meta"><Time at={b.createdAt} /></td>
            </tr>
          ))}
          {r.briefs.length === 0 && <tr><td colSpan={5} className="meta">no brief yet</td></tr>}
        </tbody>
      </table>

      <h2>New brief</h2>
      <form method="get" className="mt-2">
        <label>Preview the specialists for a question <input name="q" defaultValue={q} className="w-full" /></label>
        <button type="submit">Preview</button>
      </form>
      <BriefForm question={q} preview={preview} specialists={r.specialists} workflows={r.workflows} decisions={r.decisions} songs={r.songs} lineages={r.lineages} />
    </section>
  );
}
```

`researchIndex` also returns `songs: { id, title }[]` (from `current_songs`) and `lineages: { id, name, kind: 'recipe' | 'tags' | 'lyrics' }[]` (roots of the three schemas) for the pickers. Add both to the Task 9 loader and its test.

`research-ui.tsx` holds `BriefForm`, `TargetChips`, `EvidenceCard`, `FindingCard`, `DecideForm`, `PromoteForm`, `ApprovalForm` and `AutoRefresh`:

```tsx
// apps/web/app/research/research-ui.tsx
import type { Selection } from '../../../../core/orchestrator/scope-select.ts';
import { briefAction, decideFindingAction, decidePromotionAction, promoteAction } from '../research-actions';

type Target = { kind: string; target: string; label: string; role: string | null; linkId: string };

export const TargetChips = ({ targets }: { targets: readonly Target[] }) => (
  <>{targets.length === 0 ? <span className="meta">none</span> : targets.map((t) => (
    <span key={t.linkId} className="tag">{t.kind}: {t.kind === 'song' ? <a href={`/songs/${t.target}`}>{t.label}</a> : t.label}{t.role ? ` (${t.role})` : ''}</span>
  ))}</>
);

export const BriefForm = (p: {
  question: string; preview: Selection | null;
  specialists: readonly { name: string; scope: string }[]; workflows: readonly string[]; decisions: readonly string[];
  songs: readonly { id: string; title: string }[]; lineages: readonly { id: string; name: string; kind: string }[];
}) => {
  const picked = new Set(p.preview?.selected.map((s) => s.name) ?? []);
  const scoreOf = new Map([...(p.preview?.selected ?? []), ...(p.preview?.notSelected ?? [])].map((s) => [s.name, s]));
  return (
    <form action={briefAction} className="mt-2 grid gap-2">
      <label>Question <textarea name="question" required defaultValue={p.question} rows={2} className="w-full" /></label>
      <label>Intended use (what the answer is for) <textarea name="intendedUse" required rows={2} className="w-full" /></label>
      <label>Source URLs, one per line (the only external pages the specialists may read) <textarea name="urls" rows={3} className="w-full" /></label>
      <fieldset><legend>Links</legend>
        <label>Songs <select name="songId" multiple className="w-full">{p.songs.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
        <label>Recipes, tag sets, lyrics <select name="lineageId" multiple className="w-full">{p.lineages.map((l) => <option key={l.id} value={l.id}>{l.kind}: {l.name}</option>)}</select></label>
        <label>Workflows <select name="workflowName" multiple className="w-full">{p.workflows.map((w) => <option key={w} value={w}>{w}</option>)}</select></label>
        <label>Decisions (e.g. F41 F40) <input name="decisionKeys" list="decision-keys" className="w-full" /></label>
        <datalist id="decision-keys">{p.decisions.map((d) => <option key={d} value={d} />)}</datalist>
      </fieldset>
      <fieldset><legend>Specialists</legend>
        <label><input type="checkbox" name="override" defaultChecked={false} /> Use my picks below instead of the keyword selection</label>
        {p.specialists.map((s) => {
          const sc = scoreOf.get(s.name);
          return (
            <label key={s.name} className="block">
              <input type="checkbox" name="specialist" value={s.name} defaultChecked={picked.has(s.name)} /> {s.name}
              <span className="meta"> — score {sc?.score ?? 0}{sc && sc.matched.length > 0 ? ` (${sc.matched.join(', ')})` : ''}</span>
            </label>
          );
        })}
      </fieldset>
      <button type="submit">Open the brief and run it</button>
    </form>
  );
};

export const DecideForm = ({ findingId, back }: { findingId: string; back: string }) => (
  <form action={decideFindingAction} className="mt-1">
    <input type="hidden" name="findingId" value={findingId} /><input type="hidden" name="back" value={back} />
    <label>Reason <input name="reason" required /></label>
    <button type="submit" name="decision" value="accept">Accept into the library</button>
    <button type="submit" name="decision" value="reject">Reject</button>
  </form>
);

export const PromoteForm = ({ findingId, back, topic }: { findingId: string; back: string; topic: string }) => (
  <form action={promoteAction} className="mt-1 grid gap-1">
    <input type="hidden" name="findingId" value={findingId} /><input type="hidden" name="back" value={back} />
    <label>Kind <select name="kind"><option value="canonical_prompt">canonical prompt</option><option value="module">module</option></select></label>
    <label>Target slug <input name="targetSlug" required defaultValue={topic.replace(/\./g, '-')} /></label>
    <label>Title <input name="title" required /></label>
    <label>Body (the canonical text) <textarea name="body" required rows={3} /></label>
    <label>Domain <select name="domain"><option>RECORDS</option><option>KNOWLEDGE</option><option>RESEARCH_INTELLIGENCE</option><option>CORE</option><option>TECH</option><option>GOVERNANCE</option></select></label>
    <button type="submit">Propose for canonical (goes to the gate, then to you)</button>
  </form>
);

export const ApprovalForm = ({ approvalId, back }: { approvalId: string; back: string }) => (
  <form action={decidePromotionAction} className="mt-1">
    <input type="hidden" name="approvalId" value={approvalId} /><input type="hidden" name="back" value={back} />
    <label>Reason <input name="reason" required /></label>
    <button type="submit" name="decision" value="approve">Approve canonical</button>
    <button type="submit" name="decision" value="reject">Reject</button>
  </form>
);

// Refreshes a running run's page without a client framework: a meta refresh would reset a half-typed
// reason, so the page renders this only while no form on it has focus-worthy state (the run is running and
// has no findings yet). Once findings exist the owner refreshes by hand.
export const AutoRefresh = ({ seconds }: { seconds: number }) => <meta httpEquiv="refresh" content={String(seconds)} />;
```

Check the `Domain` values against `core/contracts/taxonomy.ts` and render them from there instead of the literal list.

- [ ] **Step 3: `/research/runs/[id]` (the workbench)**

```tsx
// apps/web/app/research/runs/[id]/page.tsx
import { notFound } from 'next/navigation';
import { researchLoaders, runtime } from '../../../../lib/server';
import { rerunAction } from '../../../research-actions';
import { ErrorBanner, Status, Time } from '../../../ui';
import { ApprovalForm, AutoRefresh, DecideForm, PromoteForm, TargetChips } from '../../research-ui';

export const dynamic = 'force-dynamic';

export default async function Run({ params, searchParams }: { params: { id: string }; searchParams: Record<string, string | string[] | undefined> }) {
  const d = await (await researchLoaders()).runDetail((await runtime()).sql, params.id);
  if (!d) notFound();
  const back = `/research/runs/${d.run.id}`;
  const running = d.run.status === 'running';
  const done = d.outcomes.filter((o) => o.status !== 'running').length;
  return (
    <section>
      {running && d.topics.length === 0 && <AutoRefresh seconds={5} />}
      <h1>{d.brief.question}</h1>
      <p className="meta mt-1">
        <Status status={d.run.status} /> · started <Time at={d.run.createdAt} /> · {running ? <>deadline <Time at={d.run.expiresAt} /></> : <>ended <Time at={d.run.completedAt} /></>}
        {' · '}{d.run.selected.length > 0 ? `${done} of ${d.run.selected.length} specialists finished` : 'no specialist selected'}
      </p>
      <p>Intended use: {d.brief.intendedUse ?? <span className="meta">not stated</span>}</p>
      <p>Targets: <TargetChips targets={d.brief.targets} /></p>
      {d.run.error && <p className="error">{d.run.error}{d.evidence.length > 0 ? ' — the evidence below was written before the failure (partial).' : ''}</p>}
      <ErrorBanner error={searchParams.error} />
      <form action={rerunAction}><input type="hidden" name="runId" value={d.run.id} /><button type="submit">Re-run (a new run of this brief)</button></form>

      <h2>Specialists</h2>
      <table>
        <thead><tr><th>Specialist</th><th>Outcome</th><th>Passages</th><th>Declined</th><th>Failed URLs</th></tr></thead>
        <tbody>
          {d.outcomes.map((o) => (
            <tr key={o.specialist}>
              <td>{o.specialist}</td>
              <td>{o.status === 'error' ? <span className="status-error">failed: {o.error}</span> : o.passages === 0 ? 'no sources' : <Status status={o.status} />}</td>
              <td>{o.passages ?? '—'}</td>
              <td>{o.declined.map((x, i) => <div key={i} className="meta">{x.claim ? `“${x.claim}”: ` : ''}{x.reason}</div>)}</td>
              <td>{o.failedUrls.map((f) => <div key={f.url} className="meta">{f.url}: {f.reason}</div>)}</td>
            </tr>
          ))}
          {d.outcomes.length === 0 && <tr><td colSpan={5} className="meta">{running ? 'starting…' : 'none ran'}</td></tr>}
        </tbody>
      </table>

      <h2>Findings by topic</h2>
      {d.topics.map((t) => (
        <article key={t.topic} className="mt-2">
          <h3>{t.topic}{t.findings.length > 1 ? ' — the specialists disagree' : ''}</h3>
          <div className={t.findings.length > 1 ? 'grid md:grid-cols-2 gap-2' : ''}>
            {t.findings.map((f) => (
              <div key={f.id} className="card">
                <p><strong>{JSON.stringify(f.claimValue)}</strong> — {f.claim}</p>
                <p className="meta">model tag {f.modelTag} · confidence {f.confidence.toFixed(2)} · {f.evidenceIds.length} evidence</p>
                {f.contradictions.map((c) => <p key={c.id} className="status-warning">contradicts {c.targetType} {c.targetId} ({c.status})</p>)}
                {d.evidence.filter((e) => f.evidenceIds.includes(e.id)).map((e) => (
                  <blockquote key={e.id} className="mt-1">
                    “{e.quote}”
                    <footer className="meta">{e.specialist} · <a href={e.source.uri}>{e.source.title}</a> ({e.source.kind}, reliability {e.source.reliability ?? 'unknown'}) · {JSON.stringify(e.confidenceInputs)}</footer>
                  </blockquote>
                ))}
                {f.decision
                  ? <p>Library: <Status status={f.decision.decision === 'accept' ? 'accepted' : 'rejected'} /> by {f.decision.by} — {f.decision.reason}</p>
                  : <DecideForm findingId={f.id} back={back} />}
                {f.candidates.map((c) => (
                  <div key={c.id}>
                    Canonical: <Status status={c.status} />
                    {c.approvalId && c.approvalStatus === 'pending' && <ApprovalForm approvalId={c.approvalId} back={back} />}
                  </div>
                ))}
                {f.decision?.decision === 'accept' && f.candidates.length === 0 && <PromoteForm findingId={f.id} back={back} topic={f.claimTopic} />}
              </div>
            ))}
          </div>
        </article>
      ))}
      {d.topics.length === 0 && <p className="meta">{running ? 'no finding yet' : 'no finding'}</p>}
      {d.unsynthesized.length > 0 && <><h2>Evidence without a topic</h2>{d.unsynthesized.map((e) => <blockquote key={e.id}>“{e.quote}” — {e.claim}</blockquote>)}</>}
    </section>
  );
}
```

- [ ] **Step 4: `/research/library`**

```tsx
// apps/web/app/research/library/page.tsx
import { researchLoaders, runtime } from '../../../lib/server';
import { ErrorBanner, Status, Time, first } from '../../ui';
import { ApprovalForm, PromoteForm, TargetChips } from '../research-ui';

export const dynamic = 'force-dynamic';

export default async function Library({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const kind = first(searchParams.kind);
  const target = first(searchParams.target);
  const rows = await (await researchLoaders()).library((await runtime()).sql, { ...(kind ? { kind } : {}), ...(target ? { target } : {}) });
  return (
    <section>
      <h1>Findings Library</h1>
      <p className="meta mt-1">Findings you accepted. Accepted is not canonical: canonical status is shown separately and changes only when you approve a promotion.</p>
      <ErrorBanner error={searchParams.error} />
      <form method="get" className="mt-2">
        <label>Target kind <select name="kind" defaultValue={kind ?? ''}><option value="">any</option><option>song</option><option>lineage</option><option>workflow</option><option>decision</option></select></label>
        <label>Target <input name="target" defaultValue={target ?? ''} /></label>
        <button type="submit">Filter</button>
      </form>
      {rows.map((l) => (
        <article key={l.findingId} className="card mt-2">
          <p><strong>{l.claimTopic}</strong> = {JSON.stringify(l.claimValue)} — {l.claim}</p>
          <p className="meta">from <a href={`/research/runs/${l.runId}`}>{l.question}</a> · {l.evidenceCount} evidence · accepted <Time at={l.decidedAt} /> · canonical: <Status status={l.canonicalStatus} /></p>
          <p>Targets (inherited from the brief): <TargetChips targets={l.targets} /></p>
          {l.quotes.map((q, i) => <blockquote key={i}>“{q.quote}” <footer className="meta"><a href={q.uri}>{q.title}</a></footer></blockquote>)}
          {l.canonicalStatus === 'none' && <PromoteForm findingId={l.findingId} back="/research/library" topic={l.claimTopic} />}
        </article>
      ))}
      {rows.length === 0 && <p className="meta">no accepted finding{kind || target ? ' for this filter' : ' yet'}</p>}
    </section>
  );
}
```

A pending canonical approval is decided on the run page (`ApprovalForm`). Remove the unused `ApprovalForm` import here if the typecheck flags it.

- [ ] **Step 5: Nav and the three Research sections**

`apps/web/app/layout.tsx`: add `<a href="/research">Research</a>` after Studio.

In `songs/[id]/page.tsx`, `studio/recipes/[id]/page.tsx` and `studio/tags/[id]/page.tsx`, add one section at the end, reading `researchFor(sql, { songId })` or `{ lineageId }`:

```tsx
      <h2>Research</h2>
      <table>
        <thead><tr><th>Brief</th><th>Latest run</th></tr></thead>
        <tbody>
          {research.briefs.map((b) => <tr key={b.questionId}><td>{b.latestRun ? <a href={`/research/runs/${b.latestRun.id}`}>{b.question}</a> : b.question}</td><td>{b.latestRun ? <Status status={b.latestRun.status} /> : '—'}</td></tr>)}
          {research.briefs.length === 0 && <tr><td colSpan={2} className="meta">no brief links this yet — <a href="/research">open one</a></td></tr>}
        </tbody>
      </table>
      {research.findings.map((f) => <p key={f.findingId}><a href={`/research/runs/${f.runId}`}>{f.claimTopic}</a>: {f.claim} <span className="meta">(canonical: {f.canonicalStatus})</span></p>)}
```

- [ ] **Step 6: Build and typecheck**

Run: `pnpm typecheck && pnpm web:build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app
git commit -m "AOS-04 UI: /research (briefs, new brief with specialist preview and links), the run workbench, the Findings Library, Research sections on songs, recipes and tag sets" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The browser smoke journey

**Files:**
- Modify: `apps/web/e2e/smoke.ts`

- [ ] **Step 1: Seed a finished run before the browser starts**

After the AOS-03 journey's DB setup, before the browser opens, run one brief to completion in the smoke process:
- deps: the smoke's DB, `createRuntimeTools({ sql, env: {}, fetch: pageFetch })`, and an `llmRunner` from `createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: fakeModel(<the Task 5 override>).fn })`;
- `runResearch` on it, linked to the smoke's song.

This keeps the fake model out of the web server. The server itself has no key, so a brief the browser opens either selects nobody or fails loudly; both are asserted below.

- [ ] **Step 2: Drive the journey**

Append the AOS-04 steps, in the file's style (`check`, `submit`, `approveIn`, `shot`):

1. `/research` lists the seeded brief with target `song: <title>`.
2. Open its run page: status `success`, one finding under `suno.vocal-descriptor-position`, and the quote `Put the vocal descriptor first.` is visible.
3. Accept it with a reason. The page shows `accepted`.
4. `/research/library` lists it with `canonical: none`. Promote it (fill slug, title, body). The run page shows `Canonical: pending_approval`.
5. Approve canonical with a reason. `/research/library` shows `canonical: promoted`.
6. The song page's Research section links the brief.
7. Open a new brief from the form with the override ticked and no specialist picked. It is refused with `specialists: pick at least one`, and the error banner shows it.
8. Open a new brief with keyword selection on a question no specialist matches (`[FIXTURE] What should we eat tonight?`). The run page shows `success` and `no specialist selected`. This exercises the background start and the redirect.

Update the header comment's journey list with `AOS-04: …`.

- [ ] **Step 3: Run it**

Run: `pnpm web:build && pnpm web:smoke`
Expected: every `ok` line prints, exit 0. On Windows set `XYP_CHROMIUM` to a local Chromium or Chrome path first; the default `/opt/pw-browsers/chromium` is the container's.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/smoke.ts
git commit -m "AOS-04: web:smoke drives the Research journey (seeded run, accept, promote, approve, song section, refused and empty briefs)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Proof, docs, handoff

**Files:**
- Create: `docs/proofs/AOS-04-research.txt`, `docs/handoffs/AOS-04.md`
- Modify: `docs/ARCHITECTURE.md` (F42 decided, F43 open), `docs/SCHEMA.md`, `docs/artist-os/AOS-04-design.md` (the patch below), `README.md` (Research mode line, if the README lists modes)

- [ ] **Step 1: Patch the spec to match what was built**

In `AOS-04-design.md`:

- **§4 Library tier:** replace "The latest decision is current; a finding can be re-decided." with "One decision per finding, final (`approval_queue_item_key`); a better finding comes from a new run."
- **§7:** drop "a finding can be re-decided".
- **§6:** after "inserts the question, its links and the run", add "(song targets are linked afterwards through `link_song`, a Records agent run, A1)".
- **§8:** replace "`after(() => executeResearch(runId))`" with "`executeResearch(runId)` started without awaiting (R5 on Next 14.2; §12.3)".
- **§12.3:** mark the compatibility gap resolved: "Resolved 2026-09-26 (operator): a detached promise in the `next start` process; no Next upgrade."
- **Header:** add "Plans: A = [AOS-04-plan.md](AOS-04-plan.md) (§§1–11, 17); B (Mercury shell) and C (graph, index, sphere) to follow."

- [ ] **Step 2: The proof**

`docs/proofs/AOS-04-research.txt`, in the format of `docs/proofs/AOS-03-studio.txt`:

1. **The tests:** `pnpm test` summary line, plus the `tests/aos-04` file list with counts.
2. **The gate via the CLIs:**
   - `pnpm research ask` with a real brief (one real URL you choose, `songId` of a real song) on `OPENROUTER_API_KEY`, output trimmed to the run, evidence and findings;
   - `pnpm research decide … accept`, `pnpm research promote …`, `pnpm gate decide … approve`;
   - the chain query from Task 8 on the dev DB.

   If the free route is overloaded, paste the actual error, mark the live part **not run**, and keep the fixture run as the gate's evidence.
3. **The browser:** `pnpm web:smoke` output (and screenshot names if a dir was passed).
4. **The gates:** typecheck, suite, `agents:validate`, migration round trip, `web:build`, with pass/fail.

- [ ] **Step 3: ARCHITECTURE, SCHEMA, handoff**

- **ARCHITECTURE F42:**
  - "Research mode (AOS-04). DECIDED (operator, 2026-09-26; design `docs/artist-os/AOS-04-design.md`)", with R1–R5 one line each;
  - the R5 Next 14.2 resolution;
  - one decision per finding.
- **F43 (open):**
  - the §11 list;
  - legacy `research_sources` rows without text can't back a new quote;
  - Plans B and C (Mercury shell; graph, index and sphere) not built.
- **SCHEMA:** a section for migration `20260926100000_research_mode`, in the style of the AOS-03 section: the columns, the tables, the views, the functions and the roles.
- **`docs/handoffs/AOS-04.md`:** in the shape of `AOS-03.md`:
  - Built;
  - Numbers (agents 51, tools 37, capabilities 23, tables 57 (+2), views 21 (+3); tests: the real count from `pnpm test`);
  - The gate;
  - Changed on purpose (the specialists' model, the Phase 6B roster pin, plan step inputs bound through the workflow input, the orchestrator's `owner`, the web runtime's `llmRunner`);
  - Found and fixed;
  - Open (F43);
  - Next: Plan B (Mercury shell), then Plan C, then AOS-05 (Whisper and Kokoro).

- [ ] **Step 4: Run every gate**

Run: `pnpm typecheck && pnpm test && pnpm agents:validate && pnpm db:down && pnpm db:up && pnpm db:down && pnpm db:up && pnpm web:build`
Expected: all pass. Paste the summaries into the proof.

- [ ] **Step 5: Commit**

```bash
git add docs README.md
git commit -m "AOS-04 proof and docs: the gate three ways, SCHEMA, F42 decided, F43 open, handoff; the spec matches what was built" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
