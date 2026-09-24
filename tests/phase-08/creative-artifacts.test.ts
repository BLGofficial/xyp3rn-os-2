import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRole, createTestDb, expectPgError, withRollback, type TestDb } from '../helpers/db.ts';

// Phase 8: creative_artifacts — the Creative class's only output table (capability artifact.write).
// Insert-only and versioned: a new version names its parent; lineage and version number are
// derived by the database, never trusted from the caller; no role, the owner included, can
// UPDATE or DELETE a written version (AGENT_CLASSES.md: "previously written artifact versions").

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('phase08_artifacts', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

const CREATIVE = 'xyp_creative';

const openRun = (tx: postgres.TransactionSql) =>
  tx<{ id: string }[]>`
    insert into agent_runs (agent_name, class, domain, input)
    values ('x3lius-lyrics', 'Creative', 'RECORDS', ${tx.json({ request: 'verse' })}) returning id`.then((r) => r[0]!.id);

type Row = { id: string; lineage_id: string; version: number; parent_id: string | null };
const write = (tx: postgres.TransactionSql, runId: string, parentId: string | null = null, schemaId = 'x3lius.lyrics/v1') =>
  tx<Row[]>`
    insert into creative_artifacts (schema_id, agent_name, agent_run_id, parent_id, brief, body, context_refs, knowledge, model)
    values (${schemaId}, 'x3lius-lyrics', ${runId}, ${parentId}, 'a verse', ${tx.json({ bars: [] })},
            ${tx.json([{ table: 'canonical_prompts', id: '00000000-0000-0000-0000-000000000000' }])},
            ${tx.json({ sparse: true })}, 'openrouter:anthropic/claude-opus-5')
    returning id, lineage_id, version, parent_id`.then((r) => r[0]!);

describe('versioning is derived by the database', () => {
  it('v1 starts its own lineage; v2 and v3 chain from their parents', async () => {
    await withRollback(db.sql, async (tx) => {
      const run = await openRun(tx);
      const v1 = await write(tx, run);
      expect(v1).toMatchObject({ lineage_id: v1.id, version: 1, parent_id: null });
      const v2 = await write(tx, run, v1.id);
      expect(v2).toMatchObject({ lineage_id: v1.id, version: 2, parent_id: v1.id });
      const v3 = await write(tx, run, v2.id);
      expect(v3).toMatchObject({ lineage_id: v1.id, version: 3 });
    });
  });

  it('caller-supplied lineage/version are ignored, not trusted', async () => {
    await withRollback(db.sql, async (tx) => {
      const run = await openRun(tx);
      const [r] = await tx<Row[]>`
        insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model, lineage_id, version)
        values ('x3lius.lyrics/v1', 'x3lius-lyrics', ${run}, 'b', '{}', '[]', '{}', 'm', gen_random_uuid(), 7)
        returning id, lineage_id, version, parent_id`;
      expect(r).toMatchObject({ lineage_id: r!.id, version: 1 });
    });
  });

  it('history is linear: a second child of the same parent is refused', async () => {
    await withRollback(db.sql, async (tx) => {
      const run = await openRun(tx);
      const v1 = await write(tx, run);
      await write(tx, run, v1.id);
      await expectPgError(() => tx.savepoint((sp) => write(sp, run, v1.id)), '23505');
    });
  });

  it('a new version keeps its parent’s schema', async () => {
    await withRollback(db.sql, async (tx) => {
      const run = await openRun(tx);
      const v1 = await write(tx, run);
      await expectPgError(() => tx.savepoint((sp) => write(sp, run, v1.id, 'x3lius.composition/v1')), '23514');
    });
  });

  it('every artifact names the run that wrote it and a versioned schema id', async () => {
    await withRollback(db.sql, async (tx) => {
      await expectPgError(() => tx.savepoint((sp) => write(sp, '00000000-0000-0000-0000-000000000000')), '23503');
      const run = await openRun(tx);
      await expectPgError(() => tx.savepoint((sp) => write(sp, run, null, 'lyrics')), '23514');
    });
  });

  it('warnings (migration 20260924200000) default to an empty list and must be a list', async () => {
    await withRollback(db.sql, async (tx) => {
      const run = await openRun(tx);
      const a = await write(tx, run);
      const [row] = await tx<{ warnings: unknown }[]>`select warnings from creative_artifacts where id = ${a.id}`;
      expect(row!.warnings).toEqual([]);
      await expectPgError(() => tx.savepoint((sp) => sp`
        insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model, warnings)
        values ('x3lius.lyrics/v1', 'x3lius-lyrics', ${run}, 'b', '{}', '[]', '{}', 'm', '{"kind":"mixed-script"}')`), '23514');
    });
  });
});

describe('insert-only for every role', () => {
  it('xyp_creative is granted INSERT and SELECT, nothing else', async () => {
    const privs = await db.sql<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
      where grantee = ${CREATIVE} and table_name = 'creative_artifacts' order by privilege_type`;
    expect(privs.map((p) => p.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });

  it('as xyp_creative: insert works; UPDATE and DELETE are refused', async () => {
    const [r] = await db.sql<{ id: string }[]>`
      insert into agent_runs (agent_name, class, domain, input) values ('x3lius-lyrics', 'Creative', 'RECORDS', '{}') returning id`;
    await asRole(db.sql, CREATIVE, async (tx) => {
      const v1 = await write(tx, r!.id);
      await expectPgError(() => tx.savepoint((sp) => sp`update creative_artifacts set brief = 'x' where id = ${v1.id}`), '42501');
      await expectPgError(() => tx.savepoint((sp) => sp`delete from creative_artifacts where id = ${v1.id}`), '42501');
    });
  });

  it('even the table owner cannot rewrite or delete a written version (trigger)', async () => {
    await withRollback(db.sql, async (tx) => {
      const v1 = await write(tx, await openRun(tx));
      await expectPgError(() => tx.savepoint((sp) => sp`update creative_artifacts set body = '{}' where id = ${v1.id}`), '55000');
      await expectPgError(() => tx.savepoint((sp) => sp`delete from creative_artifacts where id = ${v1.id}`), '55000');
    });
  });

  it('anon and authenticated have no access; RLS is on', async () => {
    for (const role of ['anon', 'authenticated']) {
      await asRole(db.sql, role, async (tx) => {
        await expectPgError(() => tx`select 1 from creative_artifacts`, '42501');
      });
    }
    const [t] = await db.sql<{ rls: boolean }[]>`select relrowsecurity as rls from pg_class where oid = 'public.creative_artifacts'::regclass`;
    expect(t!.rls).toBe(true);
  });

  it('xyp_creative cannot touch canonical knowledge — including the rules it consumes (42501)', async () => {
    for (const stmt of [
      `insert into canonical_prompts (module_id, slug, title, body, promoted_via) select id, 'creative-write', 'x', 'x', 'gate' from modules limit 1`,
      `insert into modules (slug, title, domain, promoted_via) values ('creative-write', 'x', 'RECORDS', 'gate')`,
      `update canonical_prompts set body = 'rewritten by a creative agent'`,
      `insert into knowledge_candidates (proposed_kind, target_slug, title, body, domain) values ('canonical_prompt', 'x', 'x', 'x', 'RECORDS')`,
    ]) {
      await expectPgError(() => asRole(db.sql, CREATIVE, (tx) => tx.unsafe(stmt)), '42501');
    }
  });

  it('xyp_runtime (Knowledge/context reads) cannot write artifacts', async () => {
    await asRole(db.sql, 'xyp_runtime', async (tx) => {
      await expectPgError(() => tx`insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model)
        values ('x3lius.lyrics/v1', 'a', gen_random_uuid(), 'b', '{}', '[]', '{}', 'm')`, '42501');
    });
  });
});
