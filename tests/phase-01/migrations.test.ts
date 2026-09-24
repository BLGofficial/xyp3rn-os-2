import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../../core/db/client.ts';
import { migrateDown, migrateUp, planMigrations } from '../../core/db/migrate.ts';
import { createTestDb, plan, type TestDb } from '../helpers/db.ts';

// Phase 1 proof: migrations are idempotent and reversible — up, re-up, down, re-down, up
// all succeed and the final schema is identical to the first.

const RESEARCH_TABLES = [
  'research_projects',
  'research_questions',
  'research_runs',
  'research_findings',
  'research_evidence',
  'research_sources',
  'experiments',
  'experiment_runs',
  'contradictions',
  'knowledge_candidates',
  'knowledge_versions',
];

/** Everything a migration can create in public, as one comparable, sorted snapshot. */
const snapshot = async (sql: Sql) => {
  const q = async (text: string) => (await sql.unsafe(text)).map((r) => JSON.stringify(r)).sort();
  return {
    columns: await q(`select table_name, column_name, data_type, is_nullable, column_default
                      from information_schema.columns where table_schema = 'public'`),
    constraints: await q(`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def
                          from pg_constraint where connamespace = 'public'::regnamespace`),
    indexes: await q(`select indexname, indexdef from pg_indexes where schemaname = 'public'`),
    enums: await q(`select t.typname, array_agg(e.enumlabel order by e.enumsortorder)::text as labels
                    from pg_type t join pg_enum e on e.enumtypid = t.oid
                    where t.typnamespace = 'public'::regnamespace group by 1`),
    triggers: await q(`select event_object_table, trigger_name, action_timing, event_manipulation
                       from information_schema.triggers where trigger_schema = 'public'`),
    functions: await q(`select proname, pg_get_function_identity_arguments(oid) as args
                        from pg_proc where pronamespace = 'public'::regnamespace`),
    views: await q(`select viewname, definition from pg_views where schemaname = 'public'`),
    rls: await q(`select relname, relrowsecurity from pg_class
                  where relnamespace = 'public'::regnamespace and relkind = 'r'`),
    grants: await q(`select table_name, grantee, privilege_type from information_schema.role_table_grants
                     where table_schema = 'public'`),
  };
};

const userObjects = async (sql: Sql) =>
  sql<{ kind: string; name: string }[]>`
    select 'relation' as kind, relname as name from pg_class
      where relnamespace = 'public'::regnamespace and relkind in ('r', 'v', 'i', 'S')
    union all select 'type', typname from pg_type
      where typnamespace = 'public'::regnamespace and typtype = 'e'
    union all select 'function', proname from pg_proc where pronamespace = 'public'::regnamespace`;

describe('migration plan', () => {
  it('pairs every migration with a rollback and reports every problem at once', () => {
    let message = '';
    try {
      planMigrations(['20260101000000_a.sql', 'bad.sql'], ['20260101000001_orphan.down.sql'], '/x');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('malformed migration name: bad.sql');
    expect(message).toContain('missing rollback for 20260101000000_a.sql');
    expect(message).toContain('rollback without migration: 20260101000001_orphan.down.sql');
  });

  it('ships the canonical base and the research extension stub, both reversible', () => {
    expect(plan().map((m) => m.name)).toEqual(['canonical_base', 'research_extension_stub']);
  });
});

describe('research_* extension stub (Phase 6 visibility only)', () => {
  it('lists all eleven Phase 6 tables, every line commented out', () => {
    const stub = plan().find((m) => m.name === 'research_extension_stub')!;
    const body = readFileSync(stub.upPath, 'utf8');
    for (const t of RESEARCH_TABLES) expect(body).toContain(t);
    const executable = body.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('--'));
    expect(executable).toEqual([]);
  });
});

describe('up / down', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb('phase01_migrations');
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('is idempotent and reversible, round-tripping to an identical schema', async () => {
    const migrations = plan();

    expect(await migrateUp(db.sql, migrations)).toHaveLength(migrations.length);
    const first = await snapshot(db.sql);
    expect(first.columns.length).toBeGreaterThan(0);
    for (const t of RESEARCH_TABLES) {
      const [r] = await db.sql<{ reg: string | null }[]>`select to_regclass(${`public.${t}`})::text as reg`;
      expect(r!.reg, `${t} must not exist before Phase 6`).toBeNull();
    }

    // Idempotent: re-running every up file raw (bypassing the tracker) changes nothing.
    for (const m of migrations) await db.sql.unsafe(readFileSync(m.upPath, 'utf8'));
    expect(await snapshot(db.sql)).toEqual(first);

    expect(await migrateDown(db.sql, migrations)).toHaveLength(migrations.length);
    expect(await userObjects(db.sql)).toEqual([]);

    // Rollbacks are idempotent too.
    for (const m of [...migrations].reverse()) await db.sql.unsafe(readFileSync(m.downPath, 'utf8'));
    expect(await userObjects(db.sql)).toEqual([]);

    await migrateUp(db.sql, migrations);
    expect(await snapshot(db.sql)).toEqual(first);
  });
});
