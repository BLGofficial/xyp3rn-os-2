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
