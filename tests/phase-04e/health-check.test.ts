import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { dispatch } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// Phase 4E: nothing stubbed — the real agents/ directory, the real handler map, the real tool
// registry, the real database path. This is what "Phase 4 done" means.

const AGENTS_DIR = join(REPO_ROOT, 'agents');

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('phase04e_health', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

describe('health-check through the full real path', () => {
  it('validateAll() over the whole agents/ directory comes back clean', () => {
    const registry = createAgentRegistry({ dir: AGENTS_DIR });
    expect(registry.validateAll()).toEqual([]);
    expect(registry.get('health-check')).toMatchObject({
      class: 'Execution',
      domain: 'CORE',
      tools: ['log_message'],
      model: 'none',
    });
  });

  it('registry → authorization → execution → one sealed success row, read back via SQL', async () => {
    const registry = createAgentRegistry({ dir: AGENTS_DIR });
    const input = { ping: 'xyp3rn', from: 'phase-04e' };
    const result = await dispatch({ sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS }, 'health-check', input);
    expect(result.status).toBe('success');

    const [row] = await db.sql<{ agent_name: string; class: string; domain: string; input: unknown; output: { result: { echo: unknown; timestamp: string }; logs: { level: string; message: string }[] }; status: string; tokens_used: number; latency_ms: number; completed_at: Date }[]>`
      select agent_name, class::text, domain::text, input, output, status::text, tokens_used, latency_ms, completed_at
      from agent_runs where id = ${result.runId}`;
    expect(row).toMatchObject({ agent_name: 'health-check', class: 'Execution', domain: 'CORE', input, status: 'success', tokens_used: 0 });
    expect(row!.output.result.echo).toEqual(input);
    expect(Number.isNaN(Date.parse(row!.output.result.timestamp))).toBe(false);
    expect(row!.output.logs.map((l) => l.message)).toEqual(['health-check: echoing input']);
    expect(row!.completed_at).not.toBeNull();
  });
});
