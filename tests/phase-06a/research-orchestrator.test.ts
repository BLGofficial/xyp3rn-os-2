import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { runResearch } from '../../research-intelligence/entrypoint.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// Phase 6A proof: the Research Orchestrator activates only relevant specialists and the runtime
// dispatches exactly those through the Workflow Engine, every run linked to the research_run.
// Specialists are LLM agents; with no LLM runner (Phase 8: nor a program for them) they must fail
// loudly — and the research run must record that, not pretend.

const specialist = (name: string, sentence: string, keywords: string) => `---
name: ${name}
class: Research
domain: RESEARCH_INTELLIGENCE
tools: [log_message]
model: claude-sonnet-5
---

# ${name} (Phase 6A test specialist)

## Role

Test-only Research specialist for the Phase 6A orchestration proof.

## Scope

${sentence}

Keywords: ${keywords}

## Contract

- **Inputs:** { question }.
- **Outputs:** evidence rows.

## Refuses

- Running outside tests/phase-06a.
`;

let db: TestDb;
let dir: string;
beforeAll(async () => {
  db = await createTestDb('phase06a_orch', { migrated: true });
  dir = mkdtempSync(join(tmpdir(), 'xyp-research-'));
  copyFileSync(join(REPO_ROOT, 'agents', 'research-orchestrator.agent.md'), join(dir, 'research-orchestrator.agent.md'));
  writeFileSync(join(dir, 'test-suno-specialist.agent.md'), specialist('test-suno-specialist', 'Gathers evidence on Suno prompt behaviour.', 'suno (3), style prompt (2)'));
  writeFileSync(join(dir, 'test-vocal-specialist.agent.md'), specialist('test-vocal-specialist', 'Gathers evidence on AI vocal timbre.', 'vocal (3), baritone (2)'));
  writeFileSync(join(dir, 'test-mix-specialist.agent.md'), specialist('test-mix-specialist', 'Gathers evidence on AI mastering tools.', 'master (3), loudness (2)'));
});
afterAll(async () => {
  await db?.drop();
});

describe('runResearch', () => {
  it('selects only relevant specialists, dispatches exactly those, links every run, and records the LLM gap', async () => {
    const registry = createAgentRegistry({ dir, log: () => {} });
    const deps = { sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS };
    const r = await runResearch(deps, { question: 'How do I control dark baritone vocals in Suno?', projectSlug: 'suno-vocal-control' }, { log: () => {} });

    // Selection order = score desc (vocal 5, suno 3); that is also the dispatch order.
    expect(r.selected).toEqual(['test-vocal-specialist', 'test-suno-specialist']);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/LLM runner unavailable: no LLM runner configured/);

    const [run] = await db.sql<{ status: string; selected_specialists: string[]; workflow_run_id: string | null; selection: { notSelected: { name: string }[] } }[]>`
      select status::text, selected_specialists, workflow_run_id, selection from research_runs where id = ${r.researchRunId}`;
    expect(run).toMatchObject({ status: 'error', selected_specialists: ['test-vocal-specialist', 'test-suno-specialist'] });
    expect(run!.workflow_run_id).not.toBeNull();
    expect(run!.selection.notSelected.map((s) => s.name)).toEqual(['test-mix-specialist']);

    const linked = await db.sql<{ agent_name: string; status: string }[]>`
      select agent_name, status::text from agent_runs where research_run_id = ${r.researchRunId} order by created_at`;
    expect(linked[0]).toEqual({ agent_name: 'research-orchestrator', status: 'success' });
    // Workflow fails at the first specialist; the second is recorded as not run.
    expect(linked.slice(1)).toEqual([{ agent_name: 'test-vocal-specialist', status: 'error' }]);
    expect(await db.sql`select 1 from agent_runs where agent_name = 'test-mix-specialist'`).toHaveLength(0);

    const [wf] = await db.sql<{ status: string; skipped_steps: string[] }[]>`
      select status::text, skipped_steps from workflow_runs where id = ${run!.workflow_run_id}`;
    expect(wf).toEqual({ status: 'error', skipped_steps: ['test-suno-specialist'] });
  });

  it('fails loudly when no Research specialist is registered at all (config error, not "no match")', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'xyp-research-empty-'));
    copyFileSync(join(REPO_ROOT, 'agents', 'research-orchestrator.agent.md'), join(empty, 'research-orchestrator.agent.md'));
    const registry = createAgentRegistry({ dir: empty, log: () => {} });
    const deps = { sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS };
    const r = await runResearch(deps, { question: 'How do I control dark baritone vocals in Suno?', projectSlug: 'suno-vocal-control' }, { log: () => {} });
    expect(r).toMatchObject({ status: 'error', selected: [] });
    expect(r.error).toBe('no Research specialists with a ## Scope are registered (roster is empty)');
  });

  it('records a question no specialist matches as a finished run with nothing dispatched', async () => {
    const registry = createAgentRegistry({ dir, log: () => {} });
    const deps = { sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS };
    const r = await runResearch(deps, { question: 'What should we eat tonight?', projectSlug: 'suno-vocal-control' }, { log: () => {} });
    expect(r).toMatchObject({ status: 'success', selected: [] });
    const [run] = await db.sql<{ workflow_run_id: string | null }[]>`select workflow_run_id from research_runs where id = ${r.researchRunId}`;
    expect(run!.workflow_run_id).toBeNull();
  });
});
