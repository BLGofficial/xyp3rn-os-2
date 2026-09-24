import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_CLASSES } from '../../core/contracts/taxonomy.ts';
import { asRole, createTestDb, expectPgError, withRollback, type TestDb } from '../helpers/db.ts';

// Phase 4A proof: agent_runs is append-then-seal. Identity columns are immutable from the
// moment of insert (grant level); the whole row is sealed once it leaves 'pending' (trigger).

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('phase04a_runs', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

const RUNTIME = 'xyp_runtime';
const openRun = (tx: postgres.TransactionSql) =>
  tx<{ id: string }[]>`
    insert into agent_runs (agent_name, class, domain, input)
    values ('health-check', 'Execution', 'CORE', ${tx.json({ ping: 'xyp' })}) returning id`.then((r) => r[0]!.id);

describe('schema', () => {
  it('agent_run_status is exactly pending | success | error', async () => {
    const rows = await db.sql<{ v: string }[]>`select unnest(enum_range(null::agent_run_status))::text as v`;
    expect(rows.map((r) => r.v)).toEqual(['pending', 'success', 'error']);
  });

  it('xyp_agent_class mirrors core/contracts/taxonomy.ts AGENT_CLASSES', async () => {
    const rows = await db.sql<{ v: string }[]>`select unnest(enum_range(null::xyp_agent_class))::text as v`;
    expect(rows.map((r) => r.v)).toEqual([...AGENT_CLASSES]);
  });

  it('indexes (agent_name, created_at) and (status)', async () => {
    const idx = await db.sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'public' and tablename = 'agent_runs'`;
    const defs = idx.map((i) => i.indexdef).join('\n');
    expect(defs).toMatch(/agent_runs_agent_name_created_at_idx .*\(agent_name, created_at\)/);
    expect(defs).toMatch(/agent_runs_status_idx .*\(status\)/);
  });

  it('hand-inserted row proves the enum, then is deleted — no fixture left behind', async () => {
    await db.sql`insert into agent_runs (agent_name, class, domain, input, status)
                 values ('health-check', 'Execution', 'CORE', '{}', 'pending')`;
    await expectPgError(
      () => db.sql`insert into agent_runs (agent_name, input, status) values ('health-check', '{}', 'running')`,
      '22P02',
    );
    await db.sql`delete from agent_runs where agent_name = 'health-check'`;
    expect(await db.sql`select 1 from agent_runs`).toHaveLength(0);
  });

  it('a finished run has completed_at; an errored run says why', async () => {
    await withRollback(db.sql, async (tx) => {
      for (const stmt of [
        `insert into agent_runs (agent_name, input, status) values ('x', '{}', 'success')`,
        `insert into agent_runs (agent_name, input, status, completed_at) values ('x', '{}', 'error', now())`,
        `insert into agent_runs (agent_name, input, status, completed_at) values ('x', '{}', 'pending', now())`,
      ]) {
        await expectPgError(() => tx.savepoint((sp) => sp.unsafe(stmt)), '23514');
      }
    });
  });
});

describe(`${RUNTIME} grants: identity immutable once written`, () => {
  it.each([
    ['agent_name', `update agent_runs set agent_name = 'other'`],
    ['class', `update agent_runs set class = 'Governance'`],
    ['domain', `update agent_runs set domain = 'GOVERNANCE'`],
    ['input', `update agent_runs set input = '{"tampered": true}'`],
    ['created_at', `update agent_runs set created_at = now()`],
  ])('rejects UPDATE of %s after INSERT (42501)', async (_col, stmt) => {
    await expectPgError(
      () =>
        asRole(db.sql, RUNTIME, async (tx) => {
          await openRun(tx);
          await tx.unsafe(stmt);
        }),
      '42501',
    );
  });

  it('rejects DELETE (42501)', async () => {
    await expectPgError(
      () =>
        asRole(db.sql, RUNTIME, async (tx) => {
          await openRun(tx);
          await tx`delete from agent_runs`;
        }),
      '42501',
    );
  });

  it('allows the pending → success transition on the outcome columns', async () => {
    await asRole(db.sql, RUNTIME, async (tx) => {
      const id = await openRun(tx);
      await tx`update agent_runs set status = 'success', output = ${tx.json({ echo: 'xyp' })},
               tokens_used = 0, latency_ms = 3, completed_at = now() where id = ${id}`;
    });
  });
});

describe('seal: a finished run can never change again', () => {
  it.each(['success', 'error'])('rejects any UPDATE once status = %s (55000), even for the table owner', async (status) => {
    await expectPgError(
      () =>
        withRollback(db.sql, async (tx) => {
          const [r] = await tx<{ id: string }[]>`
            insert into agent_runs (agent_name, input) values ('health-check', '{}') returning id`;
          await tx`update agent_runs set status = ${status}, completed_at = now(),
                   error_detail = ${status === 'error' ? 'boom' : null} where id = ${r!.id}`;
          await tx`update agent_runs set output = '{"late": true}' where id = ${r!.id}`;
        }),
      '55000',
    );
  });
});
