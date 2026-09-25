# Phase 12 — Critic + Revision System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the X3LIUS creative loop. A Critic agent writes structured critiques of creative artifacts, a Revision agent writes corrected versions, and a loop controller runs them with a cap of 3 revisions and escalates stalled loops to the human queue. The Phase 6C Experiment Engine scores trials through the Critic.

**Architecture:**
- The Critic (`x3lius-evaluation`, class Critic) and Revision (`x3lius-revision`, class Revision) are ordinary registered LLM agents on the shared runner. Code checks structured claims, and a model judges prose rules; code verifies every violation the model reports.
- Critiques live in a new insert-only `critiques` table. A revised artifact version names the critique it answers.
- The loop controller is a service that dispatches both agents through the Orchestrator. It queues escalations through one `SECURITY DEFINER` function that only its own role can call.

**Tech Stack:** TypeScript on Node (run directly with `node file.ts`), Postgres through `postgres` (postgres.js), vitest, local Supabase-emulated Postgres (`tests/helpers/db.ts` throwaway DBs), and the FAKE model (`tests/helpers/fake-llm.ts`) for every LLM call in tests.

**Spec:** `docs/superpowers/specs/2026-09-25-phase-12-critic-revision-design.md`. Read it first; this plan argues from it.

## Global Constraints

- `MAX_REVISIONS = 3`. Changing it is a new flagged decision in ARCHITECTURE.md, never a silent edit.
- Critique schema id `x3lius.critique/v1`. LLM schema ids are `x3lius.critique-llm/v1` and `x3lius.revision-llm/v1`.
- DB roles:
  - `xyp_critic`: INSERT/SELECT on `critiques` only.
  - `xyp_evaluation_loop`: EXECUTE on `public.xyp_escalate_critique(uuid, jsonb)` only.
  - `xyp_runtime`: SELECT on `critiques`.
- Escalations go to `approval_queue` with `item_type = 'critique_escalation'` and `item_id` = the final critique id.
- New capability `critique.read` for Critic, Revision and Governance. `critique.write` stays Critic only.
- The agents' model is `openrouter:nvidia/nemotron-3-ultra-550b-a55b:free` (same as the creative agents).
- The 6C scorer id is `critic:x3lius-evaluation`. The new Phase 9 take-scoring stub marker is `stub:needs-trace-analysis`.
- Violation key = `` `${ruleRef}@${path}` ``. Paths are JSON Pointers (RFC 6901). The root `""` is never a field.
- The JSON-schema subset has no null, so optional fields are omitted, never null.
- Test fixtures carry `[FIXTURE]` in every text field. Model replies in tests come from the FAKE model (`[FAKE]` text) or from scripted `override`s.
- Migrations are idempotent and paired with a rollback. `tests/phase-01/migrations.test.ts` runs up, re-up, down, re-down, up over every pair.
- Code comments follow the repo's style: a JSDoc header on each exported function, `@param`/`@returns`/`@throws`, and a short "why" comment where code does something non-obvious.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run everything from the worktree root. Suite: `npx vitest run`. Typecheck: `npx tsc --noEmit -p .`

## Review Focus

1. **A model reply giving a JSONPath (`$.sections[0].text`) instead of a JSON Pointer.** The violation must land in `unverified` with a reason, not crash and not count. Test: Task 4 `verify.test.ts`.
2. **A model quote that differs from the artifact by case or whitespace.** It is dropped as unverified; code never "fuzzily" accepts it. Test: Task 4 `verify.test.ts`.
3. **A revision replacing a number field with text such as `"120 bpm"`.** Refused, with nothing written. Test: Task 6 `edits.test.ts`.
4. **`pnpm evaluate` with a malformed or unknown id.** A clear error before any agent runs, not a Postgres uuid syntax error. Test: Task 8 loop integration.
5. **Pointer keys containing `/` or `~`.** They round-trip through `~1`/`~0`. Test: Task 3 `pointer.test.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260925100000_critiques.sql` (+ `supabase/rollbacks/…down.sql`) | `critiques` table, chain and immutability triggers, `creative_artifacts.critique_id`, `xyp_escalate_critique`, roles and grants |
| `records/x3lius/evaluation/schemas.ts` | Critique types, the stored-critique schema, LLM reply schemas, `violationKey`, `critiqueBodyErrors` |
| `records/x3lius/evaluation/tools.ts` | `write_critique` (critique.write, as `xyp_critic`) and `read_critique` (critique.read, as `xyp_runtime`) |
| `records/x3lius/evaluation/pointer.ts` | JSON Pointer get/set/containment |
| `records/x3lius/evaluation/checks.ts` | Code checks: Suno length claims, mix-report checks |
| `records/x3lius/evaluation/verify.ts` | Verifying model-reported violations |
| `records/x3lius/evaluation/critic.ts` | The Critic's LlmProgram |
| `records/x3lius/evaluation/edits.ts` | Applying revision edits and re-deriving fields |
| `records/x3lius/evaluation/revision.ts` | The Revision LlmProgram |
| `records/x3lius/evaluation/loop.ts` | `decide` (pure) and `evaluate` (dispatch plus escalation) |
| `records/x3lius/evaluation/scorer.ts` | `scoreOf`, `criticScorer` for 6C |
| `records/x3lius/evaluation/cli.ts` | `pnpm evaluate <artifactId>` |
| `core/runtime/deps.ts` | `createRuntimeDeps(sql)` for CLIs |
| Modified | `core/tool-registry/capabilities.ts`, `docs/AGENT_CLASSES.md`, `core/tool-registry/tools/read-artifact.ts`, `core/tool-registry/tools/write-artifact.ts`, `core/runtime/{tools,programs,handlers}.ts`, `records/x3lius/creative/program.ts`, `records/x3lius/suno/formula.ts`, `records/x3lius/suno/score-hook.ts`, `research-intelligence/experiments/engine.ts`, `research-intelligence/cli.ts`, `agents/x3lius-evaluation.agent.md`, `tests/helpers/fake-llm.ts`, and tests in phases 07, 09 and 11 |
| New agents | `agents/x3lius-revision.agent.md` |
| Tests | `tests/phase-12/critiques-db.test.ts`, `tests/phase-12/critic-revision.test.ts`, `records/x3lius/evaluation/*.test.ts`, `tests/helpers/trace-fixture.ts` |

---

### Task 1: Migration — critiques, critique_id, escalation function

**Files:**
- Create: `supabase/migrations/20260925100000_critiques.sql`
- Create: `supabase/rollbacks/20260925100000_critiques.down.sql`
- Test: `tests/phase-12/critiques-db.test.ts`

**Interfaces:**
- Consumes: `creative_artifacts`, `agent_runs`, `approval_queue` (earlier migrations); `createTestDb` from `tests/helpers/db.ts`.
- Produces:
  - table `public.critiques(id, artifact_id, previous_id, agent_run_id, schema_id, body, checked, passed, created_at)`;
  - column `public.creative_artifacts.critique_id uuid null`;
  - function `public.xyp_escalate_critique(p_critique_id uuid, p_request jsonb) returns uuid`;
  - roles `xyp_critic` and `xyp_evaluation_loop`.

- [ ] **Step 1: Write the failing DB test**

`tests/phase-12/critiques-db.test.ts`:

```ts
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.ts';

// Phase 12 proof (part 1): the critiques table, the critique_id link on creative_artifacts and the
// escalation function, on a throwaway migrated database. Fixture rows are inserted directly under
// the role that owns each write; no agent or model runs here.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('phase12_critiques', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

const as = <T>(role: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  db.sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${role}`);
    return fn(tx);
  }) as Promise<T>;

const runRow = async (agent: string, cls: string): Promise<string> =>
  (await db.sql<{ id: string }[]>`insert into agent_runs (agent_name, class, domain, input) values (${agent}, ${cls}, 'RECORDS', '{}') returning id`)[0]!.id;

const artifact = async (parentId: string | null = null, critiqueId: string | null = null): Promise<string> => {
  const runId = await runRow('x3lius-lyrics', 'Creative');
  return as('xyp_creative', async (tx) => (await tx<{ id: string }[]>`
    insert into creative_artifacts (schema_id, agent_name, agent_run_id, parent_id, critique_id, brief, body, context_refs, knowledge, model)
    values ('x3lius.lyrics/v2', 'x3lius-lyrics', ${runId}, ${parentId}, ${critiqueId}, '[FIXTURE] brief', '{"fixture": true}', '[]', '{}', 'fake:model')
    returning id`)[0]!.id);
};

const critique = async (artifactId: string, previousId: string | null = null, counts = { checked: 2, passed: 1 }): Promise<string> => {
  const runId = await runRow('x3lius-evaluation', 'Critic');
  return as('xyp_critic', async (tx) => (await tx<{ id: string }[]>`
    insert into critiques (artifact_id, previous_id, agent_run_id, schema_id, body, checked, passed)
    values (${artifactId}, ${previousId}, ${runId}, 'x3lius.critique/v1', '{"fixture": true}', ${counts.checked}, ${counts.passed})
    returning id`)[0]!.id);
};

