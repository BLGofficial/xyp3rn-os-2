# Phase 13 — XYP3RN Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Records business layer — releases, tracks, rights splits (always 100, DB-enforced), a general audit log, three deterministic agents (catalog, rights-splits, release-calendar), and operator-approved scheduling.

**Architecture:** One migration carries every rule as a DB constraint or trigger, so direct writes can't bypass them. Agents are `model: none` handlers that act only through four new tools, each running under its own `xyp_*` role. Scheduling is proposed by an agent and applied only after the operator's decision on `approval_queue`.

**Tech Stack:** TypeScript on Node 25 (native TS), postgres.js, Postgres 16 (local, `127.0.0.1`), vitest, `yaml`.

**Spec:** `docs/superpowers/specs/2026-09-25-phase-13-records-design.md`

## Global Constraints

- Branch `claude/phase-13` (cut from `claude/phase-12`). Worktree: `.claude/worktrees/admiring-wilson-72de29`.
- Migration file: `supabase/migrations/20260925110000_records.sql`; rollback `supabase/rollbacks/20260925110000_records.down.sql`. Idempotent, no CASCADE in the rollback. Do **not** run `pnpm db:up` against the dev DB until Task 8; tests build throwaway DBs.
- Splits: `numeric(5,2)`, `> 0 and <= 100`; per track exactly `100.00` at commit when any split exists; payee literal `UNASSIGNED` = unknown share.
- Named errors (message prefix, exactly): `rights_splits_sum_not_100`, `release_not_schedulable`, `splits_locked_after_schedule`, `release_status_transition`, `release_locked`, `track_locked`.
- Status path: `draft → pending_schedule | cancelled`; `pending_schedule → scheduled | draft | cancelled`; `scheduled → released | cancelled`; `released`, `cancelled` terminal.
- ISRC: `^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$`, unique when set. UPC: `^[0-9]{12,13}$`, unique when set.
- Agents: `records-catalog` (Execution), `records-rights-splits` (Governance), `records-release-calendar` (Execution); domain `RECORDS`; `model: none`.
- New capabilities: `records.read` (Execution, Governance, Planning), `catalog.write` (Execution), `schedule.propose` (Execution). Added to `core/tool-registry/capabilities.ts` **and** `docs/AGENT_CLASSES.md` (tests/phase-04c checks they match).
- Typecheck: `..\..\..\node_modules\.bin\tsc.cmd --noEmit -p .` (the worktree has no local `tsc`). Tests: `npx vitest run <path>`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit from Bash with a heredoc (`git commit -F -`); PowerShell here-strings split on quotes.

### Spec amendments (found while planning; state them in the handoff)

1. **`release_schedule_requests`** (new table): `approval_queue` is `unique (item_type, item_id)`, so using the release id as `item_id` would make a rejected release impossible to re-queue. Each request is a row; its id is the queue `item_id`.
2. **Locks outside `draft`:** a release that is not `draft` may change only `status`, `upc` and `updated_at` (else `release_locked`); its tracks may change only `isrc` and `updated_at`, and none may be added or removed (else `track_locked`). Without this, a track or date could change after the operator approved.

## Review Focus

1. A release rejected by the operator is re-queued later → a second request must succeed (amendment 1). Test in Task 3.
2. Adding a track, changing a date or a track's audio after `pending_schedule` → refused, but assigning an ISRC or UPC then → allowed. Test in Task 3.
3. Thirds: splits `33.33 + 33.33 + 33.34` → exactly 100, accepted; `33.33 × 3` → refused. Test in Task 2.
4. Applying a decision twice, or applying a still-pending item → refused, release unchanged. Test in Task 3.
5. A splits file with `"50%"`, three decimals, a negative, or an unknown role → refused by the file parser with the field named, before any DB write. Test in Task 7.

---

### Task 1: Records tables, links and `audit_log`

**Files:**
- Create: `supabase/migrations/20260925110000_records.sql`
- Create: `supabase/rollbacks/20260925110000_records.down.sql`
- Create: `tests/helpers/records-fixture.ts`
- Test: `tests/phase-13/records-db.test.ts`

**Interfaces:**
- Produces: tables `releases`, `tracks`, `rights_splits`, `audit_log`; enums `release_kind`, `release_status`, `split_role`; fixture `seedCreative(sql) → { runId, lyricsId, promptId, mixReportId, takeId }` and `seedRelease(sql, opts) → { releaseId, trackIds }`.

- [ ] **Step 1: Write the fixture helper**

```ts
// tests/helpers/records-fixture.ts
import type { Sql } from '../../core/db/client.ts';

/** Seeds, as the test superuser, the Phase 8-11 rows a track can point at. */
export const seedCreative = async (sql: Sql) => {
  const [run] = await sql<{ id: string }[]>`
    insert into agent_runs (agent_name, class, domain, input) values ('records-fixture', 'Execution', 'RECORDS', '{}') returning id`;
  const art = async (schemaId: string, body: object) => (await sql<{ id: string }[]>`
    insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model)
    values (${schemaId}, 'records-fixture', ${run!.id}, '[FIXTURE]', ${sql.json(body)}, '[]', '{}', 'none') returning id`)[0]!.id;
  const lyricsId = await art('x3lius.lyrics/v2', { sections: [] });
  const promptId = await art('x3lius.suno-prompt/v1', { title: '[FIXTURE]' });
  const mixReportId = await art('x3lius.mix-report/v1', { checks: [] });
  const [sub] = await sql<{ id: string }[]>`
    insert into suno_submissions (formula_artifact_id, agent_run_id, adapter, suno_model, prompt)
    values (${promptId}, ${run!.id}, 'manual', 'v5', ${sql.json({ title: 't', style: 's', excludeStyles: [], lyrics: 'l' })}) returning id`;
  const [take] = await sql<{ id: string }[]>`
    insert into suno_takes (submission_id, agent_run_id, audio_url, duration_seconds)
    values (${sub!.id}, ${run!.id}, ${`https://cdn.example.test/${crypto.randomUUID()}.mp3`}, 187) returning id`;
  return { runId: run!.id, lyricsId, promptId, mixReportId, takeId: take!.id };
};

export const SHA = 'a'.repeat(64);

/**
 * A draft release with `tracks` studio-master tracks and, when `splits` is given, those splits on
 * every track (committed, so the always-100 trigger runs).
 */
export const seedRelease = async (
  sql: Sql,
  opts: { tracks?: number; splits?: { payee: string; role: string; percentage: number }[]; releaseDate?: string } = {},
) => {
  const [r] = await sql<{ id: string }[]>`
    insert into releases (title, kind, release_date) values ('[FIXTURE] release', 'single', ${opts.releaseDate ?? null}) returning id`;
  const trackIds: string[] = [];
  for (let i = 1; i <= (opts.tracks ?? 1); i++) {
    const [t] = await sql<{ id: string }[]>`
      insert into tracks (release_id, position, title, master_uri, master_sha256)
      values (${r!.id}, ${i}, ${`[FIXTURE] track ${i}`}, ${`file:///masters/${i}.wav`}, ${SHA}) returning id`;
    trackIds.push(t!.id);
  }
  if (opts.splits) {
    await sql.begin(async (tx) => {
      for (const t of trackIds) for (const s of opts.splits!) {
        await tx`insert into rights_splits (track_id, payee, role, percentage) values (${t}, ${s.payee}, ${s.role}::split_role, ${s.percentage})`;
      }
    });
  }
  return { releaseId: r!.id, trackIds };
};
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/phase-13/records-db.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRole, createTestDb, expectPgError, type TestDb } from '../helpers/db.ts';
import { seedCreative, seedRelease, SHA } from '../helpers/records-fixture.ts';

// Phase 13 proof (part 1): the Records tables, their links to Phase 8-11 rows, and audit_log.
let db: TestDb;
let fx: Awaited<ReturnType<typeof seedCreative>>;

beforeAll(async () => {
  db = await createTestDb('phase13_records', { migrated: true });
  fx = await seedCreative(db.sql);
});
afterAll(async () => db?.drop());

const track = (releaseId: string, cols: Record<string, unknown>) =>
  db.sql`insert into tracks ${db.sql({ release_id: releaseId, position: 1, title: 't', ...cols })} returning id`;

describe('tracks: one audio source, real links', () => {
  it('accepts a Suno take or a studio master, never both or neither', async () => {
    const { releaseId } = await seedRelease(db.sql, { tracks: 0 });
    await track(releaseId, { suno_take_id: fx.takeId, artifact_ids: [fx.lyricsId, fx.promptId] });
    await track(releaseId, { position: 2, master_uri: 'file:///m.wav', master_sha256: SHA, mix_report_id: fx.mixReportId });
    await expectPgError(() => track(releaseId, { position: 3 }), '23514');
    await expectPgError(() => track(releaseId, { position: 3, suno_take_id: fx.takeId, master_uri: 'file:///m.wav', master_sha256: SHA }), '23514');
    await expectPgError(() => track(releaseId, { position: 3, master_uri: 'file:///m.wav' }), '23514');
  });

  it('refuses an unknown artifact id and a mix report that is not one', async () => {
    const { releaseId } = await seedRelease(db.sql, { tracks: 0 });
    await expectPgError(() => track(releaseId, { suno_take_id: fx.takeId, artifact_ids: [crypto.randomUUID()] }), '23503');
    const e = await expectPgError(() => track(releaseId, { suno_take_id: fx.takeId, mix_report_id: fx.lyricsId }), '23514');
    expect(e.message).toMatch(/not x3lius\.mix-report\/v1/);
  });

  it('checks ISRC and UPC formats, unique when set, null until assigned', async () => {
    const { releaseId, trackIds } = await seedRelease(db.sql);
    await db.sql`update tracks set isrc = 'USRC17607839' where id = ${trackIds[0]!}`;
    await expectPgError(() => db.sql`update tracks set isrc = 'US-RC1-76-07839' where id = ${trackIds[0]!}`, '23514');
    await expectPgError(() => db.sql`update releases set upc = '12345' where id = ${releaseId}`, '23514');
    const other = await seedRelease(db.sql);
    await expectPgError(() => db.sql`update tracks set isrc = 'USRC17607839' where id = ${other.trackIds[0]!}`, '23505');
  });
});

describe('audit_log', () => {
  it('records every insert, update and delete on the Records tables, with the acting role', async () => {
    const { releaseId } = await seedRelease(db.sql);
    await db.sql`update releases set title = 'renamed' where id = ${releaseId}`;
    const rows = await db.sql<{ table_name: string; op: string; actor: string }[]>`
      select table_name, op, actor from audit_log where row_id = ${releaseId} order by id`;
    expect(rows.map((r) => [r.table_name, r.op])).toEqual([['releases', 'insert'], ['releases', 'update']]);
    expect(rows[0]!.actor).toBe('postgres');
  });

  it('is append-only for every role, owner included', async () => {
    const [a] = await db.sql<{ id: string }[]>`select id from audit_log limit 1`;
    await expectPgError(() => db.sql`update audit_log set op = 'x' where id = ${a!.id}`, '55000');
    await expectPgError(() => db.sql`delete from audit_log where id = ${a!.id}`, '55000');
    await expectPgError(() => asRole(db.sql, 'service_role', (tx) => tx`delete from audit_log`), '42501');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/phase-13/records-db.test.ts`
