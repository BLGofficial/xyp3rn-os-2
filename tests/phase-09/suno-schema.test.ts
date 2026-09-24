import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRole, createTestDb, expectPgError, withRollback, type TestDb } from '../helpers/db.ts';

// Phase 9: the Suno audit trail. suno_submissions (the exact prompt sent, per formula artifact),
// suno_takes (what came back) and take_scores (the scoring hook — stub rows until the Phase 12
// Critic). All three are insert-only for every role; the Execution role (xyp_execution) appends
// them and reads the artifact it submits; nothing here can touch canonical knowledge.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('phase09_schema', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

const EXEC = 'xyp_execution';
const PROMPT = { title: 't', style: 's', excludeStyles: [], lyrics: '[Verse 1]\nx' };

const run = (tx: postgres.TransactionSql, agent = 'suno-submitter') =>
  tx<{ id: string }[]>`insert into agent_runs (agent_name, class, domain, input) values (${agent}, 'Execution', 'RECORDS', '{}') returning id`.then((r) => r[0]!.id);

const artifact = async (tx: postgres.TransactionSql, schemaId = 'x3lius.suno-prompt/v1') => {
  const r = await run(tx, 'x3lius-suno');
  const [a] = await tx<{ id: string }[]>`
    insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model)
    values (${schemaId}, 'x3lius-suno', ${r}, 'b', '{}', '[]', '{}', 'm') returning id`;
  return a!.id;
};

const submission = async (tx: postgres.TransactionSql, adapter = 'manual', taskId: string | null = null) => {
  const [s] = await tx<{ id: string }[]>`
    insert into suno_submissions (formula_artifact_id, agent_run_id, adapter, suno_model, prompt, provider_task_id)
    values (${await artifact(tx)}, ${await run(tx)}, ${adapter}, 'v5', ${tx.json(PROMPT)}, ${taskId}) returning id`;
  return s!.id;
};

const take = async (tx: postgres.TransactionSql, submissionId: string, url = 'https://cdn.example.org/take-1.mp3') => {
  const [t] = await tx<{ id: string }[]>`
    insert into suno_takes (submission_id, agent_run_id, audio_url) values (${submissionId}, ${await run(tx)}, ${url}) returning id`;
  return t!.id;
};

describe('suno_submissions', () => {
  it('records the adapter, the model and the full prompt; the provider task id matches the adapter', async () => {
    await withRollback(db.sql, async (tx) => {
      await submission(tx, 'manual', null);
      await submission(tx, 'sunoapi', 'task-1');
      await expectPgError(() => tx.savepoint((sp) => submission(sp, 'manual', 'task-2')), '23514');
      await expectPgError(() => tx.savepoint((sp) => submission(sp, 'sunoapi', null)), '23514');
      await expectPgError(() => tx.savepoint((sp) => submission(sp, 'browser', null)), '23514');
    });
  });

  it('the prompt must carry every Suno field', async () => {
    await withRollback(db.sql, async (tx) => {
      await expectPgError(() => tx.savepoint(async (sp) => sp`
        insert into suno_submissions (formula_artifact_id, agent_run_id, adapter, suno_model, prompt)
        values (${await artifact(sp)}, ${await run(sp)}, 'manual', 'v5', ${sp.json({ style: 's' })})`), '23514');
    });
  });
});

describe('suno_takes', () => {
  it('needs an https audio URL, and a submission records each URL once', async () => {
    await withRollback(db.sql, async (tx) => {
      const s = await submission(tx);
      await take(tx, s);
      await expectPgError(() => tx.savepoint((sp) => take(sp, s)), '23505');
      await expectPgError(() => tx.savepoint((sp) => take(sp, s, 'http://cdn.example.org/x.mp3')), '23514');
      await expectPgError(() => tx.savepoint((sp) => take(sp, s, 'file:///etc/passwd')), '23514');
    });
  });
});

describe('take_scores: the scoring hook', () => {
  it('a stub row carries no score; a real row must carry one', async () => {
    await withRollback(db.sql, async (tx) => {
      const t = await take(tx, await submission(tx));
      await tx`insert into take_scores (take_id, scorer, is_stub, score, detail) values (${t}, 'stub:phase-12-critic', true, null, '{}')`;
      await expectPgError(() => tx.savepoint((sp) => sp`insert into take_scores (take_id, scorer, is_stub, score, detail) values (${t}, 'stub', true, 0.5, '{}')`), '23514');
      await expectPgError(() => tx.savepoint((sp) => sp`insert into take_scores (take_id, scorer, is_stub, score, detail) values (${t}, 'critic', false, null, '{}')`), '23514');
    });
  });
});