describe('critiques: insert-only, chained to the parent version', () => {
  it('a revised version names the critique of its parent; any other critique is refused', async () => {
    const v1 = await artifact();
    const c1 = await critique(v1);
    const v2 = await artifact(v1, c1);
    expect(v2).toMatch(/^[0-9a-f-]{36}$/);
    const other = await critique(await artifact());
    await expect(artifact(v2, c1)).rejects.toThrow(/critique .* reviewed .*, not this version's parent/);
    await expect(artifact(v1, other)).rejects.toThrow(/not this version's parent/);
    await expect(artifact(null, c1)).rejects.toThrow(/creative_artifacts_critique_check/);
  });

  it('previous_id must be the critique of the parent version', async () => {
    const v1 = await artifact();
    const c1 = await critique(v1);
    const v2 = await artifact(v1, c1);
    await expect(critique(v2, c1)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    const unrelated = await critique(await artifact());
    await expect(critique(v2, unrelated)).rejects.toThrow(/previous critique .* not the parent of/);
  });

  it('is immutable for every role, the owner included', async () => {
    const c = await critique(await artifact());
    await expect(db.sql`update critiques set checked = 3 where id = ${c}`).rejects.toThrow(/is immutable/);
    await expect(db.sql`delete from critiques where id = ${c}`).rejects.toThrow(/is immutable/);
  });

  it('refuses counts that cannot be true', async () => {
    const a = await artifact();
    await expect(critique(a, null, { checked: 1, passed: 2 })).rejects.toThrow(/critiques_counts_check/);
    await expect(critique(a, null, { checked: -1, passed: 0 })).rejects.toThrow(/critiques_counts_check/);
  });

  it('grants: xyp_critic inserts, xyp_runtime reads, nobody else writes', async () => {
    const a = await artifact();
    const c = await critique(a);
    await expect(as('xyp_runtime', (tx) => tx`select id from critiques where id = ${c}`)).resolves.toHaveLength(1);
    const runId = await runRow('x3lius-evaluation', 'Critic');
    for (const role of ['xyp_runtime', 'xyp_creative', 'anon', 'authenticated']) {
      await expect(as(role, (tx) => tx`insert into critiques (artifact_id, agent_run_id, schema_id, body, checked, passed)
        values (${a}, ${runId}, 'x3lius.critique/v1', '{}', 0, 0)`)).rejects.toThrow(/permission denied/);
    }
    await expect(as('anon', (tx) => tx`select id from critiques`)).rejects.toThrow(/permission denied/);
  });
});

describe("xyp_escalate_critique: the loop's one way into the human queue", () => {
  const escalate = (role: string, critiqueId: string, request: unknown) =>
    as(role, async (tx) => (await tx<{ id: string }[]>`select public.xyp_escalate_critique(${critiqueId}, ${tx.json(request as postgres.JSONValue)}) as id`)[0]!.id);

  it('queues one pending critique_escalation per critique', async () => {
    const c = await critique(await artifact());
    const id = await escalate('xyp_evaluation_loop', c, { reason: 'stall', revisions: 1 });
    const [row] = await db.sql<{ item_type: string; item_id: string; status: string; request: { reason: string } }[]>`
      select item_type::text, item_id, status::text, request from approval_queue where id = ${id}`;
    expect(row).toMatchObject({ item_type: 'critique_escalation', item_id: c, status: 'pending', request: { reason: 'stall' } });
    await expect(escalate('xyp_evaluation_loop', c, { reason: 'stall' })).rejects.toThrow(/approval_queue_item_key/);
  });

  it('refuses an unknown critique or a request with no reason', async () => {
    const c = await critique(await artifact());
    await expect(escalate('xyp_evaluation_loop', '00000000-0000-4000-8000-000000000000', { reason: 'stall' })).rejects.toThrow(/no critique/);
    await expect(escalate('xyp_evaluation_loop', c, { revisions: 1 })).rejects.toThrow(/needs a request object with a reason/);
  });

  it('only xyp_evaluation_loop may call it', async () => {
    const c = await critique(await artifact());
    for (const role of ['xyp_runtime', 'xyp_critic', 'xyp_creative', 'service_role', 'anon', 'authenticated']) {
      await expect(escalate(role, c, { reason: 'stall' })).rejects.toThrow(/permission denied for function xyp_escalate_critique/);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/phase-12/critiques-db.test.ts`
Expected: FAIL, e.g. `relation "critiques" does not exist` / `column "critique_id" … does not exist`.

- [ ] **Step 3: Write the migration**

`supabase/migrations/20260925100000_critiques.sql`:

```sql
-- Phase 12 — critiques: the Critic class's only output (capability critique.write), and the link
-- from a revised creative artifact version to the critique it answers.
-- - critiques: insert-only and immutable for every role (trigger). previous_id chains a loop: it must
--   be the critique of the reviewed artifact's parent version. Written as xyp_critic (write_critique);
--   xyp_runtime reads (read_critique, capability critique.read).
-- - creative_artifacts.critique_id: set by Revision on the version it writes; the critique must be
--   about that version's parent.
-- - xyp_escalate_critique: the loop controller's one way into the human approval_queue
--   (item_type critique_escalation, ARCHITECTURE F8). EXECUTE is xyp_evaluation_loop's alone.
-- Idempotent. Rollback: supabase/rollbacks/20260925100000_critiques.down.sql

create table if not exists public.critiques (
  id           uuid primary key default gen_random_uuid(),
  artifact_id  uuid not null references public.creative_artifacts (id) on delete restrict,
  previous_id  uuid references public.critiques (id) on delete restrict,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  schema_id    text not null,
  body         jsonb not null,
  checked      integer not null,
  passed       integer not null,
  created_at   timestamptz not null default now(),
  constraint critiques_schema_id_check check (schema_id ~ '^[a-z0-9]+([.-][a-z0-9]+)*/v[0-9]+$'),
  constraint critiques_body_check check (jsonb_typeof(body) = 'object'),
  constraint critiques_counts_check check (checked >= 0 and passed >= 0 and passed <= checked)
);

create index if not exists critiques_artifact_id_idx on public.critiques (artifact_id);
create index if not exists critiques_previous_id_idx on public.critiques (previous_id);
create index if not exists critiques_agent_run_id_idx on public.critiques (agent_run_id);

-- SECURITY DEFINER: the check reads creative_artifacts, which xyp_critic has no grant on.
create or replace function public.xyp_critiques_chain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev_artifact uuid;
  v_parent uuid;
begin
  if new.previous_id is null then
    return new;
  end if;
  select artifact_id into v_prev_artifact from public.critiques where id = new.previous_id;
  if not found then
    return new; -- the previous_id FK reports it
  end if;
  select parent_id into v_parent from public.creative_artifacts where id = new.artifact_id;
  if v_parent is distinct from v_prev_artifact then
    raise exception 'critiques: previous critique % reviewed %, not the parent of %', new.previous_id, v_prev_artifact, new.artifact_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_critiques_chain before insert on public.critiques
  for each row execute function public.xyp_critiques_chain();

create or replace function public.xyp_critiques_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'critiques % is immutable: the Critic writes a new critique instead', old.id
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

create or replace trigger trg_critiques_immutable before update or delete on public.critiques
  for each row execute function public.xyp_critiques_immutable();

alter table public.creative_artifacts add column if not exists critique_id uuid references public.critiques (id) on delete restrict;

do $$ begin
  if not exists (select from pg_constraint where conname = 'creative_artifacts_critique_check') then
    alter table public.creative_artifacts
      add constraint creative_artifacts_critique_check check (critique_id is null or parent_id is not null);
  end if;
end $$;

create index if not exists creative_artifacts_critique_id_idx on public.creative_artifacts (critique_id);

-- SECURITY DEFINER: runs as xyp_creative's insert, which has no grant on critiques.
create or replace function public.xyp_creative_artifacts_critique()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target uuid;
begin
  -- A critique on a v1 is reported by creative_artifacts_critique_check, not here.
  if new.critique_id is null or new.parent_id is null then
    return new;
  end if;
  select artifact_id into v_target from public.critiques where id = new.critique_id;
  if not found then
    return new; -- the critique_id FK reports it
  end if;
  if v_target is distinct from new.parent_id then
    raise exception 'creative_artifacts: critique % reviewed %, not this version''s parent %', new.critique_id, v_target, new.parent_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace trigger trg_creative_artifacts_critique before insert on public.creative_artifacts
  for each row execute function public.xyp_creative_artifacts_critique();

create or replace function public.xyp_escalate_critique(p_critique_id uuid, p_request jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not exists (select from public.critiques where id = p_critique_id) then
    raise exception 'no critique %', p_critique_id using errcode = 'foreign_key_violation';
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' or coalesce(p_request ->> 'reason', '') = '' then
    raise exception 'an escalation needs a request object with a reason' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.approval_queue (item_type, item_id, request)
  values ('critique_escalation', p_critique_id, p_request)
  returning id into v_id;
  return v_id;
end;
$$;

do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_critic') then
    create role xyp_critic nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'xyp_evaluation_loop') then
    create role xyp_evaluation_loop nologin noinherit;
  end if;
end $$;

grant usage on schema public to xyp_critic, xyp_evaluation_loop;

alter table public.critiques enable row level security;
revoke all on table public.critiques from anon, authenticated;
grant select on table public.critiques to service_role, xyp_runtime;
grant select, insert on table public.critiques to xyp_critic;

do $$
begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'critiques' and policyname = 'critic_select') then
    create policy critic_select on public.critiques for select to xyp_critic using (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'critiques' and policyname = 'critic_insert') then
    create policy critic_insert on public.critiques for insert to xyp_critic with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'critiques' and policyname = 'runtime_select') then
    create policy runtime_select on public.critiques for select to xyp_runtime using (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'critiques' and policyname = 'service_select') then
    create policy service_select on public.critiques for select to service_role using (true);
  end if;
end $$;

revoke execute on function
  public.xyp_critiques_chain(),
  public.xyp_critiques_immutable(),
  public.xyp_creative_artifacts_critique()
  from public, anon, authenticated;
revoke execute on function public.xyp_escalate_critique(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.xyp_escalate_critique(uuid, jsonb) to xyp_evaluation_loop;
```

`supabase/rollbacks/20260925100000_critiques.down.sql`:

```sql
-- Rollback for 20260925100000_critiques.sql. Idempotent. No CASCADE.
-- The xyp_critic and xyp_evaluation_loop roles stay (cluster-wide, like xyp_creative); their
-- privileges go with the objects dropped here.

do $$ begin
  if to_regclass('public.creative_artifacts') is not null then
    drop trigger if exists trg_creative_artifacts_critique on public.creative_artifacts;
  end if;
end $$;

alter table if exists public.creative_artifacts drop column if exists critique_id;
drop function if exists public.xyp_creative_artifacts_critique();
drop function if exists public.xyp_escalate_critique(uuid, jsonb);
drop table if exists public.critiques;
drop function if exists public.xyp_critiques_chain();
drop function if exists public.xyp_critiques_immutable();

do $$ begin
  if exists (select from pg_roles where rolname = 'xyp_critic') then
    revoke usage on schema public from xyp_critic;
  end if;
  if exists (select from pg_roles where rolname = 'xyp_evaluation_loop') then
    revoke usage on schema public from xyp_evaluation_loop;
  end if;
end $$;
```

- [ ] **Step 4: Run the tests to verify they pass, including the Phase 1 round trip**

Run: `npx vitest run tests/phase-12/critiques-db.test.ts tests/phase-01`
Expected: PASS, including `migrations are idempotent and reversible`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260925100000_critiques.sql supabase/rollbacks/20260925100000_critiques.down.sql tests/phase-12/critiques-db.test.ts
git commit -m "Phase 12: critiques table, critique_id on artifact versions, escalation function

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: critique.read capability, critique tools, richer read_artifact

**Files:**
- Create: `records/x3lius/evaluation/schemas.ts`
- Create: `records/x3lius/evaluation/tools.ts`
- Modify: `core/tool-registry/capabilities.ts` (add `critique.read`)
- Modify: `docs/AGENT_CLASSES.md` (matrix row and the Critic/Revision input lines)
- Modify: `core/tool-registry/tools/read-artifact.ts`, `core/tool-registry/tools/write-artifact.ts`
- Modify: `core/runtime/tools.ts` (register the two tools)
- Test: `tests/phase-12/critiques-db.test.ts` (append a describe block)

**Interfaces:**
- Consumes: Task 1 schema.
- Produces:
  - `schemas.ts`: `CRITIQUE_SCHEMA_ID`, `CRITIQUE_LLM_SCHEMA_ID`, `REVISION_LLM_SCHEMA_ID`, `CRITIQUE_SCHEMA`, `CRITIQUE_LLM_SCHEMA`, `REVISION_LLM_SCHEMA`; types `RuleMethod`, `CheckedRule`, `Violation`, `Unverified`, `CritiqueCounts`, `CritiqueBody`; functions `violationKey(ruleRef, path): string` and `critiqueBodyErrors(b: CritiqueBody): string[]`.
  - `tools.ts`: `CRITIC_ROLE = 'xyp_critic'`, `createWriteCritiqueTool({ sql })`, `createReadCritiqueTool({ sql })`, type `CritiqueRow`.
    - `write_critique` takes args `{ artifactId, previousId?, body }` and returns `{ critique_id }`.
    - `read_critique` takes `{ id }` and returns a `CritiqueRow`.
  - `read-artifact.ts`: type `ArtifactRecord` (adds `parentId`, `critiqueId`, `brief`, `contextRefs`, `knowledge` to the existing fields).
  - `write_artifact` gains an optional arg `critiqueId`.

- [ ] **Step 1: Append failing tool tests**

Add to `tests/phase-12/critiques-db.test.ts`. The import goes at the top of the file; the describe block goes at the end.

```ts
import { createRuntimeTools } from '../../core/runtime/tools.ts';
```

```ts
describe('tools: write_critique, read_critique, read_artifact', () => {
  const REF = 'canonical_prompts:11111111-1111-4111-8111-111111111111';
  const ctx = (runId: string, agentName = 'x3lius-evaluation') => ({ runId, agentName, log: () => {} });
  const body = (artifactId: string, extra: Record<string, unknown> = {}) => ({
    artifact: { id: artifactId, schemaId: 'x3lius.lyrics/v2', version: 1, agent: 'x3lius-lyrics' },
    rules: [{ ref: REF, kind: 'rule', method: 'model' }],
    violations: [{ key: `${REF}@/sections/0/bars/0/text`, ruleRef: REF, method: 'model', path: '/sections/0/bars/0/text', quote: 'x', expected: 'y', found: 'z' }],
    resolved: [], unverified: [], counts: { checked: 1, passed: 0, violations: 1 }, ...extra,
  });
  const tools = () => createRuntimeTools({ sql: db.sql });

  it('write_critique stores a valid critique as xyp_critic and read_critique returns it', async () => {
    const a = await artifact();
    const runId = await runRow('x3lius-evaluation', 'Critic');
    const { critique_id } = (await tools().get('write_critique')!.handler(ctx(runId), { artifactId: a, body: body(a) })) as { critique_id: string };
    expect(await tools().get('read_critique')!.handler(ctx(runId), { id: critique_id })).toMatchObject({
      id: critique_id, artifactId: a, previousId: null, checked: 1, passed: 0, body: body(a),
    });
  });

  it('write_critique refuses a body whose counts, keys or artifact disagree, and writes nothing', async () => {
    const a = await artifact();
    const other = await artifact();
    const runId = await runRow('x3lius-evaluation', 'Critic');
    const write = (args: unknown) => tools().get('write_critique')!.handler(ctx(runId), args);
    await expect(write({ artifactId: a, body: body(a, { counts: { checked: 1, passed: 1, violations: 1 } }) })).rejects.toThrow(/counts.passed/);
    await expect(write({ artifactId: a, body: { ...body(a), violations: [{ ...body(a).violations[0]!, key: 'wrong' }] } })).rejects.toThrow(/key/);
    await expect(write({ artifactId: other, body: body(a) })).rejects.toThrow(/body.artifact.id/);
    await expect(write({ artifactId: a, body: body(a, { previousCritiqueId: '22222222-2222-4222-8222-222222222222' }) })).rejects.toThrow(/previousCritiqueId/);
    await expect(write({ artifactId: a, body: { prose: 'looks fine' } })).rejects.toThrow(/write_critique rejected/);
    expect(await db.sql`select id from critiques where artifact_id = ${a}`).toHaveLength(0);
  });

  it('read_artifact returns the brief, parent and critique a revision needs', async () => {
    const v1 = await artifact();
    const c1 = await critique(v1);
    const v2 = await artifact(v1, c1);
    const runId = await runRow('x3lius-revision', 'Revision');
    expect(await tools().get('read_artifact')!.handler(ctx(runId, 'x3lius-revision'), { id: v2 })).toMatchObject({
      id: v2, version: 2, parentId: v1, critiqueId: c1, brief: '[FIXTURE] brief', contextRefs: [], knowledge: {}, body: { fixture: true },
    });
  });

  it('authorization: Critic writes critiques; Critic, Revision and Governance read them', () => {
    const t = tools();
    expect(t.authorize('Critic', 'write_critique')).toEqual({ allow: true, capability: 'critique.write' });
    expect(t.authorize('Revision', 'write_critique')).toMatchObject({ allow: false });
    for (const c of ['Critic', 'Revision', 'Governance'] as const) expect(t.authorize(c, 'read_critique')).toEqual({ allow: true, capability: 'critique.read' });
    for (const c of ['Creative', 'Knowledge', 'Execution'] as const) expect(t.authorize(c, 'read_critique')).toMatchObject({ allow: false });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/phase-12/critiques-db.test.ts`
Expected: FAIL, because `write_critique` isn't registered (`Cannot read properties of undefined (reading 'handler')`).

- [ ] **Step 3: Add the capability (code and doc together)**

In `core/tool-registry/capabilities.ts`, add `'critique.read'` to `CAPABILITIES` right after `'critique.write'`, and add this to `CLASS_CAPABILITIES` after `'critique.write': ['Critic'],`:

```ts
  // Phase 12: read a critique by id (Revision reads the one it answers; the Critic reads the previous
  // one to mark what is resolved; Governance audits).
  'critique.read': ['Critic', 'Revision', 'Governance'],
```

In `docs/AGENT_CLASSES.md`, add after the `critique.write` row:

```
| `critique.read` | Read a critique by id (Phase 12) | — | — | — | — | Y | Y | — | Y |
```

and replace two lines of the class descriptions:
- Critic **Allowed inputs**: `A creative artifact version, the canonical rules that govern it, and the critique of its parent version when it continues a loop (Phase 12).`
- Revision **Allowed inputs**: `A critique object (read with critique.read) plus the artifact version it targets.`

- [ ] **Step 4: Write `records/x3lius/evaluation/schemas.ts`**

```ts
import { arr, int, obj, str, type JsonSchema } from '../../../core/llm/json-schema.ts';

/**
 * Phase 12 schemas: the stored critique (x3lius.critique/v1) and what the Critic and Revision
 * models may reply. The JSON-schema subset has no null, so optional fields are omitted, never null.
 */
export const CRITIQUE_SCHEMA_ID = 'x3lius.critique/v1';
export const CRITIQUE_LLM_SCHEMA_ID = 'x3lius.critique-llm/v1';
export const REVISION_LLM_SCHEMA_ID = 'x3lius.revision-llm/v1';

export type RuleMethod = 'code' | 'model';
/** A rule the Critic checked. `version` only where the source states one (mix-report checks). */
export type CheckedRule = { readonly ref: string; readonly kind: 'rule' | 'claim'; readonly method: RuleMethod; readonly version?: number };
export type Violation = {
  readonly key: string;
  readonly ruleRef: string;
  readonly method: RuleMethod;
  /** JSON Pointer into the artifact body. */
  readonly path: string;
  readonly quote: string;
  readonly expected: string;
  readonly found: string;
  readonly ruleVersion?: number;
};
export type Unverified = { readonly ruleRef: string; readonly path: string; readonly quote: string; readonly reason: string };
export type CritiqueCounts = { readonly checked: number; readonly passed: number; readonly violations: number };
export type CritiqueBody = {
  readonly artifact: { readonly id: string; readonly schemaId: string; readonly version: number; readonly agent: string };
  readonly previousCritiqueId?: string;
  readonly rules: readonly CheckedRule[];
  readonly violations: readonly Violation[];
  /** Keys of the previous critique's violations that are gone. Only the Critic marks anything resolved. */
  readonly resolved: readonly string[];
  readonly unverified: readonly Unverified[];
  readonly counts: CritiqueCounts;
};

/**
 * @param ruleRef - the rule broken
 * @param path - JSON Pointer of the field
 * @returns `ruleRef@path`: the same violation keeps its key across the versions of a loop
 */
export const violationKey = (ruleRef: string, path: string): string => `${ruleRef}@${path}`;

/** An object schema whose `optional` keys may be left out. */
const objWith = (properties: Record<string, JsonSchema>, optional: readonly string[]): JsonSchema => ({
  type: 'object', properties, required: Object.keys(properties).filter((k) => !optional.includes(k)), additionalProperties: false,
});
const METHOD: JsonSchema = { type: 'string', enum: ['code', 'model'] };

export const CRITIQUE_SCHEMA: JsonSchema = objWith({
  artifact: obj({ id: str(), schemaId: str(), version: int('Artifact version'), agent: str('Agent that wrote the version') }),
  previousCritiqueId: str('The critique of the parent version; omitted on a first pass'),
  rules: arr(objWith({
    ref: str(), kind: { type: 'string', enum: ['rule', 'claim'] }, method: METHOD, version: int('Canonical row version, where the source states it'),
  }, ['version'])),
  violations: arr(objWith({
    key: str(), ruleRef: str(), method: METHOD, path: str('JSON Pointer into the artifact body'), quote: str(), expected: str(), found: str(),
    ruleVersion: int('Canonical row version, where the source states it'),
  }, ['ruleVersion'])),
  resolved: arr(str('Key of a previous-critique violation that is gone')),
  unverified: arr(obj({ ruleRef: str(), path: str(), quote: str(), reason: str() })),
  counts: obj({ checked: int('Rules checked'), passed: int('Rules with no violation'), violations: int('Violations') }),
}, ['previousCritiqueId']);

export const CRITIQUE_LLM_SCHEMA: JsonSchema = obj({
  violations: arr(obj({
    ruleRef: str('The rule broken: its ref copied exactly from RULES'),
    path: str('JSON Pointer to the field that breaks it, e.g. /sections/1/bars/0/text'),
    quote: str('The offending words, copied exactly from that field'),
    expected: str('What the rule requires there'),
    found: str('What the artifact has instead'),
  }), 'Every rule the artifact breaks; empty when it breaks none'),
});

export const REVISION_LLM_SCHEMA: JsonSchema = obj({
  edits: arr(obj({
    path: str('JSON Pointer to the field to change: one a violation points at, or inside it'),
    replacement: str('The new value. For a number or true/false field, write it as JSON, e.g. 120 or true'),
    violationKeys: arr(str('Key of a violation this edit fixes, copied exactly from VIOLATIONS')),
  }), 'Concrete edits that fix the violations'),
});

/**
 * The checks the schema subset can't state: counts agree with the lists, keys follow their rule
 * and path, and every violation cites a rule that was checked.
 * @param b - a critique body that already satisfies CRITIQUE_SCHEMA
 * @returns violations, empty when consistent
 */
export const critiqueBodyErrors = (b: CritiqueBody): string[] => {
  const refs = new Set(b.rules.map((r) => r.ref));
  const passed = b.rules.filter((r) => !b.violations.some((v) => v.ruleRef === r.ref)).length;
  return [
    ...(b.counts.checked === b.rules.length ? [] : [`counts.checked ${b.counts.checked} is not the ${b.rules.length} rules listed`]),
    ...(b.counts.violations === b.violations.length ? [] : [`counts.violations ${b.counts.violations} is not the ${b.violations.length} violations listed`]),
    ...(b.counts.passed === passed ? [] : [`counts.passed ${b.counts.passed} is not the ${passed} rules without a violation`]),
    ...b.violations.filter((v) => v.key !== violationKey(v.ruleRef, v.path)).map((v) => `violation key ${v.key} is not ${violationKey(v.ruleRef, v.path)}`),
    ...b.violations.filter((v) => !refs.has(v.ruleRef)).map((v) => `violation cites ${v.ruleRef}, which is not a rule checked`),
  ];
};
```

- [ ] **Step 5: Write `records/x3lius/evaluation/tools.ts`**

```ts
import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../../core/db/client.ts';
import { validateJson } from '../../../core/llm/json-schema.ts';
import { defineTool, type Tool } from '../../../core/tool-registry/registry.ts';
import { CRITIQUE_SCHEMA, CRITIQUE_SCHEMA_ID, critiqueBodyErrors, type CritiqueBody } from './schemas.ts';

/** The DB role critique writes run as (migration 20260925100000): INSERT/SELECT on critiques only. */
export const CRITIC_ROLE = 'xyp_critic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What read_critique returns. */
export type CritiqueRow = {
  readonly id: string; readonly artifactId: string; readonly previousId: string | null;
  readonly body: CritiqueBody; readonly checked: number; readonly passed: number; readonly createdAt: string;
};

/**
 * write_critique (capability critique.write, Critic only): appends one x3lius.critique/v1. The body
 * must satisfy the schema and agree with itself (counts, keys), and name the artifact and previous
 * critique it is written for — a prose verdict can never land here. The run comes from the context.
 * @param deps - pool the write runs through (as xyp_critic)
 * @returns the tool definition
 */
export const createWriteCritiqueTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'write_critique',
    capability: 'critique.write',
    description: 'Append one structured critique of a creative artifact version (insert-only; x3lius.critique/v1).',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { artifactId?: unknown; previousId?: unknown; body?: unknown };
      const shape = validateJson(CRITIQUE_SCHEMA, a.body, '$.body');
      const body = a.body as CritiqueBody;
      const errors = [
        ...(typeof a.artifactId === 'string' && UUID.test(a.artifactId) ? [] : ['artifactId must be an artifact uuid']),
        ...(a.previousId === undefined || (typeof a.previousId === 'string' && UUID.test(a.previousId)) ? [] : ['previousId must be a critique uuid when given']),
        ...shape,
        ...(shape.length > 0 ? [] : critiqueBodyErrors(body)),
        ...(shape.length > 0 || body.artifact.id === a.artifactId ? [] : [`body.artifact.id ${body.artifact.id} is not artifactId ${String(a.artifactId)}`]),
        ...(shape.length > 0 || body.previousCritiqueId === a.previousId ? [] : ['body.previousCritiqueId must equal previousId (both absent on a first pass)']),
      ];
      if (errors.length > 0) throw new Error(`write_critique rejected: ${errors.join('; ')}`);
      const row = await deps.sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${quoteIdent(CRITIC_ROLE)}`);
        const [r] = await tx<{ id: string }[]>`
          insert into critiques (artifact_id, previous_id, agent_run_id, schema_id, body, checked, passed)
          values (${a.artifactId as string}, ${(a.previousId as string | undefined) ?? null}, ${ctx.runId}, ${CRITIQUE_SCHEMA_ID},
                  ${tx.json(body as unknown as postgres.JSONValue)}, ${body.counts.checked}, ${body.counts.passed})
          returning id`;
        return r!;
      });
      ctx.log('info', `write_critique → ${row.id}: ${body.counts.violations} violation(s), ${body.counts.passed}/${body.counts.checked} rules passed`);
      return { critique_id: row.id };
    },
  });

/**
 * read_critique (capability critique.read, Phase 12): one critique by id, read-only as xyp_runtime.
 * How Revision reads the critique it answers and the Critic reads the previous one.
 * @param deps - pool the read runs through
 * @returns the tool definition
 */
export const createReadCritiqueTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'read_critique',
    capability: 'critique.read',
    description: 'One critique by id: the artifact version it reviewed, the previous critique, and its body.',
    handler: async (_ctx, args) => {
      const id = (args as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !UUID.test(id)) throw new Error('read_critique: id must be a critique uuid');
      type Row = { id: string; artifact_id: string; previous_id: string | null; body: CritiqueBody; checked: number; passed: number; created_at: string };
      const rows = (await deps.sql.begin('read only', async (tx) => {
        await tx.unsafe(`set local role ${quoteIdent('xyp_runtime')}`);
        return tx<Row[]>`select id, artifact_id, previous_id, body, checked, passed, created_at from critiques where id = ${id}`;
      })) as Row[];
      const r = rows[0];
      if (!r) throw new Error(`read_critique: no critique ${id}`);
      return { id: r.id, artifactId: r.artifact_id, previousId: r.previous_id, body: r.body, checked: r.checked, passed: r.passed, createdAt: r.created_at } satisfies CritiqueRow;
    },
  });
```

- [ ] **Step 6: Extend `read_artifact` and `write_artifact`**

`core/tool-registry/tools/read-artifact.ts`: replace the `Row` type and handler body with the following, keeping the JSDoc and adding one line to it: "Also returns the brief, parent, critique, context refs and knowledge: the Critic queries rules with the brief, and Revision copies them into the next version (Phase 12)."

```ts
type Row = {
  id: string; lineage_id: string; version: number; schema_id: string; agent_name: string; parent_id: string | null; critique_id: string | null;
  brief: string; body: Record<string, unknown>; context_refs: unknown[]; knowledge: Record<string, unknown>; created_at: string;
};

/** What read_artifact returns. */
export type ArtifactRecord = {
  readonly id: string; readonly lineageId: string; readonly version: number; readonly schemaId: string; readonly agentName: string;
  readonly parentId: string | null; readonly critiqueId: string | null; readonly brief: string; readonly body: Record<string, unknown>;
  readonly contextRefs: readonly unknown[]; readonly knowledge: Readonly<Record<string, unknown>>; readonly createdAt: string;
};
```

```ts
      const rows = (await deps.sql.begin('read only', async (tx) => {
        await tx.unsafe(`set local role ${quoteIdent('xyp_runtime')}`);
        return tx<Row[]>`
          select id, lineage_id, version, schema_id, agent_name, parent_id, critique_id, brief, body, context_refs, knowledge, created_at
          from creative_artifacts where id = ${id}`;
      })) as Row[];
      const row = rows[0];
      if (!row) throw new Error(`read_artifact: no artifact ${id}`);
      return {
        id: row.id, lineageId: row.lineage_id, version: row.version, schemaId: row.schema_id, agentName: row.agent_name,
        parentId: row.parent_id, critiqueId: row.critique_id, brief: row.brief, body: row.body,
        contextRefs: row.context_refs, knowledge: row.knowledge, createdAt: row.created_at,
      } satisfies ArtifactRecord;
```

`core/tool-registry/tools/write-artifact.ts`:
1. In `WriteArtifactArgs`, add after `parentId`:
   ```ts
     /** The critique this version answers (Revision, Phase 12); requires parentId. */
     readonly critiqueId?: string;
   ```
2. In `errors`, add:
   ```ts
        ...(a.critiqueId === undefined || (typeof a.critiqueId === 'string' && typeof a.parentId === 'string') ? [] : ['critiqueId needs a parentId: a critique answers an earlier version']),
   ```
3. In the insert, add the `critique_id` column and value:
   ```ts
          insert into creative_artifacts (schema_id, agent_name, agent_run_id, parent_id, critique_id, brief, body, context_refs, knowledge, model, warnings)
          values (${a.schemaId!}, ${ctx.agentName}, ${ctx.runId}, ${a.parentId ?? null}, ${a.critiqueId ?? null}, ${a.brief!},
   ```
   (the rest of the values line is unchanged).

- [ ] **Step 7: Register the tools**

In `core/runtime/tools.ts`:
- add `import { createReadCritiqueTool, createWriteCritiqueTool } from '../../records/x3lius/evaluation/tools.ts';`
- append `createWriteCritiqueTool(deps), createReadCritiqueTool(deps),` to the `createToolRegistry([...])` list, after `createReadArtifactTool(deps),`;
- add `write_critique, read_critique` to the `@returns` line of the JSDoc.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/phase-12/critiques-db.test.ts tests/phase-04c core/tool-registry`
Expected: PASS. `matrix-matches-docs` confirms the doc and code matrices agree.

- [ ] **Step 9: Commit**

```bash
git add records/x3lius/evaluation/schemas.ts records/x3lius/evaluation/tools.ts core/tool-registry docs/AGENT_CLASSES.md core/runtime/tools.ts tests/phase-12/critiques-db.test.ts
git commit -m "Phase 12: critique.read capability, write_critique / read_critique tools, read_artifact returns brief and lineage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: JSON Pointer, and shared creative helpers exported

**Files:**
- Create: `records/x3lius/evaluation/pointer.ts`, `records/x3lius/evaluation/pointer.test.ts`
- Modify: `records/x3lius/creative/program.ts` (export `specForSchema`, `pullEntries`, `resolveRef`, `promptLine`, `scriptFindings`; the program uses them)
- Modify: `records/x3lius/suno/formula.ts` (export `LIMIT_TOPIC`, `appliesTo`, `measureSunoText`; finalize uses the latter)

**Interfaces:**
- Produces:
  - `getAt(doc, pointer): { found: true; value: unknown } | { found: false }`
  - `setAt<T>(doc: T, pointer, value): T` (returns a copy; throws when the field doesn't exist)
  - `isAtOrUnder(pointer, parent): boolean`
  - `stringsIn(value): string[]`
  - `specForSchema(schemaId): { slug: string; spec: CreativeSpec } | undefined`
  - `pullEntries(ctx: AgentContext, slug: string, brief: string): Promise<{ modules: readonly string[]; pulled: { entry: ContextEntry; module: string | null }[] }>`
  - `resolveRef(cited, entries): string`
  - `promptLine(e: ContextEntry): string`
  - `scriptFindings(spec, body): { refuse: string[]; warnings: { kind: 'mixed-script'; word: string; path: string }[]; softMessages: string[] }`
  - `LIMIT_TOPIC: RegExp`
  - `appliesTo(tag: string | null, sunoModel: string): boolean`
  - `measureSunoText(body: Record<string, unknown>): Record<string, number>`

- [ ] **Step 1: Write the failing pointer test**

`records/x3lius/evaluation/pointer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getAt, isAtOrUnder, setAt, stringsIn } from './pointer.ts';

const doc = { title: 'a', sections: [{ bars: [{ text: 'one' }, { text: 'two' }] }], 'a/b': { '~k': 1 } };

describe('JSON Pointer (RFC 6901) over artifact bodies', () => {
  it('reads fields, array items and escaped keys', () => {
    expect(getAt(doc, '/sections/0/bars/1/text')).toEqual({ found: true, value: 'two' });
    expect(getAt(doc, '/a~1b/~0k')).toEqual({ found: true, value: 1 });
  });

  it('reports a missing step, a bad index, the root and a JSONPath as not found', () => {
    for (const p of ['/nope', '/sections/2', '/sections/01', '/sections/-1', '', '$.title', 'title', '/title/length']) {
      expect(getAt(doc, p), p).toEqual({ found: false });
    }
  });

  it('sets an existing field on a copy, never in place, and never creates one', () => {
    const next = setAt(doc, '/sections/0/bars/0/text', 'uno');
    expect(getAt(next, '/sections/0/bars/0/text')).toEqual({ found: true, value: 'uno' });
    expect(doc.sections[0]!.bars[0]!.text).toBe('one');
    expect(getAt(setAt(doc, '/a~1b/~0k', 2), '/a~1b/~0k')).toEqual({ found: true, value: 2 });
    expect(() => setAt(doc, '/sections/0/bars/9/text', 'x')).toThrow(/no field at \/sections\/0\/bars\/9\/text/);
  });

  it('knows what is inside what', () => {
    expect(isAtOrUnder('/sections/0/bars/0/text', '/sections/0')).toBe(true);
    expect(isAtOrUnder('/sections/0', '/sections/0')).toBe(true);
    expect(isAtOrUnder('/sections/01', '/sections/0')).toBe(false);
  });

  it('collects every string under a value', () => {
    expect(stringsIn(doc.sections)).toEqual(['one', 'two']);
    expect(stringsIn(3)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run records/x3lius/evaluation/pointer.test.ts`
Expected: FAIL, because `./pointer.ts` does not exist.

- [ ] **Step 3: Write `records/x3lius/evaluation/pointer.ts`**

```ts
/**
 * JSON Pointer (RFC 6901) over artifact bodies: how a critique names a field and a revision edits
 * one. "/a/0/b"; inside a segment "~1" is "/" and "~0" is "~". The root "" is never a field, and a
 * JSONPath ("$.a") is not a pointer.
 */

const segments = (pointer: string): string[] | null =>
  pointer.startsWith('/') ? pointer.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')) : null;

const INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * @param doc - parsed JSON
 * @param pointer - JSON Pointer
 * @returns the value there, or `{ found: false }` for a malformed pointer, the root or any missing step
 */
export const getAt = (doc: unknown, pointer: string): { readonly found: true; readonly value: unknown } | { readonly found: false } => {
  const segs = segments(pointer);
  if (!segs) return { found: false };
  let cur: unknown = doc;
  for (const s of segs) {
    if (Array.isArray(cur)) {
      if (!INDEX.test(s) || Number(s) >= cur.length) return { found: false };
      cur = cur[Number(s)];
    } else if (cur !== null && typeof cur === 'object' && Object.hasOwn(cur, s)) {
      cur = (cur as Record<string, unknown>)[s];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
};

/**
 * @param doc - parsed JSON
 * @param pointer - JSON Pointer of an existing field
 * @param value - its new value
 * @returns a deep copy of `doc` with that field replaced
 * @throws Error when the field doesn't exist (a revision never adds fields)
 */
export const setAt = <T>(doc: T, pointer: string, value: unknown): T => {
  if (!getAt(doc, pointer).found) throw new Error(`no field at ${pointer}`);
  const copy = structuredClone(doc);
  const segs = segments(pointer)!;
  let cur = copy as unknown as Record<string, unknown>;
  for (const s of segs.slice(0, -1)) cur = cur[s] as Record<string, unknown>;
  cur[segs.at(-1)!] = value;
  return copy;
};

/** @returns true when `pointer` is `parent` or a field inside it */
export const isAtOrUnder = (pointer: string, parent: string): boolean => pointer === parent || pointer.startsWith(`${parent}/`);

/** @returns every string at or under a value, depth first */
export const stringsIn = (value: unknown): string[] =>
  typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.flatMap(stringsIn)
      : value !== null && typeof value === 'object' ? Object.values(value).flatMap(stringsIn)
        : [];
```

- [ ] **Step 4: Export the shared creative helpers (refactor with no behaviour change)**

In `records/x3lius/creative/program.ts`:

1. Add `import type { AgentContext } from '../../../core/orchestrator/dispatch.ts';` and `type MixedScriptWord` stays imported.
2. Change `const resolveRef` and `const promptLine` to `export const` (bodies unchanged).
3. Add after `CREATIVE_SUBDOMAINS`:

```ts
/**
 * The spec that writes a schema id. The Critic and Revision find a version's rules and checks this
 * way, not by `agent_name`: a revised version is written by x3lius-revision.
 * @param schemaId - artifact schema id
 * @returns the sub-domain slug and its spec, or undefined when no current spec writes it
 */
export const specForSchema = (schemaId: string): { readonly slug: string; readonly spec: CreativeSpec } | undefined => {
  const hit = Object.entries(SPECS).find(([, s]) => s.schemaId === schemaId);
  return hit ? { slug: hit[0], spec: hit[1] } : undefined;
};

/**
 * Pulls a sub-domain's canonical rules (one scoped Context Engine read per module) and its claims
 * (exact topic lookup per namespace), before any applicability filter.
 * @param ctx - run context whose agent holds retrieve_context and retrieve_claims
 * @param slug - sub-domain slug (a key of SPECS)
 * @param brief - the retrieval query
 * @returns the modules read and every entry pulled, with the module it came from (null for claims)
 */
export const pullEntries = async (ctx: AgentContext, slug: string, brief: string) => {
  const spec = SPECS[slug]!;
  const modules = spec.modules ?? [slug, VOICE_MODULE];
  const namespaces = spec.claimNamespaces ?? [CLAIM_NAMESPACE];
  // One scoped read per module, so each count is exact and one module can't crowd out another.
  const pulled: { entry: ContextEntry; module: string | null }[] = [];
  for (const module of modules) {
    const bundle = (await ctx.useTool('retrieve_context', { query: brief, scope: { modules: [module] } })) as ContextBundle;
    for (const r of bundle.items.filter((i) => i.ref.table === 'canonical_prompts')) {
      pulled.push({ module, entry: { kind: 'rule', ref: `canonical_prompts:${r.ref.id}`, module, slug: r.slug, title: r.title, text: r.text, modelTag: r.modelTag, score: r.score, why: r.why, source: r.source } });
    }
  }
  const seen = new Set<string>();
  for (const prefix of namespaces) {
    const claims = (await ctx.useTool('retrieve_claims', { topicPrefix: prefix })) as ClaimBundle;
    for (const c of claims.items) {
      const ref = `canonical_prompts:${c.ref.id}#${c.topic}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      pulled.push({ module: null, entry: { kind: 'claim', ref, module: c.module, slug: c.slug, title: c.title, topic: c.topic, value: c.value, modelScope: c.modelScope, source: c.source } });
    }
  }
  return { modules, pulled };
};

/**
 * F22 on a final body: a mixed-script word in text Suno receives refuses the write; anywhere else
 * it is written as a warning.
 * @param spec - the spec whose `sunoTextPaths` apply
 * @param body - the final artifact body
 * @returns refusal messages, warnings to store, and the warnings as log messages
 */
export const scriptFindings = (spec: CreativeSpec, body: Record<string, unknown>) => {
  const explain = (w: MixedScriptWord) => `mixed-script word "${w.word}" at ${w.path} (Latin and Cyrillic letters in one word)`;
  const toSuno = (w: MixedScriptWord) => (spec.sunoTextPaths ?? []).some((p) => p.test(w.path));
  const mixed = mixedScriptWords(body);
  const soft = mixed.filter((w) => !toSuno(w));
  return {
    refuse: mixed.filter(toSuno).map(explain),
    warnings: soft.map((w) => ({ kind: 'mixed-script' as const, word: w.word, path: w.path })),
    softMessages: soft.map(explain),
  };
};
```

4. In `creativeProgram`, delete the `modules` and `namespaces` constants and the two retrieval loops (`// One scoped read per module…` through the end of the claims loop), and use:

```ts
    const { modules, pulled } = await pullEntries(ctx, slug, prepared.brief);
```

5. Replace the mixed-script block (`const explain = …` through `if (soft.length > 0) await ctx.useTool(…)`) with:

```ts
    const script = scriptFindings(spec, body);
    const all = [...violations, ...(spec.check?.(body) ?? []), ...script.refuse];
    if (all.length > 0) throw new Error(`${slug} reply failed checks: ${all.join('; ')}`);
    const warnings = script.warnings;
    if (warnings.length > 0) await ctx.useTool('log_message', { level: 'warn', message: `${slug}: written with warnings — ${script.softMessages.join('; ')}` });
```

In `records/x3lius/suno/formula.ts`:
1. `const LIMIT_TOPIC` → `export const LIMIT_TOPIC`; `const appliesTo` → `export const appliesTo`.
2. Add after `appliesTo`:

```ts
/**
 * The lengths Suno limits apply to, measured from a Suno-prompt body's own text. The Critic and
 * Revision measure the same way, never from the stored `limits`.
 * @param b - a body with title, style, excludeStyles and lyrics
 * @returns character counts by limit field
 */
export const measureSunoText = (b: Record<string, unknown>): Record<string, number> => ({
  title: String(b.title).length,
  style: String(b.style).length,
  'exclude-styles': (b.excludeStyles as string[]).join(', ').length,
  lyrics: String(b.lyrics).length,
});
```

3. In `finalize`, replace the `const measured: Record<string, number> = { … };` literal with:

```ts
  const measured = measureSunoText({ title: reply.title, style: reply.style, excludeStyles: reply.excludeStyles, lyrics: s.lyrics });
```

- [ ] **Step 5: Run the pointer test and every creative test (the refactor must not change behaviour)**

Run: `npx vitest run records/x3lius/evaluation/pointer.test.ts tests/phase-08 tests/phase-09 tests/phase-10 tests/phase-11 && npx tsc --noEmit -p .`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add records/x3lius/evaluation/pointer.ts records/x3lius/evaluation/pointer.test.ts records/x3lius/creative/program.ts records/x3lius/suno/formula.ts
git commit -m "Phase 12: JSON Pointer; creative retrieval, ref resolution, script check and Suno measurement exported for reuse

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Code checks and model-violation verification (pure)

**Files:**
- Create: `records/x3lius/evaluation/checks.ts`, `records/x3lius/evaluation/checks.test.ts`
- Create: `records/x3lius/evaluation/verify.ts`, `records/x3lius/evaluation/verify.test.ts`

**Interfaces:**
- Consumes: `violationKey`, `CheckedRule`, `Violation`, `Unverified` (Task 2); `getAt`, `stringsIn` (Task 3); `resolveRef` (Task 3); `LIMIT_TOPIC`, `measureSunoText` (Task 3); `MixCheck` from `records/x3lius/mix-master/agent.ts`.
- Produces:
  - `codeChecks(schemaId, entries, body): CodeCheckResult`
  - `mixReportChecks(body): CodeCheckResult`
  - type `CodeCheckResult = { rules: CheckedRule[]; violations: Violation[] }`
  - `verifyReported(reported, modelRules, codeRefs, body): { violations: Violation[]; unverified: Unverified[] }`
  - type `ReportedViolation = { ruleRef; path; quote; expected; found }`

- [ ] **Step 1: Write the failing tests**

`records/x3lius/evaluation/checks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LYRICS_SCHEMA_ID, SUNO_PROMPT_SCHEMA_ID } from '../creative/schemas.ts';
import type { ContextEntry } from '../creative/types.ts';
import { codeChecks, mixReportChecks } from './checks.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const claim = (topic: string, value: unknown): ContextEntry => ({
  kind: 'claim', ref: `canonical_prompts:${ID}#${topic}`, module: 'x3lius-suno', slug: 'fixture', title: '[FIXTURE]', topic, value, modelScope: 'suno-v5', source: null,
});
const rule: ContextEntry = { kind: 'rule', ref: `canonical_prompts:${ID}`, module: 'x3lius-suno', slug: 'fixture-rule', title: '[FIXTURE]', text: '[FIXTURE] rule', modelTag: null, score: 0.9, why: 'fixture', source: null };
const SUNO = {
  sunoModel: 'v5', title: 'Night', style: 'dark trap, male vocal', excludeStyles: ['pop'], lyrics: '[Verse]\nline',
  sources: [], limits: [{ field: 'style', max: 10, actual: 1, ref: 'stale' }], rulesApplied: [], ungroundedChoices: [],
};

describe('code checks', () => {
  it('checks a Suno length claim by code, measuring the text itself (never the stored limits)', () => {
    const r = codeChecks(SUNO_PROMPT_SCHEMA_ID, [claim('suno.limit.style-chars', 10), claim('suno.limit.title-chars', 80), rule], SUNO);
    expect(r.rules).toEqual([
      { ref: `canonical_prompts:${ID}#suno.limit.style-chars`, kind: 'claim', method: 'code' },
      { ref: `canonical_prompts:${ID}#suno.limit.title-chars`, kind: 'claim', method: 'code' },
    ]);
    expect(r.violations).toEqual([{
      key: `canonical_prompts:${ID}#suno.limit.style-chars@/style`, ruleRef: `canonical_prompts:${ID}#suno.limit.style-chars`, method: 'code',
      path: '/style', quote: 'dark trap, male vocal', expected: 'at most 10 characters (suno.limit.style-chars)', found: '21 characters',
    }]);
  });

  it('has no code check outside the Suno prompt, or for a limit that is not an integer', () => {
    expect(codeChecks(LYRICS_SCHEMA_ID, [claim('suno.limit.style-chars', 10)], {})).toEqual({ rules: [], violations: [] });
    expect(codeChecks(SUNO_PROMPT_SCHEMA_ID, [claim('suno.limit.style-chars', '10')], SUNO)).toEqual({ rules: [], violations: [] });
  });

  it('turns a mix report’s checks into rules, and each raise/lower into a violation', () => {
    const ref = `canonical_prompts:${ID}#x3lius.master.loudness.integrated-lufs`;
    const body = {
      checks: [
        { metric: 'loudness.integrated-lufs', unit: 'LUFS', measured: -12.3, rubric: { min: -10, max: -8 }, action: 'raise', by: 2.3, ref, version: 1 },
        { metric: 'loudness.range-lu', unit: 'LU', measured: 5.2, rubric: { min: 4 }, action: 'keep', by: 0, ref: `${ref}-2`, version: 1 },
      ],
    };
    const r = mixReportChecks(body);
    expect(r.rules).toEqual([{ ref, kind: 'claim', method: 'code', version: 1 }, { ref: `${ref}-2`, kind: 'claim', method: 'code', version: 1 }]);
    expect(r.violations).toEqual([{
      key: `${ref}@/checks/0`, ruleRef: ref, ruleVersion: 1, method: 'code', path: '/checks/0',
      quote: 'loudness.integrated-lufs -12.3 LUFS', expected: 'loudness.integrated-lufs ≥ -10 and ≤ -8 LUFS', found: '-12.3 LUFS: raise by 2.3',
    }]);
  });
});
```

`records/x3lius/evaluation/verify.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ContextEntry } from '../creative/types.ts';
import { verifyReported } from './verify.ts';

const rule = (id: string, slug: string): ContextEntry => ({
  kind: 'rule', ref: `canonical_prompts:${id}`, module: 'x3lius-lyrics', slug, title: '[FIXTURE]', text: '[FIXTURE] rule', modelTag: null, score: 0.9, why: 'fixture', source: null,
});
const A = rule('11111111-1111-4111-8111-111111111111', 'fixture-city-bars');
const CODE = 'canonical_prompts:22222222-2222-4222-8222-222222222222#suno.limit.style-chars';
const BODY = { sections: [{ bars: [{ text: 'Neon rain on Canal Street' }, { text: 'second bar' }] }] };
const report = (over: Record<string, string>) => ({ ruleRef: A.ref, path: '/sections/0/bars/0/text', quote: 'Canal Street', expected: 'e', found: 'f', ...over });

describe('verifying model-reported violations', () => {
  it('keeps a violation whose rule, path and quote check out, resolving a bracketed or aliased ref', () => {
    const r = verifyReported([report({ ruleRef: `[${A.ref}]` }), report({ ruleRef: 'fixture-city-bars', path: '/sections/0/bars/1/text', quote: 'second' })], [A], new Set([CODE]), BODY);
    expect(r.unverified).toEqual([]);
    expect(r.violations).toEqual([
      { key: `${A.ref}@/sections/0/bars/0/text`, ruleRef: A.ref, method: 'model', path: '/sections/0/bars/0/text', quote: 'Canal Street', expected: 'e', found: 'f' },
      { key: `${A.ref}@/sections/0/bars/1/text`, ruleRef: A.ref, method: 'model', path: '/sections/0/bars/1/text', quote: 'second', expected: 'e', found: 'f' },
    ]);
  });

  it('accepts a quote anywhere under a section-level path', () => {
    expect(verifyReported([report({ path: '/sections/0' })], [A], new Set(), BODY).violations).toHaveLength(1);
  });

  it.each<[string, { ruleRef?: string; path?: string; quote?: string }, string]>([
    ['an unknown rule', { ruleRef: 'canonical_prompts:33333333-3333-4333-8333-333333333333' }, 'not one of the rules given'],
    ['a code-checked rule', { ruleRef: CODE }, 'the rule is checked by code, not by the model'],
    ['a missing path', { path: '/sections/0/bars/5/text' }, 'the path does not name a field of the artifact'],
    ['a JSONPath instead of a pointer', { path: '$.sections[0].bars[0].text' }, 'the path does not name a field of the artifact'],
    ['the root', { path: '' }, 'the path does not name a field of the artifact'],
    ['a quote with different case', { quote: 'canal street' }, 'the quote does not appear at that path'],
    ['a quote with different spacing', { quote: 'Canal  Street' }, 'the quote does not appear at that path'],
    ['an empty quote', { quote: '  ' }, 'the quote does not appear at that path'],
  ])('drops %s as unverified, with the reason', (_label, over, reason) => {
    const r = verifyReported([report(over)], [A], new Set([CODE]), BODY);
    expect(r.violations).toEqual([]);
    expect(r.unverified).toEqual([{ ruleRef: over.ruleRef ?? A.ref, path: over.path ?? '/sections/0/bars/0/text', quote: over.quote ?? 'Canal Street', reason }]);
  });

  it('merges two reports of the same violation', () => {
    expect(verifyReported([report({}), report({ quote: 'Neon' })], [A], new Set(), BODY).violations).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run records/x3lius/evaluation/checks.test.ts records/x3lius/evaluation/verify.test.ts`
Expected: FAIL, because the modules don't exist.

- [ ] **Step 3: Write `records/x3lius/evaluation/checks.ts`**

```ts
import { SUNO_PROMPT_SCHEMA_ID } from '../creative/schemas.ts';
import type { ContextEntry } from '../creative/types.ts';
import type { MixCheck } from '../mix-master/agent.ts';
import { LIMIT_TOPIC, measureSunoText } from '../suno/formula.ts';
import { violationKey, type CheckedRule, type Violation } from './schemas.ts';

/**
 * The Critic's code checks (spec §5.2): rules with a structured value code can compare. Every other
 * rule goes to the model. Each check reuses the phase that owns the value, so there is one way to
 * measure it.
 */

export type CodeCheckResult = { readonly rules: readonly CheckedRule[]; readonly violations: readonly Violation[] };

/** Where each measured Suno field lives in a x3lius.suno-prompt/v1 body. */
const SUNO_FIELD_PATH: Readonly<Record<string, string>> = { title: '/title', style: '/style', 'exclude-styles': '/excludeStyles', lyrics: '/lyrics' };
const excerpt = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : String(v)).slice(0, 200);

/**
 * Code checks for the entries that have one. Today: `suno.limit.<field>-chars` claims on a Suno
 * prompt, measured from the text itself (never from the stored `limits`, which a later rule change
 * leaves stale).
 * @param schemaId - the artifact's schema id
 * @param entries - rules and claims in force for it
 * @param body - the artifact body
 * @returns the code-checked rules and the violations among them
 */
export const codeChecks = (schemaId: string, entries: readonly ContextEntry[], body: Record<string, unknown>): CodeCheckResult => {
  if (schemaId !== SUNO_PROMPT_SCHEMA_ID) return { rules: [], violations: [] };
  const measured = measureSunoText(body);
  const rules: CheckedRule[] = [];
  const violations: Violation[] = [];
  for (const e of entries) {
    const m = e.kind === 'claim' ? LIMIT_TOPIC.exec(e.topic) : null;
    if (!m || e.kind !== 'claim' || !Number.isInteger(e.value) || !(m[1]! in measured)) continue;
    rules.push({ ref: e.ref, kind: 'claim', method: 'code' });
    const field = m[1]!;
    const max = e.value as number;
    const actual = measured[field]!;
    if (actual <= max) continue;
    const path = SUNO_FIELD_PATH[field]!;
    violations.push({
      key: violationKey(e.ref, path), ruleRef: e.ref, method: 'code', path,
      quote: excerpt(body[path.slice(1)]), expected: `at most ${max} characters (${e.topic})`, found: `${actual} characters`,
    });
  }
  return { rules, violations };
};

/**
 * A mix report's own checks as the Critic's rules (spec §5.1): each bounded metric is a rule with
 * its claim ref and version, and each raise/lower is a violation. An `unset` metric has no check.
 * @param body - a x3lius.mix-report/v1 body
 * @returns rules and violations, all found by code
 */
export const mixReportChecks = (body: Record<string, unknown>): CodeCheckResult => {
  const checks = body.checks as MixCheck[];
  const range = (c: MixCheck) => [c.rubric.min !== undefined ? `≥ ${c.rubric.min}` : null, c.rubric.max !== undefined ? `≤ ${c.rubric.max}` : null].filter(Boolean).join(' and ');
  return {
    rules: checks.map((c) => ({ ref: c.ref, kind: 'claim' as const, method: 'code' as const, version: c.version })),
    violations: checks.flatMap((c, i) => (c.action === 'keep' ? [] : [{
      key: violationKey(c.ref, `/checks/${i}`), ruleRef: c.ref, ruleVersion: c.version, method: 'code' as const, path: `/checks/${i}`,
      quote: `${c.metric} ${c.measured} ${c.unit}`, expected: `${c.metric} ${range(c)} ${c.unit}`, found: `${c.measured} ${c.unit}: ${c.action} by ${c.by}`,
    }])),
  };
};
```

- [ ] **Step 4: Write `records/x3lius/evaluation/verify.ts`**

```ts
import { resolveRef } from '../creative/program.ts';
import type { ContextEntry } from '../creative/types.ts';
import { getAt, stringsIn } from './pointer.ts';
import { violationKey, type Unverified, type Violation } from './schemas.ts';

/** One violation as the Critic's model reported it (x3lius.critique-llm/v1). */
export type ReportedViolation = { readonly ruleRef: string; readonly path: string; readonly quote: string; readonly expected: string; readonly found: string };

/**
 * Keeps a model-reported violation only when code can confirm it (spec §5.3): the rule is one the
 * model was asked to judge, the path names a field of the body, and the quote appears there word for
 * word. Everything else is returned as unverified with its reason, and never counts. Two reports of
 * the same key merge.
 * @param reported - the model's violations
 * @param modelRules - the rules the model was asked to judge
 * @param codeRefs - refs code already checked (a model report against one is refused)
 * @param body - the artifact body the model saw
 * @returns verified violations and dropped reports
 */
export const verifyReported = (
  reported: readonly ReportedViolation[],
  modelRules: readonly ContextEntry[],
  codeRefs: ReadonlySet<string>,
  body: Record<string, unknown>,
): { violations: Violation[]; unverified: Unverified[] } => {
  const violations = new Map<string, Violation>();
  const unverified: Unverified[] = [];
  for (const r of reported) {
    const ref = resolveRef(r.ruleRef, modelRules);
    const at = getAt(body, r.path);
    const reason = codeRefs.has(ref) ? 'the rule is checked by code, not by the model'
      : !modelRules.some((e) => e.ref === ref) ? 'not one of the rules given'
        : !at.found ? 'the path does not name a field of the artifact'
          : r.quote.trim() === '' || !stringsIn(at.value).some((s) => s.includes(r.quote)) ? 'the quote does not appear at that path'
            : null;
    if (reason) {
      unverified.push({ ruleRef: r.ruleRef, path: r.path, quote: r.quote, reason });
      continue;
    }
    const key = violationKey(ref, r.path);
    if (!violations.has(key)) violations.set(key, { key, ruleRef: ref, method: 'model', path: r.path, quote: r.quote, expected: r.expected, found: r.found });
  }
  return { violations: [...violations.values()], unverified };
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run records/x3lius/evaluation && npx tsc --noEmit -p .`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add records/x3lius/evaluation/checks.ts records/x3lius/evaluation/checks.test.ts records/x3lius/evaluation/verify.ts records/x3lius/evaluation/verify.test.ts
git commit -m "Phase 12: Critic code checks (Suno limits, mix checks) and model-violation verification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The Critic agent (x3lius-evaluation replaces the Phase 7 stub)

**Files:**
- Create: `records/x3lius/evaluation/critic.ts`
- Modify: `agents/x3lius-evaluation.agent.md` (rewrite)
- Modify: `core/runtime/programs.ts` (register), `core/runtime/handlers.ts` (`BUILT_SUBDOMAINS` adds `'x3lius-evaluation'`)
- Modify: `tests/helpers/fake-llm.ts` (default replies for the two new LLM schemas)
- Modify: `tests/phase-07/propagation.test.ts`, `tests/phase-07/subdomains.test.ts`, `tests/phase-09/suno-flow.test.ts`, `tests/phase-11/production.test.ts` (the last stub is gone)
- Test: `tests/phase-12/critic-revision.test.ts` (new; shared setup plus the Critic describe block)

**Interfaces:**
- Consumes:
  - `read_artifact` (`ArtifactRecord`), `read_critique` (`CritiqueRow`), `write_critique` (Task 2);
  - `specForSchema`, `pullEntries`, `promptLine` (Task 3); `appliesTo` (Task 3);
  - `codeChecks`, `mixReportChecks`, `verifyReported` (Task 4).
- Produces:
  - `CRITIC_AGENT = 'x3lius-evaluation'`, `criticProgram: LlmProgram`;
  - `type CriticOutput = { status: 'critiqued'; critique: { id; artifactId; schemaId; version; counts: CritiqueCounts }; body: CritiqueBody }`.
  - Critic input: `{ artifactId: string; previousCritiqueId?: string }`.
  - The model user message format is `ARTIFACT <schemaId> v<version>\n<json body without trace>`, which test fakes parse.

- [ ] **Step 1: Teach the FAKE model the two new schemas**

In `tests/helpers/fake-llm.ts`, add just before the final `throw new Error(\`fake model: unknown schema …\`)` in `fakeBody`:

```ts
  // Phase 12 Critic / Revision: nothing found, nothing to edit. Tests script real replies with `override`.
  if ('violations' in props) return { violations: [] };
  if ('edits' in props) return { edits: [] };
```

- [ ] **Step 2: Write the failing integration test (shared setup and Critic block)**

`tests/phase-12/critic-revision.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { decideApproval, runGate } from '../../knowledge/promotion-gate/gate.ts';
import { loadEmbedder, type Embedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { embedPending } from '../../knowledge/vector-retrieval/pipeline.ts';
import { asRole } from '../../research-intelligence/db.ts';
import { writeEvidence } from '../../research-intelligence/evidence/engine.ts';
import { registerResearchSource } from '../../research-intelligence/sources/verify.ts';
import { proposeCandidate, recordFinding } from '../../research-intelligence/synthesis/findings.ts';
import type { CriticOutput } from '../../records/x3lius/evaluation/critic.ts';
import { MUSIC_SYSTEM_MANIFEST } from '../../records/x3lius/music-system.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { FAKE_KEYS, fakeModel } from '../helpers/fake-llm.ts';

// Phase 12 proof (part 2): the Critic, Revision and the loop, on a throwaway DB holding the real
// guide + X3LIUS manifest.
// FAKE MODEL: every Critic and Revision reply is scripted here. The scripts are stateless: each reads
// the artifact (or the violations) from the request it answers, so the proofs show the loop's
// logic, never a model's judgement.
// FIXTURES: one prose rule each for Lyrics and Suno, and two Suno length claims, promoted through the
// real gate ("[FIXTURE]" in every field), only in this database. The Suno prompts are written
// before the 12-character style limit exists, as they would be before a rule change.

type Json = Record<string, unknown>;
type Written = { artifact: { id: string; version: number; schemaId: string }; body: Json };
type Reported = { ruleRef: string; path: string; quote: string; expected: string; found: string };

const REQUEST = 'Write an X3LIUS song about the city at night';
let db: TestDb;
let embedder: Embedder;
let researchRunId: string;
const rules = { lyrics: '', suno: '', styleLimit: '' };
const prompts: Record<'critic' | 'revision' | 'loop', string> = { critic: '', revision: '', loop: '' };
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });

const depsWith = (model = fakeModel()): DispatchDeps => ({
  sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS,
  llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
});
const run = (agent: string, input: unknown, model = fakeModel()) => dispatch(depsWith(model), agent, input, { timeoutMs: 60_000 });
const artifactsOf = (runId: string) => db.sql<{ id: string }[]>`select id from creative_artifacts where agent_run_id = ${runId}`;

/** Promotes one [FIXTURE] finding through the real gate; returns the canonical_prompts id. */
const promote = async (slug: string, note: string, module: string, claim: { topic: string; value: unknown; modelTag: string }): Promise<string> => {
  const src = await registerResearchSource(db.sql, {
    researchRunId, kind: 'observation', uri: `fixture:phase-12/${slug}`, title: `[FIXTURE] ${note}`,
    contentSha256: createHash('sha256').update(`fixture\n${slug}\n${note}`).digest('hex'),
  });
  const ev = await writeEvidence(db.sql, { researchRunId, agentRunId: null, specialist: 'fixture:phase-12-test' }, {
    research_source_id: src.id, claim: `[FIXTURE] ${note}`, model_tag: claim.modelTag, confidence: 0.7,
    confidence_inputs: { basis: 'synthetic fixture for the Phase 12 proof — not a real observation' },
    claim_topic: claim.topic, claim_value: claim.value,
  });
  const f = await recordFinding(db.sql, { researchRunId, claim: `[FIXTURE] ${note}`, claim_topic: claim.topic, claim_value: claim.value, model_tag: claim.modelTag, evidenceIds: [ev] });
  const c = await proposeCandidate(db.sql, {
    findingId: f.findingId, proposed_kind: 'canonical_prompt', target_slug: slug, title: `[FIXTURE] ${note}`,
    body: `[FIXTURE — synthetic, Phase 12 proof] ${note}`, domain: 'RECORDS', tags: [module],
  });
  const pending = await runGate(db.sql, c);
  await decideApproval(db.sql, pending.approvalId!, { decision: 'approve', approver: 'operator:phase-12-test', reason: 'Fixture for the Phase 12 proof.' });
  const r = await runGate(db.sql, c);
  expect(r.outcome).toBe('promoted');
  await embedPending(db.sql, embedder);
  return r.canonicalPromptId!;
};

const props = (schema: Json) => (schema.properties ?? {}) as Json;
/** The artifact a Critic or Revision request carries ("ARTIFACT <schema> v<n>\n<json>[\n\nVIOLATIONS\n<json>]"). */
const artifactIn = (user: string): Json => JSON.parse(user.slice(user.indexOf('\n') + 1).split('\n\nVIOLATIONS\n')[0]!) as Json;
const violationsIn = (user: string) => JSON.parse(user.split('\n\nVIOLATIONS\n')[1]!) as { key: string; path: string; ruleRef: string }[];
/** A FAKE model whose Critic and Revision replies are scripted; every other call gets the default fake body. */
const scripted = (s: { critic?: (artifact: Json) => Reported[]; revise?: (violations: { key: string; path: string; ruleRef: string }[], artifact: Json) => unknown[] }) =>
  fakeModel({
    override: (schema, _refs, user) => ('violations' in props(schema) ? { violations: s.critic?.(artifactIn(user)) ?? [] }
      : 'edits' in props(schema) ? { edits: s.revise?.(violationsIn(user), artifactIn(user)) ?? [] }
        : undefined),
  });

const lyrics = async () => {
  const r = await run('x3lius-lyrics', { request: REQUEST });
  expect(r.status, r.error).toBe('success');
  return (r.output as Written).artifact;
};
const sunoPrompt = async () => {
  const l = await lyrics();
  const r = await run('x3lius-suno', { request: REQUEST, sunoModel: 'v5', lyricsArtifactIds: [l.id] });
  expect(r.status, r.error).toBe('success');
  return (r.output as Written).artifact;
};
const critiqueRow = (id: string) => db.sql<{ checked: number; passed: number; artifact_id: string }[]>`select checked, passed, artifact_id from critiques where id = ${id}`;

beforeAll(async () => {
  db = await createTestDb('phase12_critic_revision', { migrated: true });
  for (const path of [join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), MUSIC_SYSTEM_MANIFEST]) {
    const r = await ingestSource(db.sql, { kind: 'file', path, origin: 'first_party' });
    expect(r.status, r.error).toBe('success');
  }
  embedder = await loadEmbedder();
  await embedPending(db.sql, embedder);
  researchRunId = await asRole(db.sql, 'xyp_research', async (tx) => {
    const [p] = await tx<{ id: string }[]>`insert into research_projects (slug, title) values ('phase-12-fixture', '[FIXTURE] Phase 12 proof') returning id`;
    const [q] = await tx<{ id: string }[]>`insert into research_questions (project_id, question) values (${p!.id}, ${REQUEST}) returning id`;
    const [r] = await tx<{ id: string }[]>`insert into research_runs (question_id) values (${q!.id}) returning id`;
    return r!.id;
  });
  rules.lyrics = await promote('fixture-phase-12-lyrics-rule', 'Every X3LIUS bar names a place in the city.', 'x3lius-lyrics',
    { topic: 'fixture.x3lius-lyrics-city-bars', value: 'names-a-place', modelTag: 'model-agnostic' });
  rules.suno = await promote('fixture-phase-12-suno-rule', 'Open the X3LIUS style prompt with the vocal descriptor.', 'x3lius-suno',
    { topic: 'fixture.x3lius-suno-vocal-first', value: 'vocal-first', modelTag: 'model-agnostic' });
  await promote('fixture-phase-12-suno-title-limit', 'Suno v5 accepts at most 80 characters of title (FIXTURE value).', 'x3lius-suno',
    { topic: 'suno.limit.title-chars', value: 80, modelTag: 'suno-v5' });
  for (const k of ['critic', 'revision', 'loop'] as const) prompts[k] = (await sunoPrompt()).id;
  // The rule change: the style limit arrives after those prompts were written ([FAKE] style is 19 chars).
  const limitId = await promote('fixture-phase-12-suno-style-limit', 'Suno v5 accepts at most 12 characters of style (FIXTURE value).', 'x3lius-suno',
    { topic: 'suno.limit.style-chars', value: 12, modelTag: 'suno-v5' });
  rules.styleLimit = `canonical_prompts:${limitId}#suno.limit.style-chars`;
}, 600_000);
afterAll(async () => {
  await db?.drop();
});

describe('Critic (x3lius-evaluation)', () => {
  it('a Suno prompt: a code-found length violation and a verified model-found one, each tied to its rule', async () => {
    const model = scripted({
      critic: () => [
        { ruleRef: `canonical_prompts:${rules.suno}`, path: '/style', quote: '[FAKE] style prompt', expected: 'the vocal descriptor first', found: 'a placeholder' },
        { ruleRef: `canonical_prompts:${rules.suno}`, path: '/title', quote: 'not in the title', expected: 'x', found: 'y' },
      ],
    });
    const r = await run('x3lius-evaluation', { artifactId: prompts.critic }, model);
    expect(r.status, r.error).toBe('success');
    const out = r.output as CriticOutput;
    expect(out.body.violations.map(({ ruleRef, method, path }) => ({ ruleRef, method, path }))).toEqual([
      { ruleRef: rules.styleLimit, method: 'code', path: '/style' },
      { ruleRef: `canonical_prompts:${rules.suno}`, method: 'model', path: '/style' },
    ]);
    expect(out.body.violations[0]).toMatchObject({ expected: 'at most 12 characters (suno.limit.style-chars)', found: '19 characters' });
    expect(out.body.unverified).toEqual([expect.objectContaining({ path: '/title', reason: 'the quote does not appear at that path' })]);
    const codeRefs = out.body.rules.filter((x) => x.method === 'code').map((x) => x.ref);
    expect(codeRefs).toHaveLength(2);
    expect(codeRefs).toEqual(expect.arrayContaining([rules.styleLimit, expect.stringContaining('#suno.limit.title-chars')]));
    expect(out.critique.counts).toEqual({ checked: out.body.rules.length, passed: out.body.rules.length - 2, violations: 2 });
    const [row] = await critiqueRow(out.critique.id);
    expect(row).toEqual({ checked: out.critique.counts.checked, passed: out.critique.counts.passed, artifact_id: prompts.critic });
    // The model judges only what code doesn't: it is sent the prose rule, never the length claims.
    const system = model.calls.at(-1)!.system;
    expect(system).toContain(`[canonical_prompts:${rules.suno}]`);
    expect(system).not.toContain('suno.limit.style-chars');
  });

  it('refuses a bare request and a previous critique of another version', async () => {
    expect((await run('x3lius-evaluation', { request: 'Evaluate the new X3LIUS take' })).error).toMatch(/critiques one artifact version: input \{ artifactId/);
    const l = await lyrics();
    const first = (await run('x3lius-evaluation', { artifactId: l.id })).output as CriticOutput;
    expect((await run('x3lius-evaluation', { artifactId: l.id, previousCritiqueId: first.critique.id })).error).toMatch(/not the parent of/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/phase-12/critic-revision.test.ts`
Expected: FAIL. The Critic cases error with `no handler registered for x3lius-evaluation`-style or `no LLM program registered for agent x3lius-evaluation` messages; the placeholder answers with `status: 'stub'`.

- [ ] **Step 4: Write `records/x3lius/evaluation/critic.ts`**

```ts
import type { LlmProgram } from '../../../core/llm/runner.ts';
import type { ArtifactRecord } from '../../../core/tool-registry/tools/read-artifact.ts';
import { withoutTrace } from '../creative/artifacts.ts';
import { promptLine, pullEntries, specForSchema } from '../creative/program.ts';
import { MIX_REPORT_SCHEMA_ID } from '../creative/schemas.ts';
import { isModelAgnostic, scopeOf, type ContextEntry } from '../creative/types.ts';
import { appliesTo } from '../suno/formula.ts';
import { codeChecks, mixReportChecks } from './checks.ts';
import {
  CRITIQUE_LLM_SCHEMA, CRITIQUE_LLM_SCHEMA_ID, type CheckedRule, type CritiqueBody, type CritiqueCounts, type Unverified, type Violation,
} from './schemas.ts';
import type { CritiqueRow } from './tools.ts';
import { verifyReported, type ReportedViolation } from './verify.ts';

/**
 * The Critic (Phase 12, class Critic): checks one creative artifact version against the canonical
 * rules in force for it and writes an x3lius.critique/v1. Specific violations, each tied to a rule
 * ref; it never edits the artifact (Revision's job). Code checks structured claims; the model
 * judges prose rules, and code verifies every violation it reports (spec §5).
 */
export const CRITIC_AGENT = 'x3lius-evaluation';

export type CriticOutput = {
  readonly status: 'critiqued';
  readonly critique: { readonly id: string; readonly artifactId: string; readonly schemaId: string; readonly version: number; readonly counts: CritiqueCounts };
  readonly body: CritiqueBody;
};

/** Entries that apply to this artifact: model-agnostic ones, and ones scoped to the Suno version its body targets. */
const applies = (e: ContextEntry, body: Record<string, unknown>): boolean =>
  isModelAgnostic(e) || (typeof body.sunoModel === 'string' && appliesTo(scopeOf(e), body.sunoModel));

const systemPrompt = (rules: readonly ContextEntry[]): string => [
  'You are the Critic of the X3LIUS Music System. You check one creative artifact against the canonical rules below and report only where it breaks them.',
  '',
  'RULES',
  'Each starts with its ref in brackets.',
  ...rules.map(promptLine),
  '',
  'HOW TO REPORT',
  '- Report a violation only when the artifact breaks one of the RULES. Do not report taste or preferences no rule states.',
  '- ruleRef: the rule broken, with its ref copied exactly as shown inside the brackets.',
  '- path: a JSON Pointer to the field that breaks it, e.g. /sections/1/bars/0/text.',
  '- quote: the offending words, copied exactly from that field. Code checks the quote; one it cannot find there is dropped.',
  '- expected: what the rule requires there. found: what the artifact has.',
  '- When the artifact breaks no rule, reply with an empty violations list.',
  '- Reply with JSON only, matching the response schema.',
].join('\n');

/**
 * @param ctx - run context (tools: retrieve_context, retrieve_claims, read_artifact, read_critique, write_critique, log_message)
 * @param input - `{ artifactId, previousCritiqueId? }`; previousCritiqueId must be the critique of the artifact's parent
 * @returns `{ status: 'critiqued', critique: { id, artifactId, schemaId, version, counts }, body }`
 * @throws Error on a bare request, a previous critique of another version, or a schema no current spec writes
 */
export const criticProgram: LlmProgram = async (ctx, input, llm) => {
  const i = (input ?? {}) as { artifactId?: unknown; previousCritiqueId?: unknown };
  if (typeof i.artifactId !== 'string') throw new Error(`${CRITIC_AGENT} critiques one artifact version: input { artifactId, previousCritiqueId? }`);
  const a = (await ctx.useTool('read_artifact', { id: i.artifactId })) as ArtifactRecord;
  let previous: CritiqueRow | null = null;
  if (i.previousCritiqueId !== undefined) {
    if (typeof i.previousCritiqueId !== 'string') throw new Error('previousCritiqueId must be a critique id');
    previous = (await ctx.useTool('read_critique', { id: i.previousCritiqueId })) as CritiqueRow;
    if (previous.artifactId !== a.parentId) throw new Error(`critique ${previous.id} reviewed ${previous.artifactId}, not the parent of ${a.id}`);
  }

  let rules: CheckedRule[];
  let violations: Violation[];
  let unverified: Unverified[] = [];
  let tokensUsed = 0;
  if (a.schemaId === MIX_REPORT_SCHEMA_ID) {
    // A report of measurements: its checks are the rules, all code (spec §5.1). No model call.
    const mix = mixReportChecks(a.body);
    rules = [...mix.rules];
    violations = [...mix.violations];
  } else {
    const found = specForSchema(a.schemaId);
    if (!found) throw new Error(`no Creative spec writes ${a.schemaId}: the Critic can't tell which rules govern it`);
    const { pulled } = await pullEntries(ctx, found.slug, a.brief);
    const byRef = new Map(pulled.map((p) => [p.entry.ref, p.entry]));
    const entries = [...byRef.values()].filter((e) => applies(e, a.body));
    const code = codeChecks(a.schemaId, entries, a.body);
    const codeRefs = new Set(code.rules.map((r) => r.ref));
    const modelRules = entries.filter((e) => !codeRefs.has(e.ref));
    let model: { violations: Violation[]; unverified: Unverified[] } = { violations: [], unverified: [] };
    if (modelRules.length > 0) {
      const res = await llm.complete({
        system: systemPrompt(modelRules),
        user: `ARTIFACT ${a.schemaId} v${a.version}\n${JSON.stringify(withoutTrace(a.body))}`,
        schema: { name: CRITIQUE_LLM_SCHEMA_ID, schema: CRITIQUE_LLM_SCHEMA },
        signal: ctx.signal,
      });
      tokensUsed = res.usage.inputTokens + res.usage.outputTokens;
      model = verifyReported((res.json as { violations: ReportedViolation[] }).violations, modelRules, codeRefs, a.body);
      for (const u of model.unverified) {
        await ctx.useTool('log_message', { level: 'warn', message: `${CRITIC_AGENT}: dropped an unverifiable violation of ${u.ruleRef} at ${u.path}: ${u.reason}` });
      }
    }
    rules = [...code.rules, ...modelRules.map((e) => ({ ref: e.ref, kind: e.kind, method: 'model' as const }))];
    violations = [...code.violations, ...model.violations];
    unverified = model.unverified;
  }

  const keys = new Set(violations.map((v) => v.key));
  const counts: CritiqueCounts = {
    checked: rules.length,
    passed: rules.filter((r) => !violations.some((v) => v.ruleRef === r.ref)).length,
    violations: violations.length,
  };
  const body: CritiqueBody = {
    artifact: { id: a.id, schemaId: a.schemaId, version: a.version, agent: a.agentName },
    ...(previous ? { previousCritiqueId: previous.id } : {}),
    rules,
    violations,
    resolved: previous ? previous.body.violations.map((v) => v.key).filter((k) => !keys.has(k)) : [],
    unverified,
    counts,
  };
  const written = (await ctx.useTool('write_critique', { artifactId: a.id, ...(previous ? { previousId: previous.id } : {}), body })) as { critique_id: string };
  await ctx.useTool('log_message', {
    message: `${CRITIC_AGENT}: ${a.schemaId} v${a.version}: ${counts.violations} violation(s); ${counts.passed}/${counts.checked} rules passed${body.resolved.length > 0 ? `; ${body.resolved.length} resolved` : ''}`,
  });
  return {
    output: { status: 'critiqued', critique: { id: written.critique_id, artifactId: a.id, schemaId: a.schemaId, version: a.version, counts }, body } satisfies CriticOutput,
    tokensUsed,
  };
};
```

- [ ] **Step 5: Rewrite `agents/x3lius-evaluation.agent.md`**

```markdown
---
name: x3lius-evaluation
class: Critic
domain: RECORDS
tools: [retrieve_context, retrieve_claims, read_artifact, read_critique, write_critique, log_message]
model: openrouter:nvidia/nemotron-3-ultra-550b-a55b:free
---

# X3LIUS Evaluation (Critic)

## Role

The Critic of the X3LIUS Music System (Phase 12). It replaces the Phase 7 stub under the same name, so routing and scope carry over. It answers the Critic class's question, "what is wrong with the result?", for one creative artifact version at a time. It checks the version against the canonical rules in force for it and writes a structured critique of specific violations, each tied to a rule ref. It never edits the artifact; that is `x3lius-revision`'s job. The loop controller (`pnpm evaluate`) runs the two in turn.

## Scope

Covers critique and scoring of X3LIUS outputs against canonical rubrics.

Keywords: evaluation (3), evaluate (3), critique (3), rubric (3), score (2), feedback (2)

## Contract

- **Inputs:** `{ "artifactId": uuid, "previousCritiqueId"?: uuid }`. `previousCritiqueId` is the critique of this version's parent, when a loop continues.
- **Outputs:** `{ status: "critiqued", critique: { id, artifactId, schemaId, version, counts: { checked, passed, violations } }, body }`, where `body` is an `x3lius.critique/v1`:
  - `rules` lists every rule checked, with `method: code | model`.
  - `violations` has `{ key: ruleRef@path, ruleRef, method, path (JSON Pointer), quote, expected, found }`.
  - `resolved` lists the keys of the previous critique's violations that are now gone.
  - `unverified` lists model reports that code could not confirm, with the reason.
- **Reads:**
  - the artifact via `read_artifact` and the previous critique via `read_critique`;
  - the rules via `retrieve_context` and `retrieve_claims`. It uses the producing sub-domain's modules and claim namespaces (found by schema id), queried with the artifact's brief, current versions only.
  - A mix report's rules are its own checks.
- **Writes:** one `critiques` row via `write_critique` (`critique.write`, as `xyp_critic`); its own `agent_runs` row; run-log lines.
- **Side effects:** one model call per critique, only when prose rules apply. There is none for a mix report.

## Refuses

- Editing the artifact under review, the rubric or any canonical knowledge.
- A bare request with no `artifactId`. A routed request is refused the same way Mix/Master refuses one without an analysis.
- A `previousCritiqueId` that did not review this version's parent.
- A schema no current Creative spec writes, such as a legacy `x3lius.lyrics/v1`.
- Counting a model-reported violation that code cannot confirm: an unknown or code-checked rule, a path that isn't a field, or a quote that isn't there word for word.
```

- [ ] **Step 6: Register the program and mark Evaluation built**

`core/runtime/programs.ts`: add `import { CRITIC_AGENT, criticProgram } from '../../records/x3lius/evaluation/critic.ts';` and inside `LLM_PROGRAMS` after `...CREATIVE_PROGRAMS,`:

```ts
  // Phase 12: the Critic (x3lius-evaluation, replacing its Phase 7 stub).
  [CRITIC_AGENT]: criticProgram,
```

`core/runtime/handlers.ts`: change `BUILT_SUBDOMAINS` to

```ts
export const BUILT_SUBDOMAINS: readonly string[] = [...CREATIVE_SUBDOMAINS, 'x3lius-vocal-dna', 'x3lius-mix-master', 'x3lius-evaluation'];
```

and update the comment above the stub spread to read `// Phase 7: one stub per X3LIUS sub-domain no phase has built yet (none since Phase 12): the fallback for a sub-domain a future manifest adds.`

- [ ] **Step 7: Update the earlier-phase tests that assumed Evaluation was a stub**

`tests/phase-07/propagation.test.ts`:
- add `import { subdomainStub } from '../../records/x3lius/subdomain-stub.ts';`
- after the existing `const deps = …` line, add:

```ts
// Phase 12 built Evaluation, the last stub sub-domain. The stub handler stays the fallback for any
// sub-domain a future manifest adds, so these proofs run on a registry double that presents
// x3lius-evaluation as a Knowledge stub, with the stub handler bound to it.
const stubDeps = () => ({
  ...deps(),
  registry: {
    ...registry,
    get: (name: string) => {
      const a = registry.get(name);
      return a && name === 'x3lius-evaluation' ? { ...a, class: 'Knowledge' as const, tools: ['retrieve_context', 'log_message'], model: 'none' } : a;
    },
  },
  handlers: { ...HANDLERS, 'x3lius-evaluation': subdomainStub },
});
```

- in the two tests `through the Agent Registry: a stub sub-domain returns its promoted rule…` and `end to end from a raw request: route → RECORDS → X3LIUS entrypoint → x3lius-evaluation`, replace `deps()` with `stubDeps()`;
- update the comment above the first to say Evaluation was built in Phase 12 and the proof now runs on the double.

`tests/phase-07/subdomains.test.ts`: replace the `it.each(system.subdomains.filter((s) => !BUILT.includes(s.slug))…)` block with:

```ts
  it('every manifest sub-domain has a built agent (Phase 12 built Evaluation, the last stub)', () => {
    expect(system.subdomains.filter((s) => !BUILT.includes(s.slug)).map((s) => s.slug)).toEqual([]);
  });
```

Remove any import the file no longer uses (for example `parseScope` or `HANDLERS`); `npx tsc` will name them.

`tests/phase-09/suno-flow.test.ts`: replace the test `every sub-domain not built yet is still a read-only stub; the registry validates` with:

```ts
  it('every sub-domain is built: no stub remains (Phase 12 built Evaluation, the last); the registry validates', () => {
    expect(loadMusicSystem().subdomains.map((s) => s.slug).filter((s) => !BUILT_SUBDOMAINS.includes(s))).toEqual([]);
    expect(registry.validateAll()).toEqual([]);
  });
```

Remove the `subdomainStub` import if it's now unused.

`tests/phase-11/production.test.ts`: replace `expect(registry.get('x3lius-evaluation')).toMatchObject({ class: 'Knowledge', model: 'none' });` with

```ts
    // Phase 12 replaced the Evaluation stub with the Critic.
    expect(registry.get('x3lius-evaluation')).toMatchObject({ class: 'Critic', domain: 'RECORDS' });
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/phase-12 tests/phase-07 tests/phase-09 tests/phase-11 && npx tsc --noEmit -p .`
Expected: PASS, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add records/x3lius/evaluation/critic.ts agents/x3lius-evaluation.agent.md core/runtime/programs.ts core/runtime/handlers.ts tests/helpers/fake-llm.ts tests/phase-12/critic-revision.test.ts tests/phase-07 tests/phase-09/suno-flow.test.ts tests/phase-11/production.test.ts
git commit -m "Phase 12: the Critic (x3lius-evaluation) replaces the last Phase 7 stub

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Applying revision edits (pure)

**Files:**
- Create: `records/x3lius/evaluation/edits.ts`, `records/x3lius/evaluation/edits.test.ts`

**Interfaces:**
- Consumes: `getAt`, `isAtOrUnder`, `setAt` (Task 3); `measureSunoText` (Task 3); `Violation`, `violationKey` (Task 2).
- Produces:
  - `type Edit = { path: string; replacement: string; violationKeys: readonly string[] }`
  - `applyEdits(schemaId, body, edits, violations): Record<string, unknown>` (throws `revision refused: …`)
  - `rederive(schemaId, body): Record<string, unknown>`
  - `isDerived(schemaId, path): boolean`

- [ ] **Step 1: Write the failing test**

`records/x3lius/evaluation/edits.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LYRICS_SCHEMA_ID, SUNO_PROMPT_SCHEMA_ID } from '../creative/schemas.ts';
import { applyEdits, rederive } from './edits.ts';
import { violationKey, type Violation } from './schemas.ts';

const REF = 'canonical_prompts:11111111-1111-4111-8111-111111111111';
const v = (path: string): Violation => ({ key: violationKey(REF, path), ruleRef: REF, method: 'model', path, quote: 'q', expected: 'e', found: 'f' });
const LYR = {
  sections: [{ sectionId: 'v1', kind: 'verse', flag: true, bars: [{ n: 1, text: 'old one' }, { n: 2, text: 'old two' }] }],
  instrumental: [], sources: [{ role: 'structure', artifactId: 'a', schemaId: 's', version: 1 }], rulesApplied: [], ungroundedChoices: [],
};
const LYR_ID = LYRICS_SCHEMA_ID;
const bar0 = v('/sections/0/bars/0/text');
const section = v('/sections/0');

describe('applying revision edits', () => {
  it('replaces a violated field, and a field inside a violated section, on a copy', () => {
    const next = applyEdits(LYR_ID, LYR, [
      { path: '/sections/0/bars/0/text', replacement: 'Neon on Canal Street', violationKeys: [bar0.key] },
      { path: '/sections/0/bars/1/n', replacement: '3', violationKeys: [section.key] },
      { path: '/sections/0/flag', replacement: 'false', violationKeys: [section.key] },
    ], [bar0, section]);
    expect(next.sections).toEqual([{ sectionId: 'v1', kind: 'verse', flag: false, bars: [{ n: 1, text: 'Neon on Canal Street' }, { n: 3, text: 'old two' }] }]);
    expect(LYR.sections[0]!.bars[0]!.text).toBe('old one');
  });

  it.each([
    ['no edits at all', [], [bar0], /no edits: nothing to revise/],
    ['an edit citing no violation', [{ path: '/sections/0/bars/0/text', replacement: 'x', violationKeys: [] }], [bar0], /edit 0 \(\/sections\/0\/bars\/0\/text\) cites no violation/],
    ['an edit citing a key this critique lacks', [{ path: '/sections/0/bars/0/text', replacement: 'x', violationKeys: ['nope'] }], [bar0], /cites nope, which is not a violation of this critique/],
    ['a path that is not a field', [{ path: '/sections/0/bars/7/text', replacement: 'x', violationKeys: [bar0.key] }], [bar0], /names no field of the artifact/],
    ['a JSONPath', [{ path: '$.sections[0].bars[0].text', replacement: 'x', violationKeys: [bar0.key] }], [bar0], /names no field of the artifact/],
    ['a field code derives', [{ path: '/sources/0/artifactId', replacement: 'x', violationKeys: [bar0.key] }], [bar0, v('/sources')], /targets a field code derives/],
    ['a field no violation points to', [{ path: '/sections/0/bars/1/text', replacement: 'x', violationKeys: [bar0.key] }], [bar0], /is not at or inside a field a violation points to/],
    ['a whole object', [{ path: '/sections/0/bars/0', replacement: 'x', violationKeys: [bar0.key] }], [v('/sections/0/bars/0')], /replaces an object or list, not a text, number or true\/false field/],
    ['text for a number', [{ path: '/sections/0/bars/0/n', replacement: '120 bpm', violationKeys: [section.key] }], [section], /"120 bpm" is not a number/],
    ['text for a true/false field', [{ path: '/sections/0/flag', replacement: 'yes', violationKeys: [section.key] }], [section], /"yes" is not true or false/],
    ['a no-op', [{ path: '/sections/0/bars/0/text', replacement: 'old one', violationKeys: [bar0.key] }], [bar0], /changes nothing/],
    ['two edits of one field', [
      { path: '/sections/0/bars/0/text', replacement: 'a', violationKeys: [bar0.key] },
      { path: '/sections/0/bars/0/text', replacement: 'b', violationKeys: [bar0.key] },
    ], [bar0], /edit 1 \(\/sections\/0\/bars\/0\/text\) repeats a field edit 0 changes/],
  ])('refuses %s, and applies nothing', (_label, edits, violations, message) => {
    expect(() => applyEdits(LYR_ID, LYR, edits, violations)).toThrow(message);
  });

  it('refuses the whole revision when any edit is refused, naming each', () => {
    expect(() => applyEdits(LYR_ID, LYR, [
      { path: '/sections/0/bars/0/text', replacement: 'fine', violationKeys: [bar0.key] },
      { path: '/sections/0/bars/1/text', replacement: 'x', violationKeys: [bar0.key] },
    ], [bar0])).toThrow(/^revision refused: edit 1 /);
  });

  it('never edits a Suno prompt’s lyrics, limits or target model: those are rendered or measured', () => {
    const suno = { sunoModel: 'v5', title: 't', style: 's', excludeStyles: [], lyrics: 'l', sources: [], limits: [], rulesApplied: [], ungroundedChoices: [] };
    for (const path of ['/lyrics', '/sunoModel']) {
      expect(() => applyEdits(SUNO_PROMPT_SCHEMA_ID, suno, [{ path, replacement: 'x', violationKeys: [v(path).key] }], [v(path)])).toThrow(/targets a field code derives/);
    }
  });

  it('re-derives a Suno prompt’s measured lengths after an edit', () => {
    const suno = { sunoModel: 'v5', title: 'Night Title', style: 's', excludeStyles: [], lyrics: 'l', sources: [], limits: [{ field: 'title', max: 80, actual: 3, ref: REF }], rulesApplied: [], ungroundedChoices: [] };
    expect(rederive(SUNO_PROMPT_SCHEMA_ID, suno).limits).toEqual([{ field: 'title', max: 80, actual: 11, ref: REF }]);
    expect(rederive(LYRICS_SCHEMA_ID, LYR)).toBe(LYR);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run records/x3lius/evaluation/edits.test.ts`
Expected: FAIL, because `./edits.ts` does not exist.

- [ ] **Step 3: Write `records/x3lius/evaluation/edits.ts`**

```ts
import { SUNO_PROMPT_SCHEMA_ID } from '../creative/schemas.ts';
import { measureSunoText } from '../suno/formula.ts';
import { getAt, isAtOrUnder, setAt } from './pointer.ts';
import type { Violation } from './schemas.ts';

/** One edit as the Revision model proposes it (x3lius.revision-llm/v1). */
export type Edit = { readonly path: string; readonly replacement: string; readonly violationKeys: readonly string[] };

/** Fields code owns in every body (the trace and the upstream record): never a revision's to edit. */
const DERIVED_ALL: readonly RegExp[] = [/^\/sources(\/|$)/, /^\/rulesApplied(\/|$)/, /^\/ungroundedChoices(\/|$)/];
/** Per schema: a Suno prompt's lyrics are rendered from the lyrics artifacts and its limits are measured. */
const DERIVED: Readonly<Record<string, readonly RegExp[]>> = {
  [SUNO_PROMPT_SCHEMA_ID]: [/^\/limits(\/|$)/, /^\/sunoModel$/, /^\/lyrics$/],
};

/** @returns true when code derives the field at `path`, so a revision may not edit it */
export const isDerived = (schemaId: string, path: string): boolean =>
  [...DERIVED_ALL, ...(DERIVED[schemaId] ?? [])].some((re) => re.test(path));

/** The replacement as a value of the current field's type, or the reason it isn't one. */
const convert = (current: unknown, replacement: string): { readonly value: unknown } | { readonly why: string } => {
  if (typeof current === 'string') return { value: replacement };
  const t = replacement.trim();
  if (typeof current === 'number') return t !== '' && Number.isFinite(Number(t)) ? { value: Number(t) } : { why: `"${replacement}" is not a number` };
  if (typeof current === 'boolean') return t === 'true' ? { value: true } : t === 'false' ? { value: false } : { why: `"${replacement}" is not true or false` };
  return { why: 'replaces an object or list, not a text, number or true/false field' };
};

/**
 * Applies a revision's edits to a copy of the body, or refuses the lot (spec §6). An edit must cite
 * violations of this critique, name an existing field that code doesn't derive, sit at or inside a
 * field a violation points to, keep the field's type, change something, and not repeat a field.
 * @param schemaId - the artifact's schema id (for derived fields)
 * @param body - the reviewed version's body
 * @param edits - the model's edits
 * @param violations - the critique's violations
 * @returns the edited body (a copy)
 * @throws Error `revision refused: …` naming every refused edit; nothing is applied
 */
export const applyEdits = (schemaId: string, body: Record<string, unknown>, edits: readonly Edit[], violations: readonly Violation[]): Record<string, unknown> => {
  if (edits.length === 0) throw new Error('revision refused: no edits: nothing to revise');
  const known = new Set(violations.map((v) => v.key));
  const refusals: string[] = [];
  const planned: { path: string; value: unknown }[] = [];
  const firstEdit = new Map<string, number>();
  edits.forEach((e, i) => {
    const refuse = (why: string) => refusals.push(`edit ${i} (${e.path}) ${why}`);
    const unknown = e.violationKeys.find((k) => !known.has(k));
    if (e.violationKeys.length === 0) return refuse('cites no violation');
    if (unknown !== undefined) return refuse(`cites ${unknown}, which is not a violation of this critique`);
    const at = getAt(body, e.path);
    if (!at.found) return refuse('names no field of the artifact');
    if (isDerived(schemaId, e.path)) return refuse('targets a field code derives');
    if (!violations.some((v) => isAtOrUnder(e.path, v.path))) return refuse('is not at or inside a field a violation points to');
    const c = convert(at.value, e.replacement);
    if ('why' in c) return refuse(c.why);
    if (c.value === at.value) return refuse('changes nothing');
    const prior = firstEdit.get(e.path);
    if (prior !== undefined) return refuse(`repeats a field edit ${prior} changes`);
    firstEdit.set(e.path, i);
    planned.push({ path: e.path, value: c.value });
  });
  if (refusals.length > 0) throw new Error(`revision refused: ${refusals.join('; ')}`);
  return planned.reduce((doc, p) => setAt(doc, p.path, p.value), body);
};

/**
 * Recomputes what a body stores about its own fields after edits. Today: a Suno prompt's measured
 * lengths (`limits[].actual`), from the edited text.
 * @returns the body with derived fields refreshed (the same object when the schema has none)
 */
export const rederive = (schemaId: string, body: Record<string, unknown>): Record<string, unknown> => {
  if (schemaId !== SUNO_PROMPT_SCHEMA_ID) return body;
  const measured = measureSunoText(body);
  return { ...body, limits: (body.limits as { field: string }[]).map((l) => ({ ...l, actual: measured[l.field] })) };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run records/x3lius/evaluation/edits.test.ts && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add records/x3lius/evaluation/edits.ts records/x3lius/evaluation/edits.test.ts
git commit -m "Phase 12: revision edits applied all-or-nothing; derived fields recomputed, never edited

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The Revision agent

**Files:**
- Create: `records/x3lius/evaluation/revision.ts`
- Create: `agents/x3lius-revision.agent.md`
- Modify: `core/runtime/programs.ts` (register)
- Modify: `tests/phase-07/subdomains.test.ts` (`SUBDOMAIN_MEMBERS` gains `'x3lius-revision'`)
- Test: `tests/phase-12/critic-revision.test.ts` (append a Revision describe block)

**Interfaces:**
- Consumes: `read_critique`, `read_artifact`, `write_artifact` with `critiqueId` (Task 2); `specForSchema`, `scriptFindings` (Task 3); `applyEdits`, `rederive`, `Edit` (Task 6).
- Produces:
  - `REVISION_AGENT = 'x3lius-revision'`, `revisionProgram: LlmProgram`;
  - `type RevisionOutput = { status: 'revised'; artifact: { id; lineageId; version; schemaId }; critiqueId: string; edits: readonly Edit[]; body: Record<string, unknown> }`.
  - Input: `{ critiqueId: string }`.
  - The model user message is `ARTIFACT <schemaId> v<version>\n<json>\n\nVIOLATIONS\n<json [{ key, ruleRef, path, quote, expected, found }]>`.

- [ ] **Step 1: Append the failing Revision tests**

Add to `tests/phase-12/critic-revision.test.ts`. The import goes at the top; the describe block goes at the end.

```ts
import type { RevisionOutput } from '../../records/x3lius/evaluation/revision.ts';
```

```ts
describe('Revision (x3lius-revision)', () => {
  it('writes v2 with the edit, naming the critique it answers; derived Suno lengths are recomputed', async () => {
    const critic = scripted({ critic: (a) => (String(a.title).startsWith('[FAKE]') ? [{ ruleRef: `canonical_prompts:${rules.suno}`, path: '/title', quote: '[FAKE] Suno Title', expected: 'a real title', found: 'a placeholder' }] : []) });
    const c = (await run('x3lius-evaluation', { artifactId: prompts.revision }, critic)).output as CriticOutput;
    const titleKey = c.body.violations.find((x) => x.path === '/title')!.key;
    const reviser = scripted({ revise: () => [{ path: '/title', replacement: 'Neon Night Drive', violationKeys: [titleKey] }] });
    const r = await run('x3lius-revision', { critiqueId: c.critique.id }, reviser);
    expect(r.status, r.error).toBe('success');
    const out = r.output as RevisionOutput;
    expect(out.artifact).toMatchObject({ version: 2, schemaId: 'x3lius.suno-prompt/v1' });
    expect(out.body.title).toBe('Neon Night Drive');
    expect((out.body.limits as { field: string; actual: number }[]).find((l) => l.field === 'title')?.actual).toBe('Neon Night Drive'.length);
    const [row] = await db.sql<{ parent_id: string; critique_id: string; agent_name: string }[]>`select parent_id, critique_id, agent_name from creative_artifacts where id = ${out.artifact.id}`;
    expect(row).toEqual({ parent_id: prompts.revision, critique_id: c.critique.id, agent_name: 'x3lius-revision' });
    // Revision sees the violations with their keys, and the artifact without its trace.
    expect(reviser.calls.at(-1)!.user).toContain(`"key":"${titleKey}"`);
    expect(reviser.calls.at(-1)!.user).not.toContain('rulesApplied');
  });

  it('refuses an edit outside every violation, and writes nothing', async () => {
    const l = await lyrics();
    const critic = scripted({ critic: (a) => [{ ruleRef: `canonical_prompts:${rules.lyrics}`, path: '/sections/0/bars/0/text', quote: String(((a.sections as Json[])[0]!.bars as Json[])[0]!.text), expected: 'a place', found: 'none' }] });
    const c = (await run('x3lius-evaluation', { artifactId: l.id }, critic)).output as CriticOutput;
    const r = await run('x3lius-revision', { critiqueId: c.critique.id }, scripted({ revise: (vs) => [{ path: '/sections/1/bars/0/text', replacement: 'Canal Street', violationKeys: [vs[0]!.key] }] }));
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/revision refused: edit 0 \(\/sections\/1\/bars\/0\/text\) is not at or inside a field a violation points to/);
    expect(await artifactsOf(r.runId)).toEqual([]);
  });

  it('refuses a bare request', async () => {
    expect((await run('x3lius-revision', { request: 'fix it' })).error).toMatch(/revises from one critique: input \{ critiqueId \}/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/phase-12/critic-revision.test.ts -t Revision`
Expected: FAIL (`agent not in registry: x3lius-revision`).

- [ ] **Step 3: Write `records/x3lius/evaluation/revision.ts`**

```ts
import type { LlmProgram } from '../../../core/llm/runner.ts';
import type { ArtifactRecord } from '../../../core/tool-registry/tools/read-artifact.ts';
import { withoutTrace } from '../creative/artifacts.ts';
import { scriptFindings, specForSchema } from '../creative/program.ts';
import { MIX_REPORT_SCHEMA_ID } from '../creative/schemas.ts';
import { applyEdits, rederive, type Edit } from './edits.ts';
import { REVISION_LLM_SCHEMA, REVISION_LLM_SCHEMA_ID } from './schemas.ts';
import type { CritiqueRow } from './tools.ts';

/**
 * Revision (Phase 12, class Revision): reads one critique, asks the model for concrete edits,
 * applies them in code (all or nothing), and appends the next version of the artifact naming the
 * critique it answers. It never overwrites a version and never marks a critique resolved: the
 * Critic judges the new version (spec §6).
 */
export const REVISION_AGENT = 'x3lius-revision';

export type RevisionOutput = {
  readonly status: 'revised';
  readonly artifact: { readonly id: string; readonly lineageId: string; readonly version: number; readonly schemaId: string };
  readonly critiqueId: string;
  readonly edits: readonly Edit[];
  readonly body: Record<string, unknown>;
};

const SYSTEM = [
  'You are the Revision agent of the X3LIUS Music System. A Critic found the violations listed under VIOLATIONS in the artifact under ARTIFACT. Propose concrete edits that fix them.',
  '',
  'HOW TO EDIT',
  '- Each edit replaces the value of one field: path is a JSON Pointer to it (e.g. /sections/1/bars/0/text), replacement is the new value.',
  '- Edit only a field a violation points at, or a field inside it. Leave everything else as it is.',
  '- Keep each field’s type: text stays text; for a number or true/false field write the value as JSON (120, true).',
  '- In violationKeys, list the key of every violation the edit fixes, copied exactly from VIOLATIONS.',
  '- Change only what the violation requires; keep the rest of the artifact’s wording and voice.',
  '- Write every word in a single alphabet: never mix Latin and Cyrillic letters inside one word.',
  '- Reply with JSON only, matching the response schema.',
].join('\n');

/**
 * @param ctx - run context (tools: read_critique, read_artifact, write_artifact, log_message)
 * @param input - `{ critiqueId }`
 * @returns `{ status: 'revised', artifact, critiqueId, edits, body }`
 * @throws Error on a bare request, a mix report (studio work), a critique with no violations, refused edits, or a revised body that fails its spec's checks
 */
export const revisionProgram: LlmProgram = async (ctx, input, llm) => {
  const critiqueId = (input as { critiqueId?: unknown } | null)?.critiqueId;
  if (typeof critiqueId !== 'string') throw new Error(`${REVISION_AGENT} revises from one critique: input { critiqueId }`);
  const c = (await ctx.useTool('read_critique', { id: critiqueId })) as CritiqueRow;
  const a = (await ctx.useTool('read_artifact', { id: c.artifactId })) as ArtifactRecord;
  if (a.schemaId === MIX_REPORT_SCHEMA_ID) throw new Error('a mix report measures a render: fixing it is studio work (change the session, render again), not a revision');
  const found = specForSchema(a.schemaId);
  if (!found) throw new Error(`no Creative spec writes ${a.schemaId}: nothing to validate a revision against`);
  const violations = c.body.violations;
  if (violations.length === 0) throw new Error(`critique ${c.id} lists no violation: nothing to revise`);

  const res = await llm.complete({
    system: SYSTEM,
    user: [
      `ARTIFACT ${a.schemaId} v${a.version}\n${JSON.stringify(withoutTrace(a.body))}`,
      `VIOLATIONS\n${JSON.stringify(violations.map(({ key, ruleRef, path, quote, expected, found: f }) => ({ key, ruleRef, path, quote, expected, found: f })))}`,
    ].join('\n\n'),
    schema: { name: REVISION_LLM_SCHEMA_ID, schema: REVISION_LLM_SCHEMA },
    signal: ctx.signal,
  });
  const edits = (res.json as { edits: Edit[] }).edits;
  const body = rederive(a.schemaId, applyEdits(a.schemaId, a.body, edits, violations));
  const script = scriptFindings(found.spec, body);
  const failed = [...(found.spec.check?.(body) ?? []), ...script.refuse];
  if (failed.length > 0) throw new Error(`${REVISION_AGENT}: the revised ${a.schemaId} failed checks: ${failed.join('; ')}`);
  if (script.softMessages.length > 0) await ctx.useTool('log_message', { level: 'warn', message: `${REVISION_AGENT}: written with warnings — ${script.softMessages.join('; ')}` });

  const written = (await ctx.useTool('write_artifact', {
    schemaId: a.schemaId, brief: a.brief, body, contextRefs: a.contextRefs, knowledge: a.knowledge, model: ctx.agent.model,
    parentId: a.id, critiqueId: c.id, warnings: script.warnings,
  })) as { artifact_id: string; lineage_id: string; version: number };
  await ctx.useTool('log_message', { message: `${REVISION_AGENT}: ${a.schemaId} v${a.version} → v${written.version}: ${edits.length} edit(s) for critique ${c.id}` });
  return {
    output: {
      status: 'revised',
      artifact: { id: written.artifact_id, lineageId: written.lineage_id, version: written.version, schemaId: a.schemaId },
      critiqueId: c.id, edits, body,
    } satisfies RevisionOutput,
    tokensUsed: res.usage.inputTokens + res.usage.outputTokens,
  };
};
```

- [ ] **Step 4: Write `agents/x3lius-revision.agent.md`**

```markdown
---
name: x3lius-revision
class: Revision
domain: RECORDS
tools: [read_critique, read_artifact, write_artifact, log_message]
model: openrouter:nvidia/nemotron-3-ultra-550b-a55b:free
---

# X3LIUS Revision

## Role

The Revision agent of the X3LIUS Music System (Phase 12). It works inside the Evaluation sub-domain without being one, as `x3lius-rvc-post` does for Vocal DNA. It answers the Revision class's question, "how should it be corrected?", for one critique written by `x3lius-evaluation` (the Critic). It proposes concrete edits and appends the next version of the artifact. The loop controller (`pnpm evaluate`) then has the Critic judge that version.

## Contract

- **Inputs:** `{ "critiqueId": uuid }`.
- **Outputs:** `{ status: "revised", artifact: { id, lineageId, version, schemaId }, critiqueId, edits: [{ path, replacement, violationKeys }], body }`.
- **Reads:** the critique via `read_critique` (`critique.read`) and the version it reviewed via `read_artifact` (`artifact.read`), both as `xyp_runtime`.
- **Writes:**
  - one `creative_artifacts` row via `write_artifact` (`artifact.write`, as `xyp_creative`). It is the next version of the same lineage, with `parent_id` set to the version reviewed and `critique_id` set to the critique. Brief, context refs and knowledge are copied from the parent.
  - its own `agent_runs` row; run-log lines.
- **Side effects:** one model call.

## Refuses

- Overwriting any artifact version, or marking a critique resolved. Only the Critic does that, on its next pass.
- A mix report: fixing a measured render is studio work.
- The whole revision when any edit:
  - cites no violation of the critique;
  - names no field, or a field code derives (`sources`, the trace, a Suno prompt's lyrics, limits or model);
  - is outside every violated field;
  - changes a field's type, changes nothing, or repeats a field.
- A revised body that fails its spec's checks or puts a mixed-script word in text Suno receives.
```

- [ ] **Step 5: Register the program and list Revision as a sub-domain member**

`core/runtime/programs.ts`: add `import { REVISION_AGENT, revisionProgram } from '../../records/x3lius/evaluation/revision.ts';` and after the Critic entry:

```ts
  // Phase 12: Revision (x3lius-revision), run by the loop controller after each critique.
  [REVISION_AGENT]: revisionProgram,
```

`tests/phase-07/subdomains.test.ts`:

```ts
// Agents that work inside a sub-domain without being one (Phase 10: the Vocal DNA's RVC consumer;
// Phase 12: Evaluation's Revision agent).
const SUBDOMAIN_MEMBERS = ['x3lius-revision', 'x3lius-rvc-post'];
```

(Order matters only if the test compares `registry.list()` order. The registry sorts by name, so `x3lius-revision` comes before `x3lius-rvc-post`.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/phase-12 tests/phase-07 && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add records/x3lius/evaluation/revision.ts agents/x3lius-revision.agent.md core/runtime/programs.ts tests/phase-07/subdomains.test.ts tests/phase-12/critic-revision.test.ts
git commit -m "Phase 12: the Revision agent appends a corrected version naming the critique it answers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Loop controller, escalation, `pnpm evaluate`, and the proof runs

**Files:**
- Create: `records/x3lius/evaluation/loop.ts`, `records/x3lius/evaluation/loop.test.ts`
- Create: `records/x3lius/evaluation/cli.ts`, `core/runtime/deps.ts`
- Create: `tests/helpers/trace-fixture.ts` (the Phase 11 analysis and rubric fixture, shared)
- Modify: `tests/phase-11/mix-master.test.ts` (import the fixture instead of defining it)
- Modify: `package.json` (`"evaluate": "node records/x3lius/evaluation/cli.ts"`)
- Test: `tests/phase-12/critic-revision.test.ts` (append the loop proofs)

**Interfaces:**
- Consumes: `CRITIC_AGENT`, `CriticOutput` (Task 5); `REVISION_AGENT`, `RevisionOutput` (Task 7); `xyp_escalate_critique` (Task 1).
- Produces:
  - `MAX_REVISIONS = 3`, `LOOP_ROLE = 'xyp_evaluation_loop'`
  - types `Pass`, `Decision`, `Outcome`, `LoopResult`
  - `decide(passes, maxRevisions?): Decision`
  - `evaluate(deps: DispatchDeps, artifactId: string, options?: { maxRevisions?: number; timeoutMs?: number }): Promise<LoopResult>`
  - `createRuntimeDeps(sql): DispatchDeps`

- [ ] **Step 1: Write the failing unit test for `decide`**

`records/x3lius/evaluation/loop.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decide, MAX_REVISIONS, type Decision, type Pass } from './loop.ts';

const MIX = 'x3lius.mix-report/v1';
const pass = (violations: number, checked = 5, schemaId = 'x3lius.lyrics/v2'): Pass => ({ critiqueId: 'c', artifactId: 'a', schemaId, checked, violations });
const stop = (outcome: 'converged' | 'no_rules'): Decision => ({ kind: 'stop', outcome });
const escalate = (reason: 'studio_work' | 'iteration_cap' | 'stall'): Decision => ({ kind: 'escalate', reason });
const revise: Decision = { kind: 'revise' };

describe('loop decision after each Critic pass (spec §7, first matching row wins)', () => {
  it('caps revisions at 3', () => expect(MAX_REVISIONS).toBe(3));

  it.each<[string, Pass[], Decision]>([
    ['no rules checked', [pass(0, 0)], stop('no_rules')],
    ['no rules checked, even with a stale count', [pass(2), pass(0, 0)], stop('no_rules')],
    ['clean on the first pass', [pass(0)], stop('converged')],
    ['clean after revisions', [pass(3), pass(1), pass(0)], stop('converged')],
    ['a clean mix report', [pass(0, 4, MIX)], stop('converged')],
    ['a mix report with violations', [pass(2, 4, MIX)], escalate('studio_work')],
    ['violations on the first pass', [pass(2)], revise],
    ['fewer violations after a revision', [pass(3), pass(2)], revise],
    ['the same count after a revision', [pass(2), pass(2)], escalate('stall')],
    ['more violations after a revision', [pass(1), pass(2)], escalate('stall')],
    ['3 revisions made, still violations', [pass(4), pass(3), pass(2), pass(1)], escalate('iteration_cap')],
    ['the cap is checked before the stall rule', [pass(4), pass(3), pass(2), pass(2)], escalate('iteration_cap')],
  ])('%s', (_label, passes, expected) => {
    expect(decide(passes)).toEqual(expected);
  });

  it('takes another cap', () => {
    expect(decide([pass(3), pass(2)], 1)).toEqual(escalate('iteration_cap'));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run records/x3lius/evaluation/loop.test.ts`
Expected: FAIL, because `./loop.ts` does not exist.

- [ ] **Step 3: Write `records/x3lius/evaluation/loop.ts`**

```ts
import type postgres from 'postgres';
import { quoteIdent } from '../../../core/db/client.ts';
import { LLM_TIMEOUT_MS } from '../../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { MIX_REPORT_SCHEMA_ID } from '../creative/schemas.ts';
import { CRITIC_AGENT, type CriticOutput } from './critic.ts';
import { REVISION_AGENT, type RevisionOutput } from './revision.ts';

/**
 * The Phase 12 loop controller: Critic → Revision → Critic … on one artifact lineage, dispatched
 * through the Orchestrator (every run authorized and logged). A service, not an agent: it owns no
 * capability; its role may only queue an escalation (spec §7).
 */

/**
 * At most 3 revisions (so at most 4 Critic passes). Why 3: each round is two model calls, and a
 * call took minutes on the free route in the Phase 9 live runs, so 3 rounds + the final pass is at
 * most 7 calls; three targeted edit rounds that fail to clear the violations are unlikely to be
 * cleared by a fourth, and the stall rule ends a stuck loop sooner. User decision (ARCHITECTURE);
 * changing it is a new flagged decision, never a silent edit.
 */
export const MAX_REVISIONS = 3;
/** The loop's DB role (migration 20260925100000): EXECUTE on xyp_escalate_critique, nothing else. */
export const LOOP_ROLE = 'xyp_evaluation_loop';

export type Pass = { readonly critiqueId: string; readonly artifactId: string; readonly schemaId: string; readonly checked: number; readonly violations: number };
export type Decision =
  | { readonly kind: 'stop'; readonly outcome: 'converged' | 'no_rules' }
  | { readonly kind: 'escalate'; readonly reason: 'studio_work' | 'iteration_cap' | 'stall' }
  | { readonly kind: 'revise' };
export type Outcome = 'converged' | 'no_rules' | 'studio_work' | 'iteration_cap' | 'stall' | 'revision_failed' | 'error';
export type LoopResult = {
  readonly outcome: Outcome;
  readonly revisions: number;
  readonly critiqueIds: readonly string[];
  readonly artifactIds: readonly string[];
  /** Violations per Critic pass, in order. */
  readonly counts: readonly number[];
  readonly escalationId?: string;
  readonly error?: string;
};

/**
 * What to do after a Critic pass: the first matching row of spec §7 wins.
 * @param passes - every pass so far, in order (pass n+1 reviewed the version revision n wrote)
 * @param maxRevisions - the cap (default MAX_REVISIONS)
 * @returns stop, escalate with a reason, or revise
 */
export const decide = (passes: readonly Pass[], maxRevisions = MAX_REVISIONS): Decision => {
  const last = passes.at(-1)!;
  const revisions = passes.length - 1;
  if (last.checked === 0) return { kind: 'stop', outcome: 'no_rules' };
  if (last.violations === 0) return { kind: 'stop', outcome: 'converged' };
  if (last.schemaId === MIX_REPORT_SCHEMA_ID) return { kind: 'escalate', reason: 'studio_work' };
  if (revisions >= maxRevisions) return { kind: 'escalate', reason: 'iteration_cap' };
  if (revisions > 0 && last.violations >= passes.at(-2)!.violations) return { kind: 'escalate', reason: 'stall' };
  return { kind: 'revise' };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The artifact's version and its lineage's latest version, read as xyp_runtime. */
const lineageHead = async (deps: DispatchDeps, artifactId: string) => {
  const rows = (await deps.sql.begin('read only', async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent('xyp_runtime')}`);
    return tx<{ version: number; head_id: string; head_version: number }[]>`
      select a.version, h.id as head_id, h.version as head_version
      from creative_artifacts a
      join lateral (select id, version from creative_artifacts where lineage_id = a.lineage_id order by version desc limit 1) h on true
      where a.id = ${artifactId}`;
  })) as { version: number; head_id: string; head_version: number }[];
  return rows[0];
};

/**
 * Runs the loop on one artifact version until it converges, has no rules to check, or escalates.
 * @param deps - dispatch dependencies (registry, tools, handlers, LLM runner)
 * @param artifactId - the latest version of its lineage
 * @param options - `maxRevisions` (default 3), `timeoutMs` per run (default LLM_TIMEOUT_MS)
 * @returns the outcome, every critique and version in order, violations per pass, and the escalation id when queued
 * @throws Error on a malformed or unknown id, or a version that isn't its lineage's latest (revising it would fork history)
 */
export const evaluate = async (deps: DispatchDeps, artifactId: string, options: { readonly maxRevisions?: number; readonly timeoutMs?: number } = {}): Promise<LoopResult> => {
  if (!UUID.test(artifactId)) throw new Error(`evaluate: ${JSON.stringify(artifactId)} is not an artifact id (a uuid)`);
  const max = options.maxRevisions ?? MAX_REVISIONS;
  const timeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS;
  const head = await lineageHead(deps, artifactId);
  if (!head) throw new Error(`evaluate: no artifact ${artifactId}`);
  if (head.head_id !== artifactId) {
    throw new Error(`evaluate: artifact ${artifactId} is v${head.version}; the latest version of its lineage is ${head.head_id} (v${head.head_version}). Evaluate that one: revising an older version would fork the history.`);
  }

  const passes: Pass[] = [];
  const artifactIds = [artifactId];
  const result = (outcome: Outcome, extra: { escalationId?: string; error?: string } = {}): LoopResult => ({
    outcome, revisions: artifactIds.length - 1, critiqueIds: passes.map((p) => p.critiqueId), artifactIds: [...artifactIds], counts: passes.map((p) => p.violations), ...extra,
  });
  const escalate = async (reason: 'studio_work' | 'iteration_cap' | 'stall' | 'revision_failed', error?: string): Promise<LoopResult> => {
    const request = {
      reason, revisions: artifactIds.length - 1, maxRevisions: max, critiqueIds: passes.map((p) => p.critiqueId), artifactIds, counts: passes.map((p) => p.violations),
      ...(error ? { error } : {}),
    };
    const rows = (await deps.sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${quoteIdent(LOOP_ROLE)}`);
      return tx<{ id: string }[]>`select public.xyp_escalate_critique(${passes.at(-1)!.critiqueId}, ${tx.json(request as postgres.JSONValue)}) as id`;
    })) as { id: string }[];
    return result(reason, { escalationId: rows[0]!.id, ...(error ? { error } : {}) });
  };

  let current = artifactId;
  let previous: string | undefined;
  for (;;) {
    const c = await dispatch(deps, CRITIC_AGENT, { artifactId: current, ...(previous ? { previousCritiqueId: previous } : {}) }, { timeoutMs });
    // A failed Critic run is a system fault, not a creative stall: logged in agent_runs, no queue item.
    if (c.status === 'error') return result('error', { error: c.error ?? 'Critic run failed' });
    const out = c.output as CriticOutput;
    passes.push({ critiqueId: out.critique.id, artifactId: current, schemaId: out.critique.schemaId, checked: out.critique.counts.checked, violations: out.critique.counts.violations });
    previous = out.critique.id;
    const d = decide(passes, max);
    if (d.kind === 'stop') return result(d.outcome);
    if (d.kind === 'escalate') return escalate(d.reason);
    const r = await dispatch(deps, REVISION_AGENT, { critiqueId: previous }, { timeoutMs });
    if (r.status === 'error') return escalate('revision_failed', r.error ?? 'Revision run failed');
    current = (r.output as RevisionOutput).artifact.id;
    artifactIds.push(current);
  }
};
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run records/x3lius/evaluation/loop.test.ts`
Expected: PASS.

- [ ] **Step 5: Share the Phase 11 TRACE fixture**

Create `tests/helpers/trace-fixture.ts` by moving `ANALYSIS` and `RUBRIC` out of `tests/phase-11/mix-master.test.ts` unchanged. The file needs its own `import type { TraceAnalysis } from '../../tech/trace/analysis.ts';` and must export both, with the `// FIXTURE:` comment moved along with them. In `tests/phase-11/mix-master.test.ts`, delete the two constants and add `import { ANALYSIS, RUBRIC } from '../helpers/trace-fixture.ts';`.

Run: `npx vitest run tests/phase-11/mix-master.test.ts`
Expected: PASS (no behaviour change).

- [ ] **Step 6: Append the failing loop proofs**

Add to `tests/phase-12/critic-revision.test.ts`. Imports go at the top:

```ts
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { evaluate } from '../../records/x3lius/evaluation/loop.ts';
import { ANALYSIS, RUBRIC } from '../helpers/trace-fixture.ts';
```

Merge the `node:crypto` import with the existing `createHash` one. Then add at the end of the file:

```ts
describe('loop controller (the proof runs)', () => {
  const escalation = (critiqueId: string) => db.sql<{ item_type: string; status: string; request: Json }[]>`
    select item_type::text, status::text, request from approval_queue where item_type = 'critique_escalation' and item_id = ${critiqueId}`;
  const text = (a: Json, s: number, b: number) => String((((a.sections as Json[])[s]!.bars as Json[])[b]!).text);
  /** Critic: one violation per verse bar 0–3 still holding [FAKE] text. */
  const fakeBars = (a: Json): Reported[] => [0, 1, 2, 3]
    .filter((b) => text(a, 0, b).startsWith('[FAKE]'))
    .map((b) => ({ ruleRef: `canonical_prompts:${rules.lyrics}`, path: `/sections/0/bars/${b}/text`, quote: text(a, 0, b), expected: 'a place in the city', found: 'no place' }));

  it('PROOF 1 — converges: a Suno prompt with a code-found and a model-found violation, fixed by one revision', async () => {
    const model = scripted({
      critic: (a) => (String(a.style).includes('style prompt') ? [{ ruleRef: `canonical_prompts:${rules.suno}`, path: '/style', quote: '[FAKE] style prompt', expected: 'the vocal descriptor first', found: 'a placeholder' }] : []),
      revise: (vs) => [{ path: '/style', replacement: 'male vox', violationKeys: vs.map((x) => x.key) }],
    });
    const r = await evaluate(depsWith(model), prompts.loop, { timeoutMs: 60_000 });
    expect(r).toMatchObject({ outcome: 'converged', revisions: 1, counts: [2, 0] });
    expect(r.escalationId).toBeUndefined();
    const [, second] = await Promise.all(r.critiqueIds.map((id) => db.sql<{ body: { resolved: string[]; previousCritiqueId: string } }[]>`select body from critiques where id = ${id}`.then((x) => x[0]!.body)));
    expect(second!.previousCritiqueId).toBe(r.critiqueIds[0]);
    expect(second!.resolved.sort()).toEqual([`${rules.styleLimit}@/style`, `canonical_prompts:${rules.suno}@/style`].sort());
    expect(await escalation(r.critiqueIds.at(-1)!)).toEqual([]);
  });

  it('PROOF 2 — hits the iteration cap: 4 violations, one fixed per revision, escalated after 3', async () => {
    const l = await lyrics();
    const model = scripted({
      critic: fakeBars,
      revise: (vs) => [{ path: vs[0]!.path, replacement: `Neon rain on Canal Street, ${vs[0]!.path.split('/')[4]}`, violationKeys: [vs[0]!.key] }],
    });
    const r = await evaluate(depsWith(model), l.id, { timeoutMs: 60_000 });
    expect(r).toMatchObject({ outcome: 'iteration_cap', revisions: 3, counts: [4, 3, 2, 1] });
    expect(r.artifactIds).toHaveLength(4);
    const [row] = await escalation(r.critiqueIds.at(-1)!);
    expect(row).toMatchObject({ item_type: 'critique_escalation', status: 'pending', request: { reason: 'iteration_cap', revisions: 3, maxRevisions: 3, counts: [4, 3, 2, 1], critiqueIds: r.critiqueIds, artifactIds: r.artifactIds } });
    expect(r.escalationId).toBeDefined();
  });

  it('stalls: a revision that does not reduce the violations escalates early', async () => {
    const l = await lyrics();
    const model = scripted({
      critic: (a) => [{ ruleRef: `canonical_prompts:${rules.lyrics}`, path: '/sections/0/bars/0/text', quote: text(a, 0, 0), expected: 'a place', found: 'none' }],
      revise: (vs, a) => [{ path: vs[0]!.path, replacement: `${text(a, 0, 0)} again`, violationKeys: [vs[0]!.key] }],
    });
    const r = await evaluate(depsWith(model), l.id, { timeoutMs: 60_000 });
    expect(r).toMatchObject({ outcome: 'stall', revisions: 1, counts: [1, 1] });
    expect((await escalation(r.critiqueIds.at(-1)!))[0]?.request).toMatchObject({ reason: 'stall' });
  });

  it('escalates a refused revision, with the error, and writes no version', async () => {
    const l = await lyrics();
    const model = scripted({ critic: fakeBars, revise: (vs) => [{ path: '/sections/1/bars/0/text', replacement: 'Canal Street', violationKeys: [vs[0]!.key] }] });
    const r = await evaluate(depsWith(model), l.id, { timeoutMs: 60_000 });
    expect(r).toMatchObject({ outcome: 'revision_failed', revisions: 0, counts: [4], artifactIds: [l.id] });
    expect(r.error).toMatch(/is not at or inside a field a violation points to/);
    expect((await escalation(r.critiqueIds[0]!))[0]?.request).toMatchObject({ reason: 'revision_failed', error: expect.stringMatching(/revision refused/) });
  });

  it('a mix report is studio work: critiqued by code, escalated, never revised', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase12-'));
    const path = join(dir, 'mix-rubric.yaml');
    writeFileSync(path, RUBRIC());
    const ing = await ingestSource(db.sql, { kind: 'file', path, origin: 'first_party' });
    expect(ing.status, ing.error).toBe('success');
    const report = await run('x3lius-mix-master', { analysis: ANALYSIS });
    expect(report.status, report.error).toBe('success');
    const model = scripted({});
    const r = await evaluate(depsWith(model), (report.output as Written).artifact.id, { timeoutMs: 60_000 });
    expect(r).toMatchObject({ outcome: 'studio_work', revisions: 0, counts: [3] });
    expect(model.calls).toEqual([]); // code only: no model call
    expect((await escalation(r.critiqueIds[0]!))[0]?.request).toMatchObject({ reason: 'studio_work' });
    expect((await run('x3lius-revision', { critiqueId: r.critiqueIds[0] })).error).toMatch(/studio work/);
  });

  it('refuses a malformed id, an unknown id, and a version that is not its lineage’s latest, before any run', async () => {
    await expect(evaluate(depsWith(), 'not-a-uuid')).rejects.toThrow(/is not an artifact id \(a uuid\)/);
    await expect(evaluate(depsWith(), randomUUID())).rejects.toThrow(/no artifact/);
    await expect(evaluate(depsWith(), prompts.loop)).rejects.toThrow(/the latest version of its lineage is .* Evaluate that one/);
  });
});
```

`[3]` for the mix report matches the Phase 11 fixture: 4 bounded metrics, 3 to move. The last test relies on PROOF 1 having revised `prompts.loop`; vitest runs the tests in a file in order.

- [ ] **Step 7: Write `core/runtime/deps.ts`, the CLI, and the script**

`core/runtime/deps.ts`:

```ts
import { join } from 'node:path';
import { createAgentRegistry } from '../agent-registry/registry.ts';
import type { Sql } from '../db/client.ts';
import type { DispatchDeps } from '../orchestrator/dispatch.ts';
import { HANDLERS } from './handlers.ts';
import { createRuntimeLlmRunner } from './programs.ts';
import { createRuntimeTools } from './tools.ts';

/**
 * The live dispatch dependencies for a CLI: agents/ registry, the runtime tools, deterministic
 * handlers and the LLM runner (provider keys from the environment).
 * @param sql - pool the tools run through
 * @returns deps for dispatch / evaluate
 */
export const createRuntimeDeps = (sql: Sql): DispatchDeps => ({
  sql,
  registry: createAgentRegistry({ dir: join(import.meta.dirname, '..', '..', 'agents') }),
  tools: createRuntimeTools({ sql }),
  handlers: HANDLERS,
  llmRunner: createRuntimeLlmRunner(),
});
```

`records/x3lius/evaluation/cli.ts`:

```ts
import { connect } from '../../../core/db/client.ts';
import { createRuntimeDeps } from '../../../core/runtime/deps.ts';
import { evaluate } from './loop.ts';

// Usage: pnpm evaluate <artifactId>
// Runs the Phase 12 loop on the latest version of an artifact: Critic → Revision → Critic … until it
// converges, has no rules to check, or is queued for a human (decide with pnpm gate queue / decide).

const [artifactId] = process.argv.slice(2);
if (!artifactId) {
  console.error('usage: evaluate <artifactId>');
  process.exit(2);
}
const sql = connect(undefined, { max: 2 });
try {
  const r = await evaluate(createRuntimeDeps(sql), artifactId);
  r.critiqueIds.forEach((id, i) => console.log(`pass ${i + 1}: artifact ${r.artifactIds[i] ?? r.artifactIds.at(-1)} → critique ${id}: ${r.counts[i]} violation(s)`));
  console.log(`outcome: ${r.outcome}${r.escalationId ? ` — queued for a human as approval ${r.escalationId} (pnpm gate queue / pnpm gate decide)` : ''}${r.error ? ` — ${r.error}` : ''}`);
  console.log(JSON.stringify(r, null, 2));
  if (r.outcome === 'error') process.exitCode = 1;
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
```

`package.json` `scripts`: add `"evaluate": "node records/x3lius/evaluation/cli.ts",` after `"gate"`, and add a trailing comma to the `"gate"` line.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/phase-12 records/x3lius/evaluation tests/phase-11 && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add records/x3lius/evaluation/loop.ts records/x3lius/evaluation/loop.test.ts records/x3lius/evaluation/cli.ts core/runtime/deps.ts tests/helpers/trace-fixture.ts tests/phase-11/mix-master.test.ts package.json tests/phase-12/critic-revision.test.ts
git commit -m "Phase 12: loop controller (cap 3, stall rule, escalation), pnpm evaluate, both proof runs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Phase 6C scoring through the Critic; Phase 9 marker

**Files:**
- Create: `records/x3lius/evaluation/scorer.ts`, `records/x3lius/evaluation/scorer.test.ts`
- Modify: `research-intelligence/experiments/engine.ts` (async scorer; scoring method passed in)
- Modify: `research-intelligence/cli.ts` (the Critic scorer for design and trial)
- Modify: `records/x3lius/suno/score-hook.ts` (marker `stub:needs-trace-analysis`)
- Test: `tests/phase-12/critic-revision.test.ts` (append a 6C block)

**Interfaces:**
- Consumes: `CRITIC_AGENT`, `CriticOutput` (Task 5); `createRuntimeDeps` (Task 8).
- Produces:
  - `CRITIC_SCORER_ID = 'critic:x3lius-evaluation'`
  - `scoreOf({ checked, passed }): number | null` (rounded to 4 decimals, like `experiment_runs.score numeric(5,4)`)
  - `criticScorer(deps: DispatchDeps): TrialScorer`
  - `TrialScorer.score` now returns `Promise<{ score: number | null; inputs: Record<string, unknown> }>`
  - `designExperiment(sql, input, scoringMethod = stubScorer.id)`

- [ ] **Step 1: Write the failing unit and integration tests**

`records/x3lius/evaluation/scorer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { scoreOf } from './scorer.ts';

describe('trial score = rules passed / rules checked (spec §8)', () => {
  it('is the share of rules with no violation, to 4 decimals like experiment_runs.score', () => {
    expect(scoreOf({ checked: 4, passed: 3 })).toBe(0.75);
    expect(scoreOf({ checked: 3, passed: 2 })).toBe(0.6667);
    expect(scoreOf({ checked: 5, passed: 5 })).toBe(1);
    expect(scoreOf({ checked: 5, passed: 0 })).toBe(0);
  });

  it('is null, never 1, when no rule was checked', () => {
    expect(scoreOf({ checked: 0, passed: 0 })).toBeNull();
  });
});
```

Append to `tests/phase-12/critic-revision.test.ts`. Imports go at the top:

```ts
import { designExperiment, experimentResult, recordTrial } from '../../research-intelligence/experiments/engine.ts';
import { CRITIC_SCORER_ID, criticScorer, scoreOf } from '../../records/x3lius/evaluation/scorer.ts';
```

Then at the end of the file:

```ts
describe('6C: experiment trials scored by the Critic (the stub is gone from the path)', () => {
  it('scores passed / checked from a real critique; a trial naming no artifact gets null with the reason', async () => {
    const l = await lyrics();
    const scorer = criticScorer(depsWith(scripted({ critic: (a) => [{ ruleRef: `canonical_prompts:${rules.lyrics}`, path: '/sections/0/bars/0/text', quote: String(((a.sections as Json[])[0]!.bars as Json[])[0]!.text), expected: 'a place', found: 'none' }] })));
    expect(await scorer.score({ take: 'recorded by hand' })).toEqual({ score: null, inputs: { reason: 'the trial output names no artifactId: nothing for the Critic to check' } });
    const s = await scorer.score({ artifactId: l.id });
    const [c] = await critiqueRow((s.inputs as { critiqueId: string }).critiqueId);
    expect(s.score).toBe(scoreOf(c!));
    expect(s.inputs).toMatchObject({ passed: c!.passed, checked: c!.checked, violations: 1 });
  });

  it('an experiment whose every trial the Critic scored can validate', async () => {
    const src = await registerResearchSource(db.sql, {
      researchRunId, kind: 'observation', uri: 'fixture:phase-12/experiment', title: '[FIXTURE] experiment candidate',
      contentSha256: createHash('sha256').update('fixture\nphase-12 experiment').digest('hex'),
    });
    const ev = await writeEvidence(db.sql, { researchRunId, agentRunId: null, specialist: 'fixture:phase-12-test' }, {
      research_source_id: src.id, claim: '[FIXTURE] Name a street in every bar.', model_tag: 'model-agnostic', confidence: 0.7,
      confidence_inputs: { basis: 'synthetic fixture for the Phase 12 proof' }, claim_topic: 'fixture.x3lius-street-per-bar', claim_value: 'street',
    });
    const f = await recordFinding(db.sql, { researchRunId, claim: '[FIXTURE] Name a street in every bar.', claim_topic: 'fixture.x3lius-street-per-bar', claim_value: 'street', model_tag: 'model-agnostic', evidenceIds: [ev] });
    const candidateId = await proposeCandidate(db.sql, {
      findingId: f.findingId, proposed_kind: 'canonical_prompt', target_slug: 'fixture-phase-12-experiment', title: '[FIXTURE] street per bar',
      body: '[FIXTURE — synthetic, Phase 12 proof] Name a street in every bar.', domain: 'RECORDS', tags: ['x3lius-lyrics'],
    });
    const exp = await designExperiment(db.sql, { candidateId, hypothesis: '[FIXTURE] street names raise rule compliance', variantA: { rule: 'current' }, variantB: { rule: 'street per bar' }, nPerVariant: 1 }, CRITIC_SCORER_ID);
    const scorer = criticScorer(depsWith(scripted({})));
    await recordTrial(db.sql, { experimentId: exp, variant: 'a', trial: 1, output: { artifactId: (await lyrics()).id } }, scorer);
    await recordTrial(db.sql, { experimentId: exp, variant: 'b', trial: 1, output: { artifactId: (await lyrics()).id } }, scorer);
    expect(await experimentResult(db.sql, exp)).toMatchObject({ validated: true, scoredBy: [CRITIC_SCORER_ID] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run records/x3lius/evaluation/scorer.test.ts tests/phase-12/critic-revision.test.ts -t "6C|trial score"`
Expected: FAIL, because `./scorer.ts` does not exist.

- [ ] **Step 3: Write `records/x3lius/evaluation/scorer.ts`**

```ts
import { LLM_TIMEOUT_MS } from '../../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import type { TrialScorer } from '../../../research-intelligence/experiments/engine.ts';
import { CRITIC_AGENT, type CriticOutput } from './critic.ts';

/** The 6C scoring method once the Critic exists (Phase 12). */
export const CRITIC_SCORER_ID = 'critic:x3lius-evaluation';

/**
 * Trial score = rules passed / rules checked (user decision, spec §8), rounded to 4 decimals as
 * experiment_runs.score (numeric(5,4)) stores it.
 * @returns the score, or null when no rule was checked (never 1 for "nothing to check")
 */
export const scoreOf = (c: { readonly checked: number; readonly passed: number }): number | null =>
  c.checked === 0 ? null : Math.round((c.passed / c.checked) * 10_000) / 10_000;

/**
 * The Critic-backed 6C scorer: one Critic pass (no revision) on the artifact a trial names.
 * A trial with no artifactId, a failed Critic run or zero rules checked scores null with the reason.
 * @param deps - dispatch dependencies
 * @returns the TrialScorer recordTrial takes
 */
export const criticScorer = (deps: DispatchDeps): TrialScorer => ({
  id: CRITIC_SCORER_ID,
  score: async (output) => {
    const artifactId = (output as { artifactId?: unknown } | null)?.artifactId;
    if (typeof artifactId !== 'string') return { score: null, inputs: { reason: 'the trial output names no artifactId: nothing for the Critic to check' } };
    const r = await dispatch(deps, CRITIC_AGENT, { artifactId }, { timeoutMs: LLM_TIMEOUT_MS });
    if (r.status === 'error') return { score: null, inputs: { reason: `the Critic run failed: ${r.error}`, agentRunId: r.runId } };
    const { id: critiqueId, counts } = (r.output as CriticOutput).critique;
    const score = scoreOf(counts);
    return score === null
      ? { score, inputs: { reason: 'no canonical rule applies to this artifact (0 checked)', critiqueId } }
      : { score, inputs: { critiqueId, passed: counts.passed, checked: counts.checked, violations: counts.violations } };
  },
});
```

- [ ] **Step 4: Make the engine's scorer async and let the caller name the scoring method**

In `research-intelligence/experiments/engine.ts`:
1. Change the `TrialScorer.score` type to `readonly score: (output: unknown) => Promise<{ readonly score: number | null; readonly inputs: Record<string, unknown> }>;`.
2. Make `stubScorer.score` async: `score: async () => ({ score: null, inputs: { reason: 'no evaluator until Phase 12 (Critic); recorded, not scored' } }),`, and change its comment to `/** The pre-Phase-12 stub: kept only as an explicit argument for tests; live paths use the Critic scorer. */`.
3. Update the header comment: `Scoring runs through the Phase 12 Critic (records/x3lius/evaluation/scorer.ts); a stub-scored experiment is never reported as validated, and never carries a fake score.`
4. `designExperiment`: add a third parameter `scoringMethod: string = stubScorer.id` and insert `${scoringMethod}` instead of `${stubScorer.id}`. Add `@param scoringMethod - the scorer id trials will use (the research CLI passes the Critic's)` to its JSDoc.
5. `recordTrial`: score **before** opening the insert transaction, because a Critic run can take minutes and must not hold a transaction open. Replace the whole function (keep its JSDoc, updating `@param scorer` to "defaults to the stub; live paths pass the Critic scorer") with:

```ts
export const recordTrial = async (
  sql: Sql,
  input: { readonly experimentId: string; readonly variant: 'a' | 'b'; readonly trial: number; readonly output: unknown },
  scorer: TrialScorer = stubScorer,
): Promise<void> => {
  const check = async (tx: postgres.TransactionSql) => {
    const [exp] = await tx<{ n_per_variant: number }[]>`select n_per_variant from experiments where id = ${input.experimentId}`;
    if (!exp) throw new Error(`unknown experiment ${input.experimentId}`);
    if (input.trial < 1 || input.trial > exp.n_per_variant) throw new Error(`trial must be in 1..${exp.n_per_variant}`);
    return exp.n_per_variant;
  };
  await asRole(sql, VERIFIER_ROLE, check);
  const s = await scorer.score(input.output);
  await asRole(sql, VERIFIER_ROLE, async (tx) => {
    const n = await check(tx);
    await tx`
      insert into experiment_runs (experiment_id, variant, trial, output, score, score_inputs, scored_by)
      values (${input.experimentId}, ${input.variant}, ${input.trial}, ${tx.json(input.output as postgres.JSONValue)},
              ${s.score}, ${tx.json(s.inputs as postgres.JSONValue)}, ${scorer.id})`;
    const [c] = await tx<{ n: number }[]>`select count(*)::int as n from experiment_runs where experiment_id = ${input.experimentId}`;
    const status = c!.n >= n * 2 ? 'complete' : 'running';
    await tx`
      update experiments set status = ${status}, completed_at = ${status === 'complete' ? new Date() : null}
      where id = ${input.experimentId}`;
  });
};
```

In `research-intelligence/cli.ts`:
- add the imports `import { createRuntimeDeps } from '../core/runtime/deps.ts';` and `import { CRITIC_SCORER_ID, criticScorer } from '../records/x3lius/evaluation/scorer.ts';`;
- `experiment:design` → `designExperiment(sql, json(arg1) as never, CRITIC_SCORER_ID)`;
- `experiment:trial` → `await recordTrial(sql, json(arg1) as never, criticScorer(createRuntimeDeps(sql)))`;
- update the usage comment for `experiment:trial`: `output` must hold `{ "artifactId": "<creative artifact uuid>" }` to be scored; anything else is recorded with score null and the reason.

- [ ] **Step 5: Rename the Phase 9 take-scoring stub marker**

In `records/x3lius/suno/score-hook.ts`:

```ts
/**
 * The take → scoring hook (Phase 9). A take is audio; the Phase 12 Critic reads structured
 * artifacts, so an honest take score needs a trace.analysis/v1 of the render (Phase 14's TRACE
 * integration). Until then every captured take gets one STUB take_scores row: it marks where that
 * scorer plugs in and carries no number (is_stub, score null — the table refuses a stub with a
 * score). Rows written before Phase 12 keep their old marker, stub:phase-12-critic; rows are never
 * rewritten.
 */
export const STUB_SCORER = 'stub:needs-trace-analysis';
```

and change the note in `recordStubScores` to `{ note: 'STUB: no take scoring until a TRACE analysis of the render exists (Phase 14). This row marks the hook, not a judgement.', phase: 14 }`.

Then run `grep -rn "stub:phase-12-critic\|phase: 12" tests records docs --include=*.ts` and update any test asserting the old literal to use the constant `STUB_SCORER` or the new text.

- [ ] **Step 6: Run the tests to verify they pass, including the old 6C/6D paths**

Run: `npx vitest run records/x3lius/evaluation tests/phase-12 tests/phase-06c tests/phase-06d tests/phase-09 && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add records/x3lius/evaluation/scorer.ts records/x3lius/evaluation/scorer.test.ts research-intelligence/experiments/engine.ts research-intelligence/cli.ts records/x3lius/suno/score-hook.ts tests
git commit -m "Phase 12: 6C trials scored by the Critic (passed / checked); take scoring flagged for TRACE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Mutation check, proof log, docs and handoff

**Files:**
- Create: `docs/proofs/PHASE-12-critic-revision.txt`, `docs/handoffs/PHASE-12.md`
- Modify: `docs/SCHEMA.md`, `docs/ARCHITECTURE.md`, `README.md`

- [ ] **Step 1: Full suite and typecheck**

Run: `npx vitest run 2>&1 | tail -5 && npx tsc --noEmit -p .`
Expected: every test passes except, until PR #7 merges, `tests/phase-03/context-engine.test.ts > adds 1-hop graph neighbours…`. Record the exact counts.

- [ ] **Step 2: Mutation check (each mutation must fail at least one test; revert after each)**

For each row: apply the change by hand, run the named tests and confirm a failure, then `git checkout -- <file>`.

| # | File | Mutation | Tests |
|---|---|---|---|
| 1 | `loop.ts` | delete the stall line in `decide` | `records/x3lius/evaluation/loop.test.ts` |
| 2 | `loop.ts` | `revisions >= maxRevisions` → `revisions > maxRevisions` | `loop.test.ts` |
| 3 | `loop.ts` | move the mix-report row below the cap row | `loop.test.ts` |
| 4 | `verify.ts` | drop the quote check (`|| !stringsIn…`) | `verify.test.ts` |
| 5 | `edits.ts` | drop the `isAtOrUnder` targeting check | `edits.test.ts` |
| 6 | `edits.ts` | return `false` from `isDerived` | `edits.test.ts` |
| 7 | `critic.ts` | delete the previous-critique parent check | `tests/phase-12/critic-revision.test.ts -t Critic` |
| 8 | `scorer.ts` | `c.checked === 0 ? null` → `c.checked === 0 ? 1` | `scorer.test.ts` |
| 9 | migration | `raise exception` in `xyp_critiques_chain` → `return new` | `tests/phase-12/critiques-db.test.ts` |

- [ ] **Step 3: Write the proof log**

`docs/proofs/PHASE-12-critic-revision.txt`. Follow the format of `docs/proofs/PHASE-11-production-mix.txt`: a header line, "Produced with the repo's own commands against the local Postgres; every DB test runs in its own throwaway database.", then:
- `## 0. Status of the guide's deliverables`: two agents, the loop controller with cap 3 and its justification, both proof runs, the 6C scorer, the 5-bullet handoff.
- `## 1. Tests`: the `✓` lines from `npx vitest run tests/phase-12 records/x3lius/evaluation --reporter=verbose`.
- `## 2. Proof runs`: for PROOF 1 and PROOF 2, the outcome, the counts per pass and the escalation request, taken from the test assertions.
- `## 3. Mutations`: the table from Step 2 with the result of each.
- `## 4. Full suite`: the counts from Step 1.

- [ ] **Step 4: Update the docs**

- `docs/SCHEMA.md`:
  - a `critiques` entry (columns, the chain trigger, immutability, grants);
  - `creative_artifacts.critique_id` and its trigger;
  - `xyp_escalate_critique` and its roles;
  - `critique.read`;
  - the new `take_scores` marker.
- `docs/ARCHITECTURE.md`:
  - Find the last flag with `grep -n '^\*\*F[0-9]' docs/ARCHITECTURE.md | tail -1`.
  - Append flags D1–D5 from the spec as the next numbers, each `DECIDED (user, Phase 12)`, with the chosen and rejected options in bullets, following F21 and F22's style.
  - In F14, add: `- Phase 12: trials are scored by the Critic (passed / checked); the auto-approve path can now fire.`
  - Add a flag for take scoring waiting on TRACE (Phase 14).
  - Add a flag for escalation decisions being recorded only until Phase 15/16.
  - In F8's line, note that `critique_escalation` is now written by the loop (Phase 12).
- `README.md`: `- [ ] Phase 12: Critic + Revision System` → `- [x] Phase 12: Critic + Revision System`.

- [ ] **Step 5: Write the handoff**

`docs/handoffs/PHASE-12.md`, in the same shape as `docs/handoffs/PHASE-11.md`:
- **Delivered:** agents, tables, tools, loop, scorer, proof log.
- **Key decisions (user):** D1–D5.
- **Deviations from spec:**
  - specs found by schema id;
  - optional versions;
  - Suno lyrics derived;
  - Phase 7 stub proofs moved to a registry double;
  - `read_artifact` returns more fields.
- **Open flags:**
  - escalation decisions are only recorded;
  - no structural edits;
  - no live-model run;
  - take scoring waits on TRACE;
  - the Phase 3 test fix is in PR #7.
- **Next phase needs (13):** exactly 5 bullets.
  1. Records ops (catalog, releases, rights splits) is the F10 decision left open. Its "Knowledge/Execution" agents need the same single-class split Phase 11 used.
  2. Records ops capabilities (catalog, rights) are undefined. Add them to the matrix and doc in Phase 13, never implicitly.
  3. `approval_queue` now carries two item types. Governance and the Phase 15 API must render `critique_escalation` requests (reason, version chain, counts).
  4. F14 auto-approve can now fire from Critic-scored experiments. Watch the first auto-approvals.
  5. The Critic's code checks are a table keyed by claim topic. A Records rule with a structured value (e.g. split percentages summing to 100) is a new row, not a new checker.

- [ ] **Step 6: Commit**

```bash
git add docs README.md
git commit -m "Phase 12: proof log, handoff, SCHEMA / ARCHITECTURE / README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