Expected: FAIL — `relation "tracks" does not exist` (the fixture's `insert into releases` fails first).

- [ ] **Step 4: Write the migration (part 1)**

```sql
-- Phase 13 — XYP3RN Records: releases, tracks, rights_splits (ARCHITECTURE F3, spec
-- docs/superpowers/specs/2026-09-25-phase-13-records-design.md), plus the general audit_log
-- ARCHITECTURE.md names and no earlier migration created.
-- Every rule is a constraint or trigger: a direct INSERT cannot bypass it.
-- Idempotent. Rollback: supabase/rollbacks/20260925110000_records.down.sql

do $$ begin create type public.release_kind as enum ('single', 'ep', 'album');
exception when duplicate_object then null; end $$;
do $$ begin create type public.release_status as enum ('draft', 'pending_schedule', 'scheduled', 'released', 'cancelled');
exception when duplicate_object then null; end $$;
do $$ begin create type public.split_role as enum ('writer', 'producer', 'performer', 'publisher', 'other');
exception when duplicate_object then null; end $$;

create table if not exists public.releases (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  kind         public.release_kind not null,
  upc          text,
  status       public.release_status not null default 'draft',
  release_date date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint releases_title_check check (length(trim(title)) > 0),
  constraint releases_upc_check check (upc is null or upc ~ '^[0-9]{12,13}$')
);
create unique index if not exists releases_upc_key on public.releases (upc) where upc is not null;

create table if not exists public.tracks (
  id               uuid primary key default gen_random_uuid(),
  release_id       uuid not null references public.releases (id) on delete restrict,
  position         integer not null,
  title            text not null,
  isrc             text,
  duration_seconds numeric,
  suno_take_id     uuid references public.suno_takes (id) on delete restrict,
  master_uri       text,
  master_sha256    text,
  artifact_ids     uuid[] not null default '{}',
  mix_report_id    uuid references public.creative_artifacts (id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tracks_release_position_key unique (release_id, position),
  constraint tracks_position_check check (position >= 1),
  constraint tracks_title_check check (length(trim(title)) > 0),
  constraint tracks_isrc_check check (isrc is null or isrc ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$'),
  constraint tracks_duration_check check (duration_seconds is null or duration_seconds > 0),
  constraint tracks_one_source check ((suno_take_id is not null) <> (master_uri is not null)),
  constraint tracks_master_hash_check check ((master_uri is null) = (master_sha256 is null)
    and (master_sha256 is null or master_sha256 ~ '^[0-9a-f]{64}$'))
);
create unique index if not exists tracks_isrc_key on public.tracks (isrc) where isrc is not null;
create index if not exists tracks_suno_take_id_idx on public.tracks (suno_take_id);
create index if not exists tracks_mix_report_id_idx on public.tracks (mix_report_id);

create table if not exists public.rights_splits (
  id         uuid primary key default gen_random_uuid(),
  track_id   uuid not null references public.tracks (id) on delete cascade,
  payee      text not null,
  role       public.split_role not null,
  percentage numeric(5, 2) not null,
  constraint rights_splits_payee_check check (length(trim(payee)) > 0),
  constraint rights_splits_percentage_check check (percentage > 0 and percentage <= 100),
  constraint rights_splits_track_payee_role_key unique (track_id, payee, role)
);

create or replace function public.xyp_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create or replace trigger trg_releases_touch before update on public.releases
  for each row execute function public.xyp_touch_updated_at();
create or replace trigger trg_tracks_touch before update on public.tracks
  for each row execute function public.xyp_touch_updated_at();

-- SECURITY DEFINER: the agent role that registers a track may not read every artifact column.
create or replace function public.xyp_tracks_links()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_missing uuid;
  v_schema text;
begin
  select a into v_missing from unnest(new.artifact_ids) as a
  where not exists (select from public.creative_artifacts c where c.id = a) limit 1;
  if v_missing is not null then
    raise exception 'tracks: artifact % does not exist', v_missing using errcode = 'foreign_key_violation';
  end if;
  if new.mix_report_id is not null then
    select schema_id into v_schema from public.creative_artifacts where id = new.mix_report_id;
    if found and v_schema <> 'x3lius.mix-report/v1' then
      raise exception 'tracks: mix_report_id % is a %, not x3lius.mix-report/v1', new.mix_report_id, v_schema
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create or replace trigger trg_tracks_links before insert or update on public.tracks
  for each row execute function public.xyp_tracks_links();

-- ─── audit_log: append-only, general ───────────────────────────────────────────
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      text not null,
  table_name text not null,
  row_id     uuid not null,
  op         text not null,
  old        jsonb,
  new        jsonb,
  constraint audit_log_op_check check (op in ('insert', 'update', 'delete'))
);
create index if not exists audit_log_row_id_idx on public.audit_log (row_id);

-- SECURITY DEFINER so any writing role can append. The actor is the SET ROLE in force (the agent's
-- xyp_* role, or service_role), not the definer: current_setting('role') survives the definer switch.
create or replace function public.xyp_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log (actor, table_name, row_id, op, old, new)
  values (coalesce(nullif(current_setting('role', true), 'none'), session_user), tg_table_name,
          coalesce(new.id, old.id), lower(tg_op),
          case when tg_op = 'INSERT' then null else to_jsonb(old) end,
          case when tg_op = 'DELETE' then null else to_jsonb(new) end);
  return null;
end;
$$;
create or replace trigger trg_releases_audit after insert or update or delete on public.releases
  for each row execute function public.xyp_audit();
create or replace trigger trg_tracks_audit after insert or update or delete on public.tracks
  for each row execute function public.xyp_audit();
create or replace trigger trg_rights_splits_audit after insert or update or delete on public.rights_splits
  for each row execute function public.xyp_audit();

create or replace function public.xyp_audit_log_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_log is append-only' using errcode = 'object_not_in_prerequisite_state';
end;
$$;
create or replace trigger trg_audit_log_immutable before update or delete on public.audit_log
  for each row execute function public.xyp_audit_log_immutable();

alter table public.audit_log enable row level security;
revoke all on table public.audit_log from anon, authenticated, service_role;
grant select on table public.audit_log to service_role;
do $$ begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'audit_log' and policyname = 'service_select') then
    create policy service_select on public.audit_log for select to service_role using (true);
  end if;
end $$;
```

- [ ] **Step 5: Write the rollback (part 1)**

```sql
-- Rollback for 20260925110000_records.sql. Idempotent. No CASCADE.
drop table if exists public.rights_splits;
drop table if exists public.tracks;
drop table if exists public.releases;
drop table if exists public.audit_log;
drop function if exists public.xyp_audit();
drop function if exists public.xyp_audit_log_immutable();
drop function if exists public.xyp_tracks_links();
drop function if exists public.xyp_touch_updated_at();
drop type if exists public.split_role;
drop type if exists public.release_status;
drop type if exists public.release_kind;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/phase-13/records-db.test.ts`
Expected: PASS (5 tests). If the migration-rollback test in `tests/phase-01` walks every rollback, run it too: `npx vitest run tests/phase-01` → PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260925110000_records.sql supabase/rollbacks/20260925110000_records.down.sql tests/helpers/records-fixture.ts tests/phase-13/records-db.test.ts
git commit -F - <<'EOF'
Phase 13: releases, tracks, rights_splits tables; audit_log (append-only)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Splits always total 100; locked after scheduling

**Files:**
- Modify: `supabase/migrations/20260925110000_records.sql` (append)
- Modify: `supabase/rollbacks/20260925110000_records.down.sql` (prepend drops)
- Test: `tests/phase-13/records-db.test.ts` (append a describe)

**Interfaces:**
- Consumes: Task 1 tables.
- Produces: error prefixes `rights_splits_sum_not_100` (23514, raised at COMMIT), `splits_locked_after_schedule` (55000).

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/phase-13/records-db.test.ts
const splits = (trackId: string, rows: [string, string, number][]) =>
  db.sql.begin(async (tx) => {
    for (const [payee, role, pct] of rows) {
      await tx`insert into rights_splits (track_id, payee, role, percentage) values (${trackId}, ${payee}, ${role}::split_role, ${pct})`;
    }
  });

describe('rights_splits: every track totals exactly 100 at commit (a direct INSERT cannot bypass it)', () => {
  it('refuses 99.99, 100.01, and 60 committed alone', async () => {
    const { trackIds: [t] } = await seedRelease(db.sql);
    for (const rows of [[['A', 'writer', 50], ['B', 'producer', 49.99]], [['A', 'writer', 50], ['B', 'producer', 50.01]], [['A', 'writer', 60]]] as [string, string, number][][]) {
      const e = await expectPgError(() => splits(t!, rows), '23514');
      expect(e.message).toMatch(/^rights_splits_sum_not_100: track .* totals/);
    }
    expect(await db.sql`select 1 from rights_splits where track_id = ${t!}`).toHaveLength(0);
  });

  it('accepts exactly 100, thirds that add up, and an explicit UNASSIGNED share', async () => {
    const { trackIds: [a, b, c] } = await seedRelease(db.sql, { tracks: 3 });
    await splits(a!, [['A', 'writer', 50], ['B', 'producer', 50]]);
    await splits(b!, [['A', 'writer', 33.33], ['B', 'writer', 33.33], ['C', 'writer', 33.34]]);
    await splits(c!, [['A', 'writer', 75], ['UNASSIGNED', 'publisher', 25]]);
    const { trackIds: [d] } = await seedRelease(db.sql);
    await expectPgError(() => splits(d!, [['A', 'writer', 33.33], ['B', 'writer', 33.33], ['C', 'writer', 33.33]]), '23514');
  });

  it('replaces a split set in one transaction (delete + insert), and refuses leaving a partial set', async () => {
    const { trackIds: [t] } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }] });
    await db.sql.begin(async (tx) => {
      await tx`delete from rights_splits where track_id = ${t!}`;
      await tx`insert into rights_splits (track_id, payee, role, percentage) values (${t!}, 'A', 'writer', 40), (${t!}, 'B', 'producer', 60)`;
    });
    await expectPgError(() => db.sql`delete from rights_splits where track_id = ${t!} and payee = 'B'`, '23514');
  });
});

describe('rights_splits: locked once a release leaves draft', () => {
  it('refuses insert, update and delete while the release is pending_schedule, scheduled or released', async () => {
    const { releaseId, trackIds: [t] } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }], releaseDate: '2026-12-01' });
    await db.sql`update releases set status = 'pending_schedule' where id = ${releaseId}`;
    const e = await expectPgError(() => db.sql`update rights_splits set payee = 'Z' where track_id = ${t!}`, '55000');
    expect(e.message).toMatch(/^splits_locked_after_schedule/);
    await expectPgError(() => db.sql`delete from rights_splits where track_id = ${t!}`, '55000');
    await expectPgError(() => splits(t!, [['B', 'writer', 1]]), '55000');
  });
});
```

Note: the lock test moves the release to `pending_schedule` with a direct UPDATE as the superuser. Task 3 adds the scheduling gate; the release here satisfies it (date, one track, 100 with no UNASSIGNED), so the test still passes after Task 3.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/phase-13/records-db.test.ts`
Expected: FAIL — the 99.99 insert commits (no error thrown).

- [ ] **Step 3: Append to the migration**