describe('insert-only for every role', () => {
  it.each(['suno_submissions', 'suno_takes', 'take_scores'])('%s: xyp_execution holds INSERT + SELECT only', async (table) => {
    const privs = await db.sql<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
      where grantee = ${EXEC} and table_name = ${table} order by privilege_type`;
    expect(privs.map((p) => p.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });

  it('even the owner cannot rewrite or delete a submission, take or score (trigger)', async () => {
    await withRollback(db.sql, async (tx) => {
      const s = await submission(tx);
      const t = await take(tx, s);
      await tx`insert into take_scores (take_id, scorer, is_stub, detail) values (${t}, 'stub:phase-12-critic', true, '{}')`;
      for (const stmt of [
        `update suno_submissions set suno_model = 'v4'`, `delete from suno_submissions`,
        `update suno_takes set title = 'x'`, `delete from suno_takes`,
        `update take_scores set scorer = 'x'`, `delete from take_scores`,
      ]) {
        await expectPgError(() => tx.savepoint((sp) => sp.unsafe(stmt)), '55000');
      }
    });
  });

  it('as xyp_execution: reads the artifact it submits, appends the trail, cannot write artifacts or canonical knowledge', async () => {
    const [r] = await db.sql<{ id: string }[]>`insert into agent_runs (agent_name, class, domain, input) values ('suno-submitter', 'Execution', 'RECORDS', '{}') returning id`;
    const [ar] = await db.sql<{ id: string }[]>`insert into agent_runs (agent_name, class, domain, input) values ('x3lius-suno', 'Creative', 'RECORDS', '{}') returning id`;
    const [a] = await db.sql<{ id: string }[]>`
      insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model)
      values ('x3lius.suno-prompt/v1', 'x3lius-suno', ${ar!.id}, 'b', '{}', '[]', '{}', 'm') returning id`;
    await asRole(db.sql, EXEC, async (tx) => {
      expect(await tx`select 1 from creative_artifacts where id = ${a!.id}`).toHaveLength(1);
      await tx`insert into suno_submissions (formula_artifact_id, agent_run_id, adapter, suno_model, prompt) values (${a!.id}, ${r!.id}, 'manual', 'v5', ${tx.json(PROMPT)})`;
    });
    for (const stmt of [
      `insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model) values ('x3lius.lyrics/v1', 'a', gen_random_uuid(), 'b', '{}', '[]', '{}', 'm')`,
      `update canonical_prompts set body = 'rewritten by an execution agent'`,
      `insert into modules (slug, title, domain, promoted_via) values ('exec-write', 'x', 'RECORDS', 'gate')`,
    ]) {
      await expectPgError(() => asRole(db.sql, EXEC, (tx) => tx.unsafe(stmt)), '42501');
    }
  });

  it('xyp_runtime (context reads, read_artifact) may read artifacts but not the Suno trail, and writes nothing', async () => {
    await asRole(db.sql, 'xyp_runtime', async (tx) => {
      await tx`select 1 from creative_artifacts`;
      await expectPgError(() => tx.savepoint((sp) => sp`select 1 from suno_submissions`), '42501');
      await expectPgError(() => tx.savepoint((sp) => sp`insert into take_scores (take_id, scorer, is_stub, detail) values (gen_random_uuid(), 's', true, '{}')`), '42501');
    });
  });

  it('anon and authenticated have no access; RLS is on', async () => {
    for (const role of ['anon', 'authenticated']) {
      await asRole(db.sql, role, async (tx) => {
        await expectPgError(() => tx`select 1 from suno_takes`, '42501');
      });
    }
    const rls = await db.sql<{ relname: string; rls: boolean }[]>`
      select relname, relrowsecurity as rls from pg_class where relname in ('suno_submissions', 'suno_takes', 'take_scores') order by relname`;
    expect(rls.every((r) => r.rls)).toBe(true);
    expect(rls).toHaveLength(3);
  });
});
