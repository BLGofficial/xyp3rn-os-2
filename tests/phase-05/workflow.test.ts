import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { loadWorkflow, runWorkflow, type EngineDeps } from '../../core/workflow-engine/engine.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { loadEmbedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { embedPending } from '../../knowledge/vector-retrieval/pipeline.ts';
import { asRole, createTestDb, expectPgError, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// Phase 5 proof: a real 2-step workflow (retrieve context -> summarize) over the real ingested
// build guide, one agent_runs row per step, and loud whole-run failure on any step error.

const SPEC = join(REPO_ROOT, 'core', 'workflows', 'retrieve-and-summarize.workflow.yaml');

let db: TestDb;
let deps: EngineDeps;
beforeAll(async () => {
  db = await createTestDb('phase05_workflow', { migrated: true });
  await ingestSource(db.sql, { kind: 'file', path: join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), origin: 'first_party' });
  await embedPending(db.sql, await loadEmbedder());
  const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
  deps = { sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS };
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

describe('schema: workflow_runs + agent_runs step linkage', () => {
  it('step linkage is fixed at insert: xyp_runtime cannot re-parent a step (42501)', async () => {
    await expectPgError(
      () =>
        asRole(db.sql, 'xyp_runtime', async (tx) => {
          const [w] = await tx<{ id: string }[]>`
            insert into workflow_runs (workflow_name, spec_sha256, spec, input) values ('x', ${'a'.repeat(64)}, '{}', '{}') returning id`;
          await tx`insert into agent_runs (agent_name, input, workflow_run_id, step_id) values ('health-check', '{}', ${w!.id}, 's1')`;
          await tx`update agent_runs set step_id = 's2'`;
        }),
      '42501',
    );
  });

  it('agent_runs.workflow_run_id is a restrict FK to workflow_runs', async () => {
    const [fk] = await db.sql<{ ref: string; del: string }[]>`
      select c.confrelid::regclass::text as ref, c.confdeltype as del from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f' and c.conrelid = 'public.agent_runs'::regclass and a.attname = 'workflow_run_id'`;
    expect(fk).toEqual({ ref: 'workflow_runs', del: 'r' });
  });

  it('workflow_run_id and step_id come as a pair (23514)', async () => {
    await expectPgError(() => db.sql`insert into agent_runs (agent_name, input, step_id) values ('x', '{}', 'orphan-step')`, '23514');
  });
});

describe('retrieve-and-summarize (real data, real agents)', () => {
  it('runs both steps, writes one agent_runs row per step, and returns a cited extractive summary', async () => {
    const spec = loadWorkflow(SPEC, deps.registry);
    const run = await runWorkflow(deps, spec, { query: 'Who is allowed to write canonical knowledge?' });
    expect(run.status).toBe('success');

    const steps = await db.sql<{ step_id: string; agent_name: string; status: string }[]>`
      select step_id, agent_name, status::text from agent_runs where workflow_run_id = ${run.workflowRunId} order by created_at`;
    expect(steps).toEqual([
      { step_id: 'retrieve', agent_name: 'context-retriever', status: 'success' },
      { step_id: 'summarize', agent_name: 'extractive-summarizer', status: 'success' },
    ]);

    const summary = run.output as { method: string; bullets: { text: string; cite: { table: string; id: string } }[] };
    expect(summary.method).toBe('extractive');
    expect(summary.bullets.length).toBeGreaterThan(0);
    for (const b of summary.bullets) {
      const [r] = await db.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from public.${b.cite.table} where id = $1`, [b.cite.id]);
      expect(r!.n, `${b.cite.table}:${b.cite.id}`).toBe(1);
    }

    const [wf] = await db.sql<{ status: string; spec_sha256: string }[]>`
      select status::text, spec_sha256 from workflow_runs where id = ${run.workflowRunId}`;
    expect(wf!.status).toBe('success');
    expect(wf!.spec_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails the whole run loudly when a step fails: no partial success, later steps recorded as not run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyp-wf-'));
    const broken = join(dir, 'broken.workflow.yaml');
    // Real agents, but the summarize step is fed the query where it expects the item list.
    writeFileSync(
      broken,
      readFileSync(SPEC, 'utf8')
        .replace('name: retrieve-and-summarize', 'name: retrieve-and-summarize-broken')
        .replace('items: { $from: steps.retrieve.output.items }', 'items: { $from: input.query }')
        .concat('  - id: check\n    agent: health-check\n    dependsOn: [summarize]\n    input: { ping: after-summary }\n'),
    );
    const spec = loadWorkflow(broken, deps.registry);
    const run = await runWorkflow(deps, spec, { query: 'anything' });

    expect(run.status).toBe('error');
    expect(run.failedStep).toBe('summarize');
    expect(run.error).toMatch(/items must be an array of context items/);
    expect(run.skippedSteps).toEqual(['check']);

    const [wf] = await db.sql<{ status: string; failed_step: string; error_detail: string }[]>`
      select status::text, failed_step, error_detail from workflow_runs where id = ${run.workflowRunId}`;
    expect(wf).toMatchObject({ status: 'error', failed_step: 'summarize' });
    const rows = await db.sql<{ step_id: string; status: string }[]>`
      select step_id, status::text from agent_runs where workflow_run_id = ${run.workflowRunId} order by created_at`;
    expect(rows).toEqual([
      { step_id: 'retrieve', status: 'success' },
      { step_id: 'summarize', status: 'error' },
    ]);
  });

  it('seals a finished workflow run (55000)', async () => {
    const [w] = await db.sql<{ id: string }[]>`select id from workflow_runs where status <> 'running' limit 1`;
    await expectPgError(() => db.sql`update workflow_runs set error_detail = 'rewrite' where id = ${w!.id}`, '55000');
  });

  it('never leaves a workflow or step running/pending', async () => {
    expect(await db.sql`select 1 from workflow_runs where status = 'running'`).toHaveLength(0);
    expect(await db.sql`select 1 from agent_runs where status = 'pending'`).toHaveLength(0);
  });
});