```sql
-- ─── rights_splits: always exactly 100 per track, checked at COMMIT ──────────────
-- Deferred: a split set is entered row by row; the total is judged once the transaction is done.
-- A track with no split rows is allowed (nothing entered yet); the scheduling gate refuses it.
create or replace function public.xyp_rights_splits_sum()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_track uuid;
  v_total numeric;
  v_n integer;
begin
  foreach v_track in array array_remove(array[
    case when tg_op <> 'DELETE' then new.track_id end,
    case when tg_op <> 'INSERT' then old.track_id end], null)
  loop
    select coalesce(sum(percentage), 0), count(*) into v_total, v_n from public.rights_splits where track_id = v_track;
    if v_n > 0 and v_total <> 100 then
      raise exception 'rights_splits_sum_not_100: track % totals %', v_track, v_total using errcode = 'check_violation';
    end if;
  end loop;
  return null;
end;
$$;
create or replace constraint trigger trg_rights_splits_sum after insert or update or delete on public.rights_splits
  deferrable initially deferred for each row execute function public.xyp_rights_splits_sum();

-- ─── rights_splits: locked once the release leaves draft ────────────────────────
create or replace function public.xyp_rights_splits_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_status public.release_status;
begin
  select r.status into v_status from public.tracks t join public.releases r on r.id = t.release_id
  where t.id = coalesce(new.track_id, old.track_id);
  if v_status in ('pending_schedule', 'scheduled', 'released') then
    raise exception 'splits_locked_after_schedule: the release is %', v_status using errcode = 'object_not_in_prerequisite_state';
  end if;
  return coalesce(new, old);
end;
$$;
create or replace trigger trg_rights_splits_lock before insert or update or delete on public.rights_splits
  for each row execute function public.xyp_rights_splits_lock();
```

- [ ] **Step 4: Prepend to the rollback** (before `drop table if exists public.rights_splits;`; no CASCADE, so the triggers go first)

```sql
do $$ begin
  if to_regclass('public.rights_splits') is not null then
    drop trigger if exists trg_rights_splits_sum on public.rights_splits;
    drop trigger if exists trg_rights_splits_lock on public.rights_splits;
  end if;
end $$;
drop function if exists public.xyp_rights_splits_sum();
drop function if exists public.xyp_rights_splits_lock();
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/phase-13/records-db.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260925110000_records.sql supabase/rollbacks/20260925110000_records.down.sql tests/phase-13/records-db.test.ts
git commit -F - <<'EOF'
Phase 13: rights splits total exactly 100 at commit; locked once a release leaves draft

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Status path, scheduling gate, approval functions, roles

**Files:**
- Modify: `supabase/migrations/20260925110000_records.sql` (append)
- Modify: `supabase/rollbacks/20260925110000_records.down.sql` (prepend)
- Test: `tests/phase-13/records-db.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces:
  - `approval_item_type` value `release_schedule`.
  - Tables `release_schedule_requests (id, release_id, release_date, requested_at, applied_at)`, `records_flags (id, release_id, agent_run_id, report, created_at)`.
  - `xyp_request_release_schedule(p_release uuid) returns uuid` (the `approval_queue.id`), EXECUTE: `xyp_calendar`.
  - `xyp_apply_release_decision(p_approval uuid) returns public.release_status`, EXECUTE: `service_role`.
  - Roles `xyp_catalog`, `xyp_rights`, `xyp_calendar`; `xyp_runtime` gains SELECT on releases, tracks, rights_splits, records_flags, release_schedule_requests.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/phase-13/records-db.test.ts
const ok100 = [{ payee: 'A', role: 'writer', percentage: 100 }];
const setStatus = (id: string, s: string) => db.sql`update releases set status = ${s}::release_status where id = ${id}`;
const request = (id: string) => asCalendar((tx) => tx<{ id: string }[]>`select public.xyp_request_release_schedule(${id}) as id`);
// Commits (asRole rolls back): the queue row must survive for the apply step.
const asCalendar = <T>(fn: (tx: import('postgres').TransactionSql) => Promise<T>) =>
  db.sql.begin(async (tx) => { await tx.unsafe('set local role xyp_calendar'); return fn(tx); }) as Promise<T>;
const decide = (approvalId: string, d: 'approve' | 'reject') =>
  db.sql`select public.xyp_decide_approval(${approvalId}, ${d}, 'operator:test', 'test')`;
const apply = (approvalId: string) => db.sql<{ s: string }[]>`select public.xyp_apply_release_decision(${approvalId})::text as s`;

describe('releases: status path', () => {
  it('refuses illegal moves and keeps terminal states terminal', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    const e = await expectPgError(() => setStatus(releaseId, 'released'), '23514');
    expect(e.message).toMatch(/^release_status_transition: draft -> released/);
    await setStatus(releaseId, 'cancelled');
    await expectPgError(() => setStatus(releaseId, 'draft'), '23514');
  });
});

describe('scheduling gate', () => {
  it.each([
    ['no date', { splits: ok100 }, /no release_date/],
    ['no tracks', { tracks: 0, releaseDate: '2026-12-01' }, /no tracks/],
    ['a track with no splits', { releaseDate: '2026-12-01' }, /has no splits/],
    ['an UNASSIGNED share', { splits: [{ payee: 'A', role: 'writer', percentage: 75 }, { payee: 'UNASSIGNED', role: 'publisher', percentage: 25 }], releaseDate: '2026-12-01' }, /UNASSIGNED 25\.00/],
  ])('refuses pending_schedule with %s', async (_, opts, why) => {
    const { releaseId } = await seedRelease(db.sql, opts);
    const e = await expectPgError(() => setStatus(releaseId, 'pending_schedule'), '23514');
    expect(e.message).toMatch(/^release_not_schedulable: /);
    expect(e.message).toMatch(why);
  });
});

describe('locks outside draft (spec amendment 2)', () => {
  it('allows only status and UPC on the release, only ISRC on its tracks, and no added or removed track', async () => {
    const { releaseId, trackIds: [t] } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    await setStatus(releaseId, 'pending_schedule');
    await db.sql`update releases set upc = '123456789012' where id = ${releaseId}`;
    await db.sql`update tracks set isrc = 'GBXYZ2600001' where id = ${t!}`;
    expect((await expectPgError(() => db.sql`update releases set release_date = '2027-01-01' where id = ${releaseId}`, '55000')).message).toMatch(/^release_locked/);
    expect((await expectPgError(() => db.sql`update tracks set master_uri = 'file:///other.wav' where id = ${t!}`, '55000')).message).toMatch(/^track_locked/);
    await expectPgError(() => db.sql`insert into tracks (release_id, position, title, master_uri, master_sha256) values (${releaseId}, 2, 'late', 'file:///x.wav', ${SHA})`, '55000');
  });
});

describe('scheduling approval: request, decide, apply', () => {
  it('queues a request as xyp_calendar; approve schedules, re-checked by the gate', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    const [{ id }] = await request(releaseId);
    expect((await db.sql`select status::text from releases where id = ${releaseId}`)[0]!.status).toBe('pending_schedule');
    const [q] = await db.sql`select item_type::text, status::text from approval_queue where id = ${id}`;
    expect(q).toEqual({ item_type: 'release_schedule', status: 'pending' });
    await expectPgError(() => apply(id), '55000'); // still pending
    await decide(id, 'approve');
    expect((await apply(id))[0]!.s).toBe('scheduled');
    await expectPgError(() => apply(id), '55000'); // applied once only
  });

  it('reject returns the release to draft, and it can be requested again (spec amendment 1)', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    const [{ id }] = await request(releaseId);
    await decide(id, 'reject');
    expect((await apply(id))[0]!.s).toBe('draft');
    const [{ id: again }] = await request(releaseId);
    expect(again).not.toBe(id);
  });

  it('refuses a request for a release that is not a draft', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    await request(releaseId);
    await expectPgError(() => request(releaseId), '55000');
  });
});

