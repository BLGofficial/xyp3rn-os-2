import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import { PROVIDERS } from '../../../core/llm/providers.ts';
import { createRuntimeTools } from '../../../core/runtime/tools.ts';
import { CAPABILITIES } from '../../../core/tool-registry/capabilities.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../../../tests/helpers/db.ts';
import { adminOverview } from './admin-loaders.ts';

// Jarvis Prompt 01 Task 7 (J1): System Admin. Registry counts read from the live registries and the database,
// roles by name only, migrations as the tracker records them, and secrets as Configured / Not configured: a key's
// value never appears in what the page is given.

let db: TestDb;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const SECRET = '[FAKE]-sk-or-v1-0123456789abcdef-never-shown';

beforeAll(async () => {
  db = await createTestDb('jarvis01_admin', { migrated: true });
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const load = (env: Record<string, string | undefined> = {}) =>
  adminOverview(db.sql, { env, registry, tools: createRuntimeTools({ sql: db.sql, env }) });

describe('adminOverview', () => {
  it('counts the registries as the registries and the database hold them', async () => {
    const o = await load();
    const [m] = await db.sql<{ n: number }[]>`select count(distinct slug)::int as n from modules`;
    const [w] = await db.sql<{ n: number }[]>`select count(*)::int as n from graph_nodes where kind = 'workflow'`;
    expect(Object.fromEntries(o.registries.map((r) => [r.name, r.count]))).toEqual({
      Agents: registry.list().length, Tools: createRuntimeTools({ sql: db.sql }).list().length, Capabilities: CAPABILITIES.length,
      'Workflow files': w!.n, Modules: m!.n,
    });
    for (const r of o.registries) expect(r.source).toEqual(expect.any(String));
  });

  it('reads the migration head and applied count from the tracker', async () => {
    const [t] = await db.sql<{ head: string; n: number }[]>`select max(version) as head, count(*)::int as n from xyp_meta.applied_migrations`;
    expect((await load()).migrations).toEqual({ head: t!.head, applied: t!.n });
  });

  it('lists the xyp roles by name only', async () => {
    const o = await load();
    expect(o.roles).toEqual(expect.arrayContaining(['xyp_web', 'xyp_indexer']));
    for (const r of o.roles) expect(r).toMatch(/^xyp_[a-z_]+$/);
  });

  it('says whether a provider key is configured, never its value', async () => {
    const env = { OPENROUTER_API_KEY: SECRET };
    const o = await load(env);
    expect(JSON.stringify(o)).not.toContain(SECRET);
    expect(JSON.stringify(o)).not.toContain('0123456789abcdef');
    expect(o.secrets.find((s) => s.name === 'OPENROUTER_API_KEY')).toEqual({ name: 'OPENROUTER_API_KEY', configured: true });
    expect(o.secrets.map((s) => s.name).sort()).toEqual(Object.values(PROVIDERS).map((p) => p.keyEnv).sort());
    expect(o.secrets.filter((s) => s.configured)).toHaveLength(1);
  });
});