describe('roles: each agent role only does its job', () => {
  it('xyp_catalog cannot write splits or status; xyp_rights cannot change a release; xyp_calendar cannot schedule directly', async () => {
    const { releaseId, trackIds: [t] } = await seedRelease(db.sql, { splits: ok100, releaseDate: '2026-12-01' });
    await expectPgError(() => asRole(db.sql, 'xyp_catalog', (tx) => tx`insert into rights_splits (track_id, payee, role, percentage) values (${t!}, 'X', 'writer', 1)`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_catalog', (tx) => tx`update releases set status = 'cancelled' where id = ${releaseId}`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_rights', (tx) => tx`update releases set title = 'x' where id = ${releaseId}`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_calendar', (tx) => tx`update releases set status = 'scheduled' where id = ${releaseId}`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_calendar', (tx) => tx`select public.xyp_apply_release_decision(${crypto.randomUUID()})`), '42501');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/phase-13/records-db.test.ts`
Expected: FAIL — `setStatus(… 'released')` succeeds (no transition trigger yet).

- [ ] **Step 3: Append to the migration**

```sql
-- ─── releases: status path + scheduling gate + locks outside draft ──────────────
create or replace function public.xyp_releases_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_bad text;
begin
  if tg_op = 'UPDATE' and old.status <> 'draft'
     and (new.title, new.kind, new.release_date) is distinct from (old.title, old.kind, old.release_date) then
    raise exception 'release_locked: a % release may change only its status and UPC', old.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status in ('pending_schedule', 'cancelled'))
    or (old.status = 'pending_schedule' and new.status in ('scheduled', 'draft', 'cancelled'))
    or (old.status = 'scheduled' and new.status in ('released', 'cancelled'))) then
    raise exception 'release_status_transition: % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  if (tg_op = 'INSERT' and new.status <> 'draft') then
    raise exception 'release_status_transition: a release starts as draft' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.status in ('pending_schedule', 'scheduled') and new.status is distinct from old.status then
    if new.release_date is null then
      v_bad := 'no release_date';
    elsif not exists (select from public.tracks where release_id = new.id) then
      v_bad := 'no tracks';
    else
      select format('track %s has no splits', t.position) into v_bad from public.tracks t
      where t.release_id = new.id and not exists (select from public.rights_splits s where s.track_id = t.id)
      order by t.position limit 1;
      if v_bad is null then
        select format('track %s has UNASSIGNED %s', t.position, s.percentage) into v_bad
        from public.tracks t join public.rights_splits s on s.track_id = t.id
        where t.release_id = new.id and s.payee = 'UNASSIGNED' order by t.position limit 1;
      end if;
    end if;
    if v_bad is not null then
      raise exception 'release_not_schedulable: %', v_bad using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create or replace trigger trg_releases_guard before insert or update on public.releases
  for each row execute function public.xyp_releases_guard();

create or replace function public.xyp_tracks_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_status public.release_status;
begin
  select status into v_status from public.releases where id = coalesce(new.release_id, old.release_id);
  if v_status = 'draft' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and (to_jsonb(new) - array['isrc', 'updated_at']) = (to_jsonb(old) - array['isrc', 'updated_at']) then
    return new;
  end if;
  raise exception 'track_locked: the release is %; only ISRC may change', v_status using errcode = 'object_not_in_prerequisite_state';
end;
$$;
create or replace trigger trg_tracks_lock before insert or update or delete on public.tracks
  for each row execute function public.xyp_tracks_lock();

-- ─── scheduling requests and approval (spec §3.5, amendment 1) ──────────────────
alter type public.approval_item_type add value if not exists 'release_schedule';

create table if not exists public.release_schedule_requests (
  id           uuid primary key default gen_random_uuid(),
  release_id   uuid not null references public.releases (id) on delete restrict,
  release_date date not null,
  requested_at timestamptz not null default now(),
  applied_at   timestamptz
);
create index if not exists release_schedule_requests_release_id_idx on public.release_schedule_requests (release_id);

create table if not exists public.records_flags (
  id           uuid primary key default gen_random_uuid(),
  release_id   uuid not null references public.releases (id) on delete restrict,
  agent_run_id uuid not null references public.agent_runs (id) on delete restrict,
  report       jsonb not null,
  created_at   timestamptz not null default now(),
  constraint records_flags_report_check check (jsonb_typeof(report) = 'object')
);
create index if not exists records_flags_release_id_idx on public.records_flags (release_id);

create or replace function public.xyp_records_flags_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'records_flags is append-only' using errcode = 'object_not_in_prerequisite_state';
end;
$$;
create or replace trigger trg_records_flags_immutable before update or delete on public.records_flags
  for each row execute function public.xyp_records_flags_immutable();

create or replace function public.xyp_request_release_schedule(p_release uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_release public.releases;
  v_request uuid;
  v_approval uuid;
begin
  update public.releases set status = 'pending_schedule' where id = p_release and status = 'draft'
  returning * into v_release;
  if not found then
    raise exception 'release % is not a draft', p_release using errcode = 'object_not_in_prerequisite_state';
  end if;
  insert into public.release_schedule_requests (release_id, release_date) values (p_release, v_release.release_date)
  returning id into v_request;
  insert into public.approval_queue (item_type, item_id, request)
  values ('release_schedule', v_request, jsonb_build_object(
    'release_id', p_release, 'title', v_release.title, 'release_date', v_release.release_date,
    'tracks', (select jsonb_agg(jsonb_build_object('position', position, 'title', title) order by position)
               from public.tracks where release_id = p_release)))
  returning id into v_approval;
  return v_approval;
end;
$$;

create or replace function public.xyp_apply_release_decision(p_approval uuid)
returns public.release_status language plpgsql security definer set search_path = '' as $$
declare
  v_q public.approval_queue;
  v_req public.release_schedule_requests;
  v_status public.release_status;
begin
  select * into v_q from public.approval_queue where id = p_approval and item_type = 'release_schedule';
  if not found then
    raise exception 'no release_schedule approval %', p_approval using errcode = 'foreign_key_violation';
  end if;
  if v_q.status = 'pending' then
    raise exception 'approval % is still pending', p_approval using errcode = 'object_not_in_prerequisite_state';
  end if;
  update public.release_schedule_requests set applied_at = now() where id = v_q.item_id and applied_at is null
  returning * into v_req;
  if not found then
    raise exception 'approval % was already applied', p_approval using errcode = 'object_not_in_prerequisite_state';
  end if;
  update public.releases set status = (case v_q.status when 'approved' then 'scheduled' else 'draft' end)::public.release_status
  where id = v_req.release_id and status = 'pending_schedule'
  returning status into v_status;
  if not found then
    raise exception 'release % is no longer pending_schedule', v_req.release_id using errcode = 'object_not_in_prerequisite_state';
  end if;
  return v_status;
end;
$$;

-- ─── roles and grants ─────────────────────────────────────────────────────────
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_catalog') then create role xyp_catalog nologin noinherit; end if;
exception when duplicate_object or unique_violation then null; end $$;
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_rights') then create role xyp_rights nologin noinherit; end if;
exception when duplicate_object or unique_violation then null; end $$;
do $$ begin
  if not exists (select from pg_roles where rolname = 'xyp_calendar') then create role xyp_calendar nologin noinherit; end if;
exception when duplicate_object or unique_violation then null; end $$;

grant usage on schema public to xyp_catalog, xyp_rights, xyp_calendar;

do $$
declare
  t text;
begin
  foreach t in array array['releases', 'tracks', 'rights_splits', 'records_flags', 'release_schedule_requests'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to service_role, xyp_runtime, xyp_catalog, xyp_rights, xyp_calendar', t);
    if not exists (select from pg_policies where schemaname = 'public' and tablename = t and policyname = 'records_select') then
      execute format('create policy records_select on public.%I for select to service_role, xyp_runtime, xyp_catalog, xyp_rights, xyp_calendar using (true)', t);
    end if;
  end loop;
end $$;

grant insert (title, kind, upc) on table public.releases to xyp_catalog;
grant update (title, kind, upc) on table public.releases to xyp_catalog;
grant insert (release_id, position, title, isrc, duration_seconds, suno_take_id, master_uri, master_sha256, artifact_ids, mix_report_id)
  on table public.tracks to xyp_catalog;
grant update (title, position, isrc, duration_seconds, suno_take_id, master_uri, master_sha256, artifact_ids, mix_report_id)
  on table public.tracks to xyp_catalog;
grant update (release_date) on table public.releases to xyp_calendar;
grant insert on table public.records_flags to xyp_rights;
grant insert, update, delete on table public.rights_splits to service_role;
grant insert, update on table public.releases, public.tracks to service_role;

do $$
begin
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'releases' and policyname = 'catalog_write') then
    create policy catalog_write on public.releases for all to xyp_catalog, xyp_calendar, service_role using (true) with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'tracks' and policyname = 'catalog_write') then
    create policy catalog_write on public.tracks for all to xyp_catalog, service_role using (true) with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'rights_splits' and policyname = 'operator_write') then
    create policy operator_write on public.rights_splits for all to service_role using (true) with check (true);
  end if;
  if not exists (select from pg_policies where schemaname = 'public' and tablename = 'records_flags' and policyname = 'rights_insert') then
    create policy rights_insert on public.records_flags for insert to xyp_rights with check (true);
  end if;
end $$;

revoke execute on function
  public.xyp_touch_updated_at(), public.xyp_tracks_links(), public.xyp_audit(), public.xyp_audit_log_immutable(),
  public.xyp_rights_splits_sum(), public.xyp_rights_splits_lock(), public.xyp_releases_guard(), public.xyp_tracks_lock(),
  public.xyp_records_flags_immutable()
  from public, anon, authenticated;
revoke execute on function public.xyp_request_release_schedule(uuid) from public, anon, authenticated, service_role;
grant execute on function public.xyp_request_release_schedule(uuid) to xyp_calendar;
revoke execute on function public.xyp_apply_release_decision(uuid) from public, anon, authenticated;
grant execute on function public.xyp_apply_release_decision(uuid) to service_role;
```

- [ ] **Step 4: Prepend to the rollback** (top of file)

```sql
drop function if exists public.xyp_apply_release_decision(uuid);
drop function if exists public.xyp_request_release_schedule(uuid);
drop table if exists public.records_flags;
drop table if exists public.release_schedule_requests;
drop function if exists public.xyp_records_flags_immutable();
do $$ begin
  if to_regclass('public.tracks') is not null then drop trigger if exists trg_tracks_lock on public.tracks; end if;
  if to_regclass('public.releases') is not null then drop trigger if exists trg_releases_guard on public.releases; end if;
end $$;
drop function if exists public.xyp_tracks_lock();
drop function if exists public.xyp_releases_guard();
-- approval_item_type keeps 'release_schedule': Postgres cannot drop an enum value; with no table
-- left to point at, the value is inert. Roles xyp_catalog / xyp_rights / xyp_calendar stay (cluster-wide).
do $$ begin
  if exists (select from pg_roles where rolname = 'xyp_catalog') then revoke usage on schema public from xyp_catalog; end if;
  if exists (select from pg_roles where rolname = 'xyp_rights') then revoke usage on schema public from xyp_rights; end if;
  if exists (select from pg_roles where rolname = 'xyp_calendar') then revoke usage on schema public from xyp_calendar; end if;
end $$;
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/phase-13/records-db.test.ts tests/phase-01`
Expected: PASS. If a Phase 1/6D test enumerates `approval_item_type` values, update its expected list to include `release_schedule` in the same commit.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260925110000_records.sql supabase/rollbacks/20260925110000_records.down.sql tests/phase-13/records-db.test.ts
git commit -F - <<'EOF'
Phase 13: release status path, scheduling gate, locks outside draft, schedule approval, roles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Capabilities and the shared schedulability check

**Files:**
- Modify: `core/tool-registry/capabilities.ts`
- Modify: `docs/AGENT_CLASSES.md` (capability table)
- Create: `records/ops/schedulable.ts`
- Test: `records/ops/schedulable.test.ts`

**Interfaces:**
- Produces:

```ts
export const UNASSIGNED = 'UNASSIGNED';
export type SplitView = { readonly payee: string; readonly role: string; readonly percentage: number };
export type TrackView = { readonly id: string; readonly position: number; readonly title: string; readonly splits: readonly SplitView[] };
export type ReleaseView = { readonly id: string; readonly title: string; readonly status: string; readonly releaseDate: string | null; readonly tracks: readonly TrackView[] };
export type TrackReport = { readonly trackId: string; readonly position: number; readonly total: number; readonly unassigned: number; readonly problems: readonly string[]; readonly notes: readonly string[] };
export type ScheduleReport = { readonly schedulable: boolean; readonly problems: readonly string[]; readonly tracks: readonly TrackReport[] };
export const checkSchedulable: (r: ReleaseView) => ScheduleReport;
```

- [ ] **Step 1: Write the failing test**

```ts
// records/ops/schedulable.test.ts
import { describe, expect, it } from 'vitest';
import { checkSchedulable, UNASSIGNED, type ReleaseView } from './schedulable.ts';

const rel = (over: Partial<ReleaseView> = {}): ReleaseView => ({
  id: 'r', title: 'R', status: 'draft', releaseDate: '2026-12-01',
  tracks: [{ id: 't1', position: 1, title: 'One', splits: [{ payee: 'A', role: 'writer', percentage: 60 }, { payee: 'B', role: 'producer', percentage: 40 }] }],
  ...over,
});

describe('checkSchedulable (the Rights agent report; Calendar runs it before proposing)', () => {
  it('passes a draft with a date and every track at 100 with no UNASSIGNED', () => {
    expect(checkSchedulable(rel())).toEqual({
      schedulable: true, problems: [],
      tracks: [{ trackId: 't1', position: 1, total: 100, unassigned: 0, problems: [], notes: [] }],
    });
  });

  it('names every blocking problem, per track and for the release', () => {
    const r = checkSchedulable(rel({
      status: 'scheduled', releaseDate: null,
      tracks: [
        { id: 't1', position: 1, title: 'One', splits: [] },
        { id: 't2', position: 2, title: 'Two', splits: [{ payee: 'A', role: 'writer', percentage: 75 }, { payee: UNASSIGNED, role: 'publisher', percentage: 25 }] },
      ],
    }));
    expect(r.schedulable).toBe(false);
    expect(r.problems).toEqual(['release is scheduled, not draft', 'no release date']);
    expect(r.tracks.map((t) => t.problems)).toEqual([['no splits entered'], ['UNASSIGNED share of 25%']]);
    expect(r.tracks[1]).toMatchObject({ total: 100, unassigned: 25 });
  });

  it('refuses a release with no tracks, and sums in cents (33.33 + 33.33 + 33.34 = 100)', () => {
    expect(checkSchedulable(rel({ tracks: [] })).problems).toEqual(['no tracks']);
    const thirds = rel({ tracks: [{ id: 't', position: 1, title: 'T', splits: [33.33, 33.33, 33.34].map((p, i) => ({ payee: `P${i}`, role: 'writer', percentage: p })) }] });
    expect(checkSchedulable(thirds).tracks[0]!.total).toBe(100);
  });

  it('notes, without blocking, a payee listed under two roles', () => {
    const r = checkSchedulable(rel({ tracks: [{ id: 't', position: 1, title: 'T', splits: [{ payee: 'A', role: 'writer', percentage: 50 }, { payee: 'A', role: 'producer', percentage: 50 }] }] }));
    expect(r).toMatchObject({ schedulable: true });
    expect(r.tracks[0]!.notes).toEqual(['A is listed as writer and producer']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run records/ops/schedulable.test.ts`
Expected: FAIL — `Cannot find module './schedulable.ts'`.

- [ ] **Step 3: Implement**

```ts
// records/ops/schedulable.ts
/**
 * Whether a release may be scheduled (Phase 13 spec §5.2). The DB gate (migration
 * 20260925110000, xyp_releases_guard) is the guarantee; this is the readable report the Rights agent
 * flags with and the Calendar agent refuses with, one function for both.
 */

export const UNASSIGNED = 'UNASSIGNED';

export type SplitView = { readonly payee: string; readonly role: string; readonly percentage: number };
export type TrackView = { readonly id: string; readonly position: number; readonly title: string; readonly splits: readonly SplitView[] };
export type ReleaseView = { readonly id: string; readonly title: string; readonly status: string; readonly releaseDate: string | null; readonly tracks: readonly TrackView[] };
export type TrackReport = { readonly trackId: string; readonly position: number; readonly total: number; readonly unassigned: number; readonly problems: readonly string[]; readonly notes: readonly string[] };
export type ScheduleReport = { readonly schedulable: boolean; readonly problems: readonly string[]; readonly tracks: readonly TrackReport[] };

const cents = (n: number): number => Math.round(n * 100);

/**
 * @param r - the release with its tracks and splits
 * @returns blocking problems for the release and per track, plus non-blocking notes
 */
export const checkSchedulable = (r: ReleaseView): ScheduleReport => {
  const problems = [
    ...(r.status === 'draft' ? [] : [`release is ${r.status}, not draft`]),
    ...(r.releaseDate ? [] : ['no release date']),
    ...(r.tracks.length === 0 ? ['no tracks'] : []),
  ];
  const tracks = [...r.tracks].sort((a, b) => a.position - b.position).map((t): TrackReport => {
    const total = t.splits.reduce((n, s) => n + cents(s.percentage), 0) / 100;
    const unassigned = t.splits.filter((s) => s.payee === UNASSIGNED).reduce((n, s) => n + cents(s.percentage), 0) / 100;
    const roles = new Map<string, string[]>();
    for (const s of t.splits) if (s.payee !== UNASSIGNED) roles.set(s.payee, [...(roles.get(s.payee) ?? []), s.role]);
    return {
      trackId: t.id, position: t.position, total, unassigned,
      problems: [
        ...(t.splits.length === 0 ? ['no splits entered'] : []),
        ...(t.splits.length > 0 && total !== 100 ? [`splits total ${total}%, not 100%`] : []),
        ...(unassigned > 0 ? [`UNASSIGNED share of ${unassigned}%`] : []),
      ],
      notes: [...roles].filter(([, rs]) => rs.length > 1).map(([p, rs]) => `${p} is listed as ${rs.join(' and ')}`),
    };
  });
  return { schedulable: problems.length === 0 && tracks.every((t) => t.problems.length === 0), problems, tracks };
};
```

- [ ] **Step 4: Add the capabilities**

In `core/tool-registry/capabilities.ts`, add to `CAPABILITIES` after `'governance.flag'`:

```ts
  'records.read',
  'catalog.write',
  'schedule.propose',
```

and to `CLASS_CAPABILITIES` after `'governance.flag': ['Governance'],`:

```ts
  // Phase 13: Records ops (catalog, rights splits, release calendar). Splits themselves are the
  // operator's (service_role); no agent class writes them.
  'records.read': ['Planning', 'Execution', 'Governance'],
  'catalog.write': ['Execution'],
  'schedule.propose': ['Execution'],
```

In `docs/AGENT_CLASSES.md`, add these rows after the `governance.flag` row (column order: Research, Knowledge, Planning, Creative, Critic, Revision, Execution, Governance), and replace the sentence "Records ops capabilities (catalog, rights splits) are deliberately undefined until Phase 13, where F10 is decided." with "Records ops capabilities were added in Phase 13; splits are written only by the operator."

```markdown
| `records.read` | Read releases, tracks, rights splits and Records flags (Phase 13) | — | — | Y | — | — | — | Y | Y |
| `catalog.write` | Register releases and tracks in the catalog (Phase 13) | — | — | — | — | — | — | Y | — |
| `schedule.propose` | Set a release date and request scheduling; the operator decides (Phase 13) | — | — | — | — | — | — | Y | — |
```

- [ ] **Step 5: Run to verify**

Run: `npx vitest run records/ops/schedulable.test.ts tests/phase-04c`
Expected: PASS (the Phase 4C drift test confirms the doc and code tables match).

- [ ] **Step 6: Commit**

```bash
git add records/ops/schedulable.ts records/ops/schedulable.test.ts core/tool-registry/capabilities.ts docs/AGENT_CLASSES.md
git commit -F - <<'EOF'
Phase 13: Records capabilities (records.read, catalog.write, schedule.propose); schedulability report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Tools — `register_track`, `read_release`, `flag_release`, `propose_schedule`

**Files:**
- Create: `records/ops/tools.ts`
- Modify: `core/runtime/tools.ts` (register the four tools)
- Test: `tests/phase-13/records-tools.test.ts`

**Interfaces:**
- Consumes: Task 3 roles/functions; Task 4 `ReleaseView`, capabilities.
- Produces:
  - `register_track` (catalog.write, as `xyp_catalog`): args `{ releaseId?: uuid, release?: { title, kind }, track: { title, position, source: { sunoTakeId } | { masterUri, masterSha256 }, artifactIds?, mixReportId?, durationSeconds? } }` → `{ release: { id, status }, track: { id, position } }`.
  - `read_release` (records.read, as `xyp_runtime`): `{ releaseId }` → `ReleaseView`.
  - `flag_release` (governance.flag, as `xyp_rights`): `{ releaseId, report: ScheduleReport }` → `{ flag_id }`.
  - `propose_schedule` (schedule.propose, as `xyp_calendar`): `{ releaseId, releaseDate: 'YYYY-MM-DD' }` → `{ approvalId }`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/phase-13/records-tools.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import type { ToolContext } from '../../core/tool-registry/registry.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { seedCreative, seedRelease, SHA } from '../helpers/records-fixture.ts';

let db: TestDb;
let fx: Awaited<ReturnType<typeof seedCreative>>;
beforeAll(async () => {
  db = await createTestDb('phase13_tools', { migrated: true });
  fx = await seedCreative(db.sql);
});
afterAll(async () => db?.drop());

const ctx = (): ToolContext => ({ runId: fx.runId, agentName: 'records-test', log: () => {} });
const call = (name: string, args: unknown) => createRuntimeTools({ sql: db.sql }).get(name)!.handler(ctx(), args);

describe('register_track', () => {
  it('creates a release and a track from a Suno take, ISRC/UPC null', async () => {
    const out = (await call('register_track', {
      release: { title: 'Night Drive', kind: 'single' },
      track: { title: 'Night Drive', position: 1, source: { sunoTakeId: fx.takeId }, artifactIds: [fx.lyricsId] },
    })) as { release: { id: string; status: string }; track: { id: string } };
    expect(out.release.status).toBe('draft');
    const [t] = await db.sql`select isrc, suno_take_id from tracks where id = ${out.track.id}`;
    expect(t).toEqual({ isrc: null, suno_take_id: fx.takeId });
    const [a] = await db.sql`select actor from audit_log where row_id = ${out.track.id}`;
    expect(a!.actor).toBe('xyp_catalog');
  });

  it('adds a studio-master track to an existing release, and refuses both or neither id', async () => {
    const { releaseId } = await seedRelease(db.sql, { tracks: 0 });
    await call('register_track', { releaseId, track: { title: 'M', position: 1, source: { masterUri: 'file:///m.wav', masterSha256: SHA }, mixReportId: fx.mixReportId } });
    await expect(call('register_track', { track: { title: 'x', position: 1, source: { sunoTakeId: fx.takeId } } })).rejects.toThrow(/exactly one of releaseId or release/);
  });
});

describe('read_release, flag_release, propose_schedule', () => {
  it('reads a release as a ReleaseView with numeric percentages', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }], releaseDate: '2026-12-01' });
    const v = await call('read_release', { releaseId });
    expect(v).toMatchObject({ id: releaseId, status: 'draft', releaseDate: '2026-12-01', tracks: [{ position: 1, splits: [{ payee: 'A', role: 'writer', percentage: 100 }] }] });
  });

  it('flags as xyp_rights, and proposes as xyp_calendar (date set, request queued)', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }] });
    const { flag_id } = (await call('flag_release', { releaseId, report: { schedulable: false, problems: ['x'], tracks: [] } })) as { flag_id: string };
    expect((await db.sql`select release_id from records_flags where id = ${flag_id}`)[0]!.release_id).toBe(releaseId);
    const { approvalId } = (await call('propose_schedule', { releaseId, releaseDate: '2026-12-01' })) as { approvalId: string };
    expect((await db.sql`select item_type::text from approval_queue where id = ${approvalId}`)[0]!.item_type).toBe('release_schedule');
    expect((await db.sql`select status::text, release_date::text from releases where id = ${releaseId}`)[0]).toEqual({ status: 'pending_schedule', release_date: '2026-12-01' });
  });

  it('refuses a malformed date before touching the DB', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }] });
    await expect(call('propose_schedule', { releaseId, releaseDate: '12/01/2026' })).rejects.toThrow(/releaseDate must be YYYY-MM-DD/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/phase-13/records-tools.test.ts`
Expected: FAIL — `register_track` is not registered.

- [ ] **Step 3: Implement the tools**

```ts
// records/ops/tools.ts
import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../core/db/client.ts';
import { defineTool, type Tool } from '../../core/tool-registry/registry.ts';
import type { ReleaseView, ScheduleReport } from './schedulable.ts';

/**
 * Records ops tools (Phase 13). Each runs as its own DB role (migration 20260925110000), so a
 * class boundary is also a grant boundary: the DB refuses what the tool would not do.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const uuid = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw new Error(`${what} must be a uuid`);
  return v;
};
const as = <T>(sql: Sql, role: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(role)}`);
    return fn(tx);
  }) as Promise<T>;

type TrackInput = {
  title?: unknown; position?: unknown; durationSeconds?: unknown; artifactIds?: unknown; mixReportId?: unknown;
  source?: { sunoTakeId?: unknown; masterUri?: unknown; masterSha256?: unknown };
};

export const createRegisterTrackTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'register_track',
    capability: 'catalog.write',
    description: 'Register a finished track (a Suno take or a studio master) in the catalog, creating its release if asked. ISRC/UPC stay null until assigned.',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { releaseId?: unknown; release?: { title?: unknown; kind?: unknown }; track?: TrackInput };
      if ((a.releaseId === undefined) === (a.release === undefined)) throw new Error('register_track: give exactly one of releaseId or release');
      const t = a.track ?? {};
      const src = t.source ?? {};
      const take = src.sunoTakeId === undefined ? null : uuid(src.sunoTakeId, 'track.source.sunoTakeId');
      const artifactIds = t.artifactIds === undefined ? [] : (t.artifactIds as unknown[]).map((x, i) => uuid(x, `track.artifactIds[${i}]`));
      const out = await as(deps.sql, 'xyp_catalog', async (tx) => {
        const [r] = a.releaseId !== undefined
          ? await tx<{ id: string; status: string }[]>`select id, status::text from releases where id = ${uuid(a.releaseId, 'releaseId')}`
          : await tx<{ id: string; status: string }[]>`
              insert into releases (title, kind) values (${String(a.release!.title ?? '')}, ${String(a.release!.kind ?? '')}::release_kind)
              returning id, status::text`;
        if (!r) throw new Error(`register_track: no release ${String(a.releaseId)}`);
        const [tr] = await tx<{ id: string; position: number }[]>`
          insert into tracks (release_id, position, title, duration_seconds, suno_take_id, master_uri, master_sha256, artifact_ids, mix_report_id)
          values (${r.id}, ${Number(t.position)}, ${String(t.title ?? '')}, ${t.durationSeconds === undefined ? null : Number(t.durationSeconds)},
                  ${take}, ${src.masterUri === undefined ? null : String(src.masterUri)}, ${src.masterSha256 === undefined ? null : String(src.masterSha256)},
                  ${artifactIds}::uuid[], ${t.mixReportId === undefined ? null : uuid(t.mixReportId, 'track.mixReportId')})
          returning id, position`;
        return { release: r, track: tr! };
      });
      ctx.log('info', `register_track → release ${out.release.id} (${out.release.status}), track ${out.track.id} #${out.track.position}`);
      return out;
    },
  });

export const readReleaseView = async (tx: postgres.TransactionSql | Sql, releaseId: string): Promise<ReleaseView> => {
  const [r] = await tx<{ id: string; title: string; status: string; release_date: string | null }[]>`
    select id, title, status::text, release_date::text from releases where id = ${releaseId}`;
  if (!r) throw new Error(`no release ${releaseId}`);
  const rows = await tx<{ id: string; position: number; title: string; payee: string | null; role: string | null; percentage: string | null }[]>`
    select t.id, t.position, t.title, s.payee, s.role::text, s.percentage::text
    from tracks t left join rights_splits s on s.track_id = t.id where t.release_id = ${releaseId} order by t.position, s.payee, s.role`;
  const tracks = new Map<string, { id: string; position: number; title: string; splits: { payee: string; role: string; percentage: number }[] }>();
  for (const x of rows) {
    const tr = tracks.get(x.id) ?? { id: x.id, position: x.position, title: x.title, splits: [] };
    if (x.payee !== null) tr.splits.push({ payee: x.payee, role: x.role!, percentage: Number(x.percentage) });
    tracks.set(x.id, tr);
  }
  return { id: r.id, title: r.title, status: r.status, releaseDate: r.release_date, tracks: [...tracks.values()] };
};

export const createReadReleaseTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'read_release',
    capability: 'records.read',
    description: 'One release with its tracks and rights splits (read-only).',
    handler: async (_ctx, args) => {
      const id = uuid((args as { releaseId?: unknown } | null)?.releaseId, 'releaseId');
      return deps.sql.begin('read only', async (tx) => {
        await tx.unsafe(`set local role ${quoteIdent('xyp_runtime')}`);
        return readReleaseView(tx, id);
      });
    },
  });

export const createFlagReleaseTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'flag_release',
    capability: 'governance.flag',
    description: 'Append a Records flag: why a release cannot be scheduled (append-only).',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { releaseId?: unknown; report?: ScheduleReport };
      const id = uuid(a.releaseId, 'releaseId');
      if (a.report === null || typeof a.report !== 'object') throw new Error('flag_release: report must be an object');
      const [f] = await as(deps.sql, 'xyp_rights', (tx) => tx<{ id: string }[]>`
        insert into records_flags (release_id, agent_run_id, report) values (${id}, ${ctx.runId}, ${tx.json(a.report as unknown as postgres.JSONValue)}) returning id`);
      ctx.log('warn', `flag_release → ${f!.id} on release ${id}`);
      return { flag_id: f!.id };
    },
  });

export const createProposeScheduleTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'propose_schedule',
    capability: 'schedule.propose',
    description: 'Set a draft release date and request scheduling; the operator approves or rejects it on the approval queue.',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { releaseId?: unknown; releaseDate?: unknown };
      const id = uuid(a.releaseId, 'releaseId');
      if (typeof a.releaseDate !== 'string' || !DATE.test(a.releaseDate)) throw new Error('propose_schedule: releaseDate must be YYYY-MM-DD');
      const approvalId = await as(deps.sql, 'xyp_calendar', async (tx) => {
        await tx`update releases set release_date = ${a.releaseDate as string} where id = ${id}`;
        return (await tx<{ id: string }[]>`select public.xyp_request_release_schedule(${id}) as id`)[0]!.id;
      });
      ctx.log('info', `propose_schedule → release ${id} on ${a.releaseDate}, approval ${approvalId}`);
      return { approvalId };
    },
  });
```

In `core/runtime/tools.ts`: import the four factories from `../../records/ops/tools.ts`, add them to the `createToolRegistry([...])` list after `createCaptureSunoTakesTool(external)`, and extend the doc comment's tool list with `register_track, read_release, flag_release, propose_schedule`:

```ts
import { createFlagReleaseTool, createProposeScheduleTool, createReadReleaseTool, createRegisterTrackTool } from '../../records/ops/tools.ts';
// …
    createCaptureSunoTakesTool(external),
    createRegisterTrackTool(deps),
    createReadReleaseTool(deps),
    createFlagReleaseTool(deps),
    createProposeScheduleTool(deps),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/phase-13/records-tools.test.ts tests/phase-04c`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add records/ops/tools.ts core/runtime/tools.ts tests/phase-13/records-tools.test.ts
git commit -F - <<'EOF'
Phase 13: register_track, read_release, flag_release, propose_schedule tools (one DB role each)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: The three agents

**Files:**
- Create: `agents/records-catalog.agent.md`, `agents/records-rights-splits.agent.md`, `agents/records-release-calendar.agent.md`
- Create: `records/ops/agents.ts`
- Modify: `core/runtime/handlers.ts` (add three handlers)
- Test: `tests/phase-13/records-agents.test.ts`

**Interfaces:**
- Consumes: Task 5 tools; Task 4 `checkSchedulable`.
- Produces: handlers `recordsCatalog`, `recordsRightsSplits`, `recordsReleaseCalendar` (type `AgentHandler` from `core/orchestrator/dispatch.ts`, the same type `mixMaster` uses).

- [ ] **Step 1: Write the agent files**

`agents/records-catalog.agent.md`:

```markdown
---
name: records-catalog
class: Execution
domain: RECORDS
tools: [register_track, read_release, log_message]
model: none
---

# Records Catalog

## Role

Registers a finished track in the XYP3RN Records catalog (Phase 13): a captured Suno take (Phase 9) or a studio master, linked to the creative artifacts behind it and, if one exists, the master's mix report. It answers the Execution class's question, "how do we perform the operation?", for catalog registration only. Deterministic: it creates no content.

## Contract

- **Inputs:** `{ releaseId?, release?: { title, kind: "single"|"ep"|"album" }, track: { title, position, source: { sunoTakeId } | { masterUri, masterSha256 }, artifactIds?, mixReportId?, durationSeconds? } }`; exactly one of `releaseId` / `release`.
- **Outputs:** `{ release: { id, status }, track: { id, position }, next }`, where `next` tells the operator to enter splits.
- **Reads:** `releases` (as `xyp_catalog`).
- **Writes:** `releases`, `tracks` through `register_track` (capability `catalog.write`, role `xyp_catalog`). ISRC and UPC stay null.
- **Side effects:** none.

## Refuses

- Writing rights splits or a release status (the DB refuses both for `xyp_catalog`).
- A track with two audio sources or none, an unknown take or artifact, or a mix report that is not an `x3lius.mix-report/v1`.
- Adding a track to a release that has left draft.
```

`agents/records-rights-splits.agent.md`:

```markdown
---
name: records-rights-splits
class: Governance
domain: RECORDS
tools: [read_release, flag_release, log_message]
model: none
---

# Records Rights Splits

## Role

Validates a release's rights splits before it can be scheduled (Phase 13) and flags whatever blocks it: a track with no splits, a total other than 100, or an UNASSIGNED share. It answers the Governance class's question, "is this allowed?", for rights data it reads and never writes (ARCHITECTURE F3).

## Contract

- **Inputs:** `{ releaseId }`.
- **Outputs:** `{ schedulable, problems, tracks: [{ trackId, position, total, unassigned, problems, notes }], flagId? }`; `flagId` only when a flag was written.
- **Reads:** the release, tracks and splits through `read_release` (capability `records.read`).
- **Writes:** one `records_flags` row through `flag_release` (capability `governance.flag`, role `xyp_rights`) when the release is not schedulable.
- **Side effects:** none.

## Refuses

- Editing splits, tracks or the release: it flags and reports only; the operator fixes splits.
- Declaring a release schedulable the DB gate would refuse (same rules, one function: `records/ops/schedulable.ts`).
```

`agents/records-release-calendar.agent.md`:

```markdown
---
name: records-release-calendar
class: Execution
domain: RECORDS
tools: [read_release, propose_schedule, log_message]
model: none
---

# Records Release Calendar

## Role

Proposes a release date for a draft release and queues it for the operator's approval (Phase 13). Scheduling only: no marketing, PR or distribution logic. It answers the Execution class's question, "how do we perform the operation?", for the release calendar.

## Contract

- **Inputs:** `{ releaseId, releaseDate: "YYYY-MM-DD" }`.
- **Outputs:** `{ release: { id, status: "pending_schedule", releaseDate }, approvalId }`.
- **Reads:** the release through `read_release` (capability `records.read`).
- **Writes:** the release date and one scheduling request through `propose_schedule` (capability `schedule.propose`, role `xyp_calendar`). The operator's approval, not this agent, moves the release to `scheduled`.
- **Side effects:** none.

## Refuses

- A release the schedulability check refuses: it returns the report and points to `records-rights-splits` for the flag.
- Setting `scheduled`, `released` or `cancelled` itself (the DB refuses `xyp_calendar`).
- Marketing, PR or distribution steps.
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/phase-13/records-agents.test.ts
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { seedCreative, seedRelease } from '../helpers/records-fixture.ts';

let db: TestDb;
let fx: Awaited<ReturnType<typeof seedCreative>>;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const deps = (): DispatchDeps => ({ sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS });
const run = (agent: string, input: unknown) => dispatch(deps(), agent, input, { timeoutMs: 60_000 });

beforeAll(async () => {
  db = await createTestDb('phase13_agents', { migrated: true });
  fx = await seedCreative(db.sql);
});
afterAll(async () => db?.drop());

describe('records agents through the Orchestrator', () => {
  it('records-catalog registers a track and tells the operator to enter splits', async () => {
    const r = await run('records-catalog', { release: { title: 'Night Drive', kind: 'single' }, track: { title: 'Night Drive', position: 1, source: { sunoTakeId: fx.takeId } } });
    expect(r.status).toBe('success');
    expect(r.output).toMatchObject({ release: { status: 'draft' }, next: expect.stringMatching(/pnpm records splits/) });
  });

  it('records-rights-splits flags an UNASSIGNED share and reports it', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 75 }, { payee: 'UNASSIGNED', role: 'publisher', percentage: 25 }], releaseDate: '2026-12-01' });
    const r = await run('records-rights-splits', { releaseId });
    expect(r.output).toMatchObject({ schedulable: false, tracks: [{ problems: ['UNASSIGNED share of 25%'] }], flagId: expect.any(String) });
  });

  it('records-rights-splits writes no flag for a schedulable release', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }], releaseDate: '2026-12-01' });
    const r = await run('records-rights-splits', { releaseId });
    expect(r.output).toMatchObject({ schedulable: true });
    expect((r.output as { flagId?: string }).flagId).toBeUndefined();
  });

  it('records-release-calendar refuses a blocked release and queues a clean one', async () => {
    const blocked = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 75 }, { payee: 'UNASSIGNED', role: 'publisher', percentage: 25 }] });
    const refused = await run('records-release-calendar', { releaseId: blocked.releaseId, releaseDate: '2026-12-01' });
    expect(refused.status).toBe('error');
    expect(refused.error).toMatch(/not schedulable: .*UNASSIGNED share of 25%.*records-rights-splits/);
    const clean = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }] });
    const ok = await run('records-release-calendar', { releaseId: clean.releaseId, releaseDate: '2026-12-01' });
    expect(ok.output).toMatchObject({ release: { status: 'pending_schedule', releaseDate: '2026-12-01' }, approvalId: expect.any(String) });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/phase-13/records-agents.test.ts`
Expected: FAIL — `no handler registered for records-catalog`.

- [ ] **Step 4: Implement the handlers**

```ts
// records/ops/agents.ts
import type { AgentHandler } from '../../core/orchestrator/dispatch.ts';
import { checkSchedulable, type ReleaseView, type ScheduleReport } from './schedulable.ts';

/** Records ops agents (Phase 13): deterministic; every write goes through a tool under its own DB role. */

export const recordsCatalog: AgentHandler = async (ctx, input) => {
  const out = (await ctx.useTool('register_track', input)) as { release: { id: string; status: string }; track: { id: string; position: number } };
  return { ...out, next: `enter splits: pnpm records splits ${out.track.id} <file.yaml>` };
};

export const recordsRightsSplits: AgentHandler = async (ctx, input) => {
  const releaseId = (input as { releaseId?: unknown } | null)?.releaseId;
  const view = (await ctx.useTool('read_release', { releaseId })) as ReleaseView;
  const report = checkSchedulable(view);
  if (report.schedulable) return report;
  const { flag_id } = (await ctx.useTool('flag_release', { releaseId, report })) as { flag_id: string };
  return { ...report, flagId: flag_id };
};

const explain = (r: ScheduleReport): string =>
  [...r.problems, ...r.tracks.flatMap((t) => t.problems.map((p) => `track ${t.position}: ${p}`))].join('; ');

export const recordsReleaseCalendar: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as { releaseId?: unknown; releaseDate?: unknown };
  const view = (await ctx.useTool('read_release', { releaseId: i.releaseId })) as ReleaseView;
  const report = checkSchedulable({ ...view, releaseDate: typeof i.releaseDate === 'string' ? i.releaseDate : null });
  if (!report.schedulable) {
    throw new Error(`release ${view.id} is not schedulable: ${explain(report)}. Run records-rights-splits to flag it, fix the splits (pnpm records splits), then propose again.`);
  }
  const { approvalId } = (await ctx.useTool('propose_schedule', { releaseId: view.id, releaseDate: i.releaseDate })) as { approvalId: string };
  return { release: { id: view.id, status: 'pending_schedule', releaseDate: i.releaseDate }, approvalId };
};
```

In `core/runtime/handlers.ts`, import and register (after the `'x3lius-mix-master': mixMaster,` entry):

```ts
import { recordsCatalog, recordsReleaseCalendar, recordsRightsSplits } from '../../records/ops/agents.ts';
// …
  // Phase 13: Records ops (deterministic): catalog (Execution), rights splits (Governance), release calendar (Execution).
  'records-catalog': recordsCatalog,
  'records-rights-splits': recordsRightsSplits,
  'records-release-calendar': recordsReleaseCalendar,
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/phase-13/records-agents.test.ts tests/phase-04b tests/phase-04c`
Expected: PASS (4B loads every agent file; a bad frontmatter or a tool the class may not hold fails there). Also run `pnpm agents:validate` → no errors.

- [ ] **Step 6: Commit**

```bash
git add agents/records-*.agent.md records/ops/agents.ts core/runtime/handlers.ts tests/phase-13/records-agents.test.ts
git commit -F - <<'EOF'
Phase 13: records-catalog, records-rights-splits, records-release-calendar agents

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Operator path — splits file, `pnpm records splits`, scheduling decisions

**Files:**
- Create: `records/ops/splits.ts` (file parser + `replaceSplits`)
- Create: `records/ops/cli.ts`
- Modify: `package.json` (script `"records": "node records/ops/cli.ts"`)
- Modify: `knowledge/promotion-gate/gate.ts` (`pendingApprovals`, `decideQueueItem`)
- Modify: `knowledge/promotion-gate/cli.ts` (usage comment)
- Test: `records/ops/splits.test.ts`, `tests/phase-13/records-operator.test.ts`

**Interfaces:**
- Consumes: Task 3 `xyp_apply_release_decision`; Phase 12 `decideQueueItem(sql, approvalId, d, rerun)`.
- Produces: `parseSplitsFile(text: string): SplitRow[]`, `replaceSplits(sql: Sql, trackId: string, rows: readonly SplitRow[]): Promise<number>`, `SplitRow = { payee: string; role: SplitRole; percentage: number }`; `decideQueueItem` returns `{ approval, itemType, gate?, release? }` where `release = { id, status }` for `release_schedule`.

- [ ] **Step 1: Write the failing parser test**

```ts
// records/ops/splits.test.ts
import { describe, expect, it } from 'vitest';
import { parseSplitsFile } from './splits.ts';

describe('splits file (pnpm records splits)', () => {
  it('accepts two decimals (33.33, which is 3332.9999999999995 × 100 in floating point)', () => {
    expect(parseSplitsFile('splits:\n  - { payee: A, role: writer, percentage: 33.33 }\n')).toEqual([{ payee: 'A', role: 'writer', percentage: 33.33 }]);
  });

  it('reads payee, role and percentage rows', () => {
    expect(parseSplitsFile('splits:\n  - { payee: X3LIUS, role: writer, percentage: 50 }\n  - { payee: UNASSIGNED, role: publisher, percentage: 50 }\n'))
      .toEqual([{ payee: 'X3LIUS', role: 'writer', percentage: 50 }, { payee: 'UNASSIGNED', role: 'publisher', percentage: 50 }]);
  });

  it.each([
    ['a percent string', '{ payee: A, role: writer, percentage: "50%" }', /splits\[0\]\.percentage must be a number/],
    ['three decimals', '{ payee: A, role: writer, percentage: 33.333 }', /at most 2 decimals/],
    ['a negative', '{ payee: A, role: writer, percentage: -5 }', /above 0 and at most 100/],
    ['an unknown role', '{ payee: A, role: composer, percentage: 100 }', /role must be one of writer, producer, performer, publisher, other/],
    ['a blank payee', '{ payee: " ", role: writer, percentage: 100 }', /payee must be a non-empty string/],
    ['an unknown field', '{ payee: A, role: writer, percentage: 100, share: 1 }', /unknown field: share/],
  ])('refuses %s, naming the field', (_, row, why) => {
    expect(() => parseSplitsFile(`splits:\n  - ${row}\n`)).toThrow(why);
  });

  it('refuses a file with no splits list', () => {
    expect(() => parseSplitsFile('payees: []')).toThrow(/splits must be a non-empty list/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run records/ops/splits.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `splits.ts`**

```ts
// records/ops/splits.ts
import { parse as parseYaml } from 'yaml';
import type { Sql } from '../../core/db/client.ts';

/**
 * The operator's splits file and the one write path for splits (Phase 13). The file is checked for
 * shape here; the always-100 rule is the DB's (a deferred trigger at commit), so a replace is one
 * transaction: delete the track's splits, insert the new set, commit.
 */

export const SPLIT_ROLES = ['writer', 'producer', 'performer', 'publisher', 'other'] as const;
export type SplitRole = (typeof SPLIT_ROLES)[number];
export type SplitRow = { readonly payee: string; readonly role: SplitRole; readonly percentage: number };

const FIELDS = new Set(['payee', 'role', 'percentage']);

/**
 * @param text - YAML: `splits: [{ payee, role, percentage }]`
 * @returns the rows
 * @throws Error naming the first invalid field
 */
export const parseSplitsFile = (text: string): SplitRow[] => {
  const y = (parseYaml(text) ?? {}) as { splits?: unknown };
  if (!Array.isArray(y.splits) || y.splits.length === 0) throw new Error('splits must be a non-empty list');
  return y.splits.map((v, i): SplitRow => {
    const at = `splits[${i}]`;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${at} must be a mapping`);
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!FIELDS.has(k)) throw new Error(`${at}: unknown field: ${k}`);
    if (typeof o.payee !== 'string' || o.payee.trim() === '') throw new Error(`${at}.payee must be a non-empty string`);
    if (!SPLIT_ROLES.includes(o.role as SplitRole)) throw new Error(`${at}.role must be one of ${SPLIT_ROLES.join(', ')}`);
    if (typeof o.percentage !== 'number' || !Number.isFinite(o.percentage)) throw new Error(`${at}.percentage must be a number`);
    if (o.percentage <= 0 || o.percentage > 100) throw new Error(`${at}.percentage must be above 0 and at most 100`);
    // 33.33 * 100 is 3332.9999999999995 in floating point: compare with a tolerance, not ===.
    if (Math.abs(Math.round(o.percentage * 100) - o.percentage * 100) > 1e-6) throw new Error(`${at}.percentage has at most 2 decimals`);
    return { payee: o.payee.trim(), role: o.role as SplitRole, percentage: o.percentage };
  });
};

/**
 * Replaces a track's splits as the operator (service_role), in one transaction.
 * @returns the number of rows written
 * @throws the DB's rights_splits_sum_not_100 / splits_locked_after_schedule errors, unchanged
 */
export const replaceSplits = (sql: Sql, trackId: string, rows: readonly SplitRow[]): Promise<number> =>
  sql.begin(async (tx) => {
    await tx.unsafe('set local role service_role');
    await tx`delete from rights_splits where track_id = ${trackId}`;
    for (const r of rows) {
      await tx`insert into rights_splits (track_id, payee, role, percentage) values (${trackId}, ${r.payee}, ${r.role}::split_role, ${r.percentage})`;
    }
    return rows.length;
  }) as Promise<number>;
```

- [ ] **Step 4: Write the failing operator test**

```ts
// tests/phase-13/records-operator.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideQueueItem, pendingApprovals } from '../../knowledge/promotion-gate/gate.ts';
import { replaceSplits } from '../../records/ops/splits.ts';
import { createTestDb, expectPgError, type TestDb } from '../helpers/db.ts';
import { seedRelease } from '../helpers/records-fixture.ts';

let db: TestDb;
beforeAll(async () => { db = await createTestDb('phase13_operator', { migrated: true }); });
afterAll(async () => db?.drop());

const propose = async (releaseId: string) => (await db.sql.begin(async (tx) => {
  await tx.unsafe('set local role xyp_calendar');
  return tx<{ id: string }[]>`select public.xyp_request_release_schedule(${releaseId}) as id`;
}))[0]!.id;
const noRerun = async () => { throw new Error('the gate must not re-run for a release_schedule'); };

describe('operator: splits and scheduling decisions', () => {
  it('replaces splits as service_role; a set that is not 100 is refused whole', async () => {
    const { trackIds: [t] } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }] });
    expect(await replaceSplits(db.sql, t!, [{ payee: 'A', role: 'writer', percentage: 50 }, { payee: 'B', role: 'producer', percentage: 50 }])).toBe(2);
    await expectPgError(() => replaceSplits(db.sql, t!, [{ payee: 'A', role: 'writer', percentage: 90 }]), '23514');
    expect(await db.sql`select payee from rights_splits where track_id = ${t!} order by payee`).toEqual([{ payee: 'A' }, { payee: 'B' }]);
  });

  it('the queue shows a release_schedule request; approve schedules it without re-running the gate', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }], releaseDate: '2026-12-01' });
    const id = await propose(releaseId);
    expect((await pendingApprovals(db.sql)).find((p) => p.approval_id === id)).toMatchObject({ item_type: 'release_schedule', schedule: { release_id: releaseId, release_date: '2026-12-01' } });
    const out = await decideQueueItem(db.sql, id, { decision: 'approve', approver: 'operator:test', reason: 'date confirmed' }, noRerun);
    expect(out).toEqual({ approval: 'approved', itemType: 'release_schedule', release: { id: releaseId, status: 'scheduled' } });
  });

  it('reject sends the release back to draft', async () => {
    const { releaseId } = await seedRelease(db.sql, { splits: [{ payee: 'A', role: 'writer', percentage: 100 }], releaseDate: '2026-12-01' });
    const id = await propose(releaseId);
    const out = await decideQueueItem(db.sql, id, { decision: 'reject', approver: 'operator:test', reason: 'move the date' }, noRerun);
    expect(out).toMatchObject({ release: { id: releaseId, status: 'draft' } });
  });
});
```

- [ ] **Step 5: Update `gate.ts`**

In `PendingApproval` add `readonly schedule: unknown;` with doc `/** A release_schedule's request (Phase 13): release, date, tracks. */`, and in `pendingApprovals`'s select add `case when item_type = 'release_schedule' then request end as schedule`.

Replace `decideQueueItem`'s body:

```ts
export const decideQueueItem = async (
  sql: Sql,
  approvalId: string,
  d: { readonly decision: 'approve' | 'reject'; readonly approver: string; readonly reason: string },
  rerun: (candidateId: string) => Promise<unknown>,
): Promise<{ readonly approval: 'approved' | 'rejected'; readonly itemType: string; readonly gate?: unknown; readonly release?: { readonly id: string; readonly status: string } }> => {
  const approval = await decideApproval(sql, approvalId, d);
  const [item] = await sql<{ item_id: string; item_type: string }[]>`select item_id, item_type::text from approval_queue where id = ${approvalId}`;
  if (item!.item_type === 'knowledge_candidate') return { approval, itemType: item!.item_type, gate: await rerun(item!.item_id) };
  if (item!.item_type === 'release_schedule') {
    // Phase 13: the sealed decision is applied by the DB (the scheduling gate re-checks on approve).
    const [r] = await asRole(sql, OPERATOR_ROLE, (tx) => tx<{ id: string; status: string }[]>`
      select q.release_id as id, public.xyp_apply_release_decision(${approvalId})::text as status
      from release_schedule_requests q where q.id = ${item!.item_id}`);
    return { approval, itemType: item!.item_type, release: r! };
  }
  return { approval, itemType: item!.item_type };
};
```

Update the doc comment above it: "a knowledge candidate then goes back through the gate; a release schedule is applied (approve → scheduled, reject → draft); a critique escalation's decision is only recorded." Update the usage comment in `knowledge/promotion-gate/cli.ts` the same way.

`gate.ts`'s `asRole` (from `research-intelligence/db.ts`) runs `sql.begin` and commits, unlike the test helper's rolled-back `asRole`, so the applied decision persists.

- [ ] **Step 6: Write the CLI**

```ts
// records/ops/cli.ts
import { readFileSync } from 'node:fs';
import { connect } from '../../core/db/client.ts';
import { parseSplitsFile, replaceSplits } from './splits.ts';

// Operator access to Records ops (Phase 13; the UI is Phase 16):
//   pnpm records splits <trackId> <file.yaml>   — replace a track's rights splits (must total exactly 100)
// Scheduling decisions go through the approval queue: pnpm gate queue / pnpm gate decide.

const [cmd, trackId, file] = process.argv.slice(2);
const sql = connect();
try {
  if (cmd !== 'splits' || !trackId || !file) throw new Error('usage: pnpm records splits <trackId> <file.yaml>');
  const rows = parseSplitsFile(readFileSync(file, 'utf8'));
  const written = await replaceSplits(sql, trackId, rows);
  console.log(JSON.stringify({ trackId, written, splits: rows }, null, 2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
```

Add to `package.json` scripts, after `"gate"`: `"records": "node records/ops/cli.ts"`. Add to the README command block: `pnpm records splits <trackId> <file.yaml>   # Phase 13: replace a track's rights splits (exactly 100, DB-enforced)`.

- [ ] **Step 7: Run to verify**

Run: `npx vitest run records/ops/splits.test.ts tests/phase-13/records-operator.test.ts tests/phase-12/critiques-db.test.ts`
Expected: PASS (the Phase 12 escalation-decision test still passes: its branch is unchanged).

- [ ] **Step 8: Commit**

```bash
git add records/ops/splits.ts records/ops/splits.test.ts records/ops/cli.ts package.json README.md knowledge/promotion-gate/gate.ts knowledge/promotion-gate/cli.ts tests/phase-13/records-operator.test.ts
git commit -F - <<'EOF'
Phase 13: operator path: splits file + pnpm records splits; release_schedule decisions applied

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: End-to-end proof, mutation pass, docs, dev DB

**Files:**
- Create: `tests/phase-13/records-e2e.test.ts`
- Create: `docs/proofs/PHASE-13-records.txt`, `docs/handoffs/PHASE-13.md`
- Modify: `docs/SCHEMA.md` (Phase 13 section), `docs/ARCHITECTURE.md` (F31–F33, F3 resolved), `README.md` (Phase 13 line)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the end-to-end test**

```ts
// tests/phase-13/records-e2e.test.ts
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { decideQueueItem } from '../../knowledge/promotion-gate/gate.ts';
import { replaceSplits } from '../../records/ops/splits.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { seedCreative, SHA } from '../helpers/records-fixture.ts';

// Phase 13 proof (end to end): catalog → splits with an UNASSIGNED share → Rights flags → Calendar
// refuses → fix splits → Calendar queues → operator approves → scheduled.
let db: TestDb;
let fx: Awaited<ReturnType<typeof seedCreative>>;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const run = (agent: string, input: unknown) =>
  dispatch({ sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS } as DispatchDeps, agent, input, { timeoutMs: 60_000 });
const noRerun = async () => { throw new Error('no gate re-run for a release'); };

beforeAll(async () => {
  db = await createTestDb('phase13_e2e', { migrated: true });
  fx = await seedCreative(db.sql);
});
afterAll(async () => db?.drop());

describe('PROOF: a two-track single from registration to scheduled', () => {
  it('runs the whole path, and every write is audited', async () => {
    const first = await run('records-catalog', { release: { title: 'Night Drive', kind: 'ep' }, track: { title: 'Night Drive', position: 1, source: { sunoTakeId: fx.takeId }, artifactIds: [fx.lyricsId, fx.promptId] } });
    const releaseId = (first.output as { release: { id: string } }).release.id;
    const t1 = (first.output as { track: { id: string } }).track.id;
    const second = await run('records-catalog', { releaseId, track: { title: 'Wet Asphalt', position: 2, source: { masterUri: 'file:///masters/wet-asphalt.wav', masterSha256: SHA }, mixReportId: fx.mixReportId } });
    const t2 = (second.output as { track: { id: string } }).track.id;

    await replaceSplits(db.sql, t1, [{ payee: 'X3LIUS', role: 'writer', percentage: 50 }, { payee: 'Producer A', role: 'producer', percentage: 50 }]);
    await replaceSplits(db.sql, t2, [{ payee: 'X3LIUS', role: 'writer', percentage: 75 }, { payee: 'UNASSIGNED', role: 'publisher', percentage: 25 }]);

    const flagged = await run('records-rights-splits', { releaseId });
    expect(flagged.output).toMatchObject({ schedulable: false, flagId: expect.any(String) });
    const refused = await run('records-release-calendar', { releaseId, releaseDate: '2026-12-04' });
    expect(refused.status).toBe('error');

    await replaceSplits(db.sql, t2, [{ payee: 'X3LIUS', role: 'writer', percentage: 75 }, { payee: 'Publisher B', role: 'publisher', percentage: 25 }]);
    expect((await run('records-rights-splits', { releaseId })).output).toMatchObject({ schedulable: true });
    const queued = await run('records-release-calendar', { releaseId, releaseDate: '2026-12-04' });
    const approvalId = (queued.output as { approvalId: string }).approvalId;

    const decided = await decideQueueItem(db.sql, approvalId, { decision: 'approve', approver: 'operator:phase-13-proof', reason: 'splits complete, date confirmed' }, noRerun);
    expect(decided.release).toEqual({ id: releaseId, status: 'scheduled' });

    const audit = await db.sql<{ table_name: string; n: number }[]>`
      select table_name, count(*)::int as n from audit_log group by 1 order by 1`;
    expect(audit.map((a) => a.table_name)).toEqual(['releases', 'rights_splits', 'tracks']);
  });
});
```

- [ ] **Step 2: Run the whole suite and typecheck**

Run: `..\..\..\node_modules\.bin\tsc.cmd --noEmit -p .` then `npx vitest run`
Expected: tsc clean; every test file passes (the Phase 12 total, 893, plus the Phase 13 tests).

- [ ] **Step 3: Mutation pass**

For each rule, comment it out in the migration, run `npx vitest run tests/phase-13`, confirm at least one test fails, restore it. Record each result in the proof log:

1. `trg_rights_splits_sum` (drop the constraint trigger) → split-sum tests fail.
2. The `v_total <> 100` comparison changed to `v_total > 100` → the 99.99 / 60 tests fail.
3. `trg_rights_splits_lock` → lock test fails.
4. The UNASSIGNED branch in `xyp_releases_guard` → gate test "an UNASSIGNED share" fails.
5. The transition check in `xyp_releases_guard` → status-path test fails.
6. The `release_locked` branch → locks-outside-draft test fails.
7. `trg_tracks_lock` → locks-outside-draft test fails.
8. `tracks_one_source` → one-source test fails.
9. The `applied_at is null` guard in `xyp_apply_release_decision` → "applied once only" fails.
10. The `grant insert … to xyp_catalog` narrowed / `rights_splits` grant widened to `xyp_catalog` → roles test fails.

- [ ] **Step 4: Apply to the dev DB and run the proof commands**

```bash
pnpm db:up          # applies 20260925110000_records to the local dev DB (127.0.0.1)
pnpm db:status      # expect: applied 20260925110000_records
```

Then paste into `docs/proofs/PHASE-13-records.txt`: the status block of the guide's deliverables; the `npx vitest run tests/phase-13` summary; the mutation table (10/10); and the rollback check (`pnpm db:down` then `pnpm db:up` on a throwaway DB — the phase-01 migration test covers this; cite its result).

- [ ] **Step 5: Write the docs**

- `docs/SCHEMA.md`: a "Phase 13 additions" section (migration `20260925110000_records.sql`) listing the tables, the always-100 deferred trigger, the scheduling gate, locks outside draft, `release_schedule_requests`, `records_flags`, `audit_log`, roles and the two functions — same bullet style as the Phase 12 section.
- `docs/ARCHITECTURE.md`: mark F3 DECIDED (Records owns `rights_splits`; Governance's `records-rights-splits` reads and flags). Add F31 (splits always 100 with explicit UNASSIGNED; user), F32 (track source: Suno take or studio master; user), F33 (scheduling: agent proposes, operator approves; user). Replace "Nothing may UPDATE or DELETE `audit_log`" context with a pointer to the Phase 13 table.
- `README.md`: `- [~] Phase 13: XYP3RN Records. Built and proven (split-sum constraint, scheduling gate, three agents, operator approval); applied to the local dev DB ([handoff](docs/handoffs/PHASE-13.md))`.
- `docs/handoffs/PHASE-13.md`: the same shape as `PHASE-12.md` (Built / Key decisions / Deviations — the two spec amendments and the `audit_log` name / Open flags / **Next phase needs (14)**, 5 bullets: TRACE analysis intake feeds `tracks.mix_report_id` for studio masters; take scoring via TRACE closes the Phase 9 stub; the R&D backlog agent is Planning and now holds `records.read` if it needs catalog context; ISRC/UPC assignment remains manual; Phase 15's rights-conflict agent reads `rights_splits` + `records_flags`).

- [ ] **Step 6: Commit**

```bash
git add tests/phase-13/records-e2e.test.ts docs/proofs/PHASE-13-records.txt docs/handoffs/PHASE-13.md docs/SCHEMA.md docs/ARCHITECTURE.md README.md
git commit -F - <<'EOF'
Phase 13: end-to-end proof, mutation pass, schema/architecture docs, handoff

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```
