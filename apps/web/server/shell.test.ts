import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../../core/runtime/tools.ts';
import { createLocalVaultStore } from '../../../knowledge/source-registry/vault-store.ts';
import { openResearch } from '../../../research-intelligence/entrypoint.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../../../tests/helpers/db.ts';
import { songCreate, songRevise, uploadFiles } from './ops.ts';
import { activity, METRIC_CARDS, metrics, metricsWith, pulse } from './shell-loaders.ts';

// AOS-04 Plan B, Task 4 (design §13.1, §20): the metric strip's four cards with their exact definitions,
// one as-of time, a failed card reading "unavailable" (never 0) while the others render; the system pulse
// (presence of provider keys, never their values or "connected"); recent activity across kinds.

let db: TestDb;
let deps: DispatchDeps;
const vaultDir = mkdtempSync(join(tmpdir(), 'aos04-shell-vault-'));
const ROUTES = [/^\/songs\/[0-9a-f-]{36}$/, /^\/research\/runs\/[0-9a-f-]{36}$/, /^\/vault\/lineages\/[0-9a-f-]{36}$/, /^\/releases\/[0-9a-f-]{36}$/];

beforeAll(async () => {
  db = await createTestDb('aos04_shell', { migrated: true });
  deps = {
    sql: db.sql, registry: createAgentRegistry({ dir: join(REPO_ROOT, 'agents') }), handlers: HANDLERS,
    tools: createRuntimeTools({ sql: db.sql, env: {}, vault: createLocalVaultStore(vaultDir) }),
  };
  // Songs: 2 idea, 1 writing, 1 released, 1 archived.
  for (const [title, status] of [['[FIXTURE] A', null], ['[FIXTURE] B', null], ['[FIXTURE] C', 'writing'], ['[FIXTURE] D', 'released'], ['[FIXTURE] E', 'archived']] as const) {
    const { songId } = await songCreate(deps, { title, artist: 'X3LIUS' });
    if (status) await songRevise(deps, { songId, status });
  }
  // Workflow runs: one running, one finished.
  for (const status of ['running', 'success'] as const) {
    await db.sql`insert into workflow_runs (workflow_name, spec_sha256, spec, input, status) values ('[FIXTURE] flow', ${'a'.repeat(64)}, '{}', '{}', ${status})`;
  }
  // A research run left open (running) and its brief (open).
  await openResearch(deps, { projectSlug: 'shell', question: '[FIXTURE] What should we eat tonight?' });
  // The Vault: two stored files, and one lineage with three versions.
  await uploadFiles(deps, [{ name: 'a.txt', bytes: new TextEncoder().encode('[FIXTURE] a') }, { name: 'b.txt', bytes: new TextEncoder().encode('[FIXTURE] b') }], {});
  const v1 = (await dispatch(deps, 'x3lius-studio-editor', { recipe: { name: '[FIXTURE] r', style: '[FIXTURE] s', excludeStyles: [] } })).output as { artifactId: string };
  const v2 = (await dispatch(deps, 'x3lius-studio-editor', { recipe: { name: '[FIXTURE] r', style: '[FIXTURE] s2', excludeStyles: [], parentId: v1.artifactId } })).output as { artifactId: string };
  await dispatch(deps, 'x3lius-studio-editor', { recipe: { name: '[FIXTURE] r', style: '[FIXTURE] s3', excludeStyles: [], parentId: v2.artifactId } });
}, 120_000);
afterAll(async () => {
  await db?.drop();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('metrics (§13.1)', () => {
  it('counts exactly what each definition says, with one as-of time for all four cards', async () => {
    const m = await metrics(db.sql);
    const card = (k: string) => m.cards.find((c) => c.key === k)!;
    expect(m.cards.map((c) => c.key)).toEqual(['activeSongs', 'runningWorkflows', 'vault', 'openBriefs']);
    expect(card('activeSongs')).toMatchObject({ value: 3, href: '/songs' });
    expect(card('activeSongs').definition).toMatch(/idea, writing, producing or releasing/);
    expect(card('runningWorkflows')).toMatchObject({ value: 1, secondary: { label: 'research runs', value: 1 } });
    expect(card('vault')).toMatchObject({ value: 2, secondary: { label: 'artifact lineages', value: 1 } });
    expect(card('openBriefs')).toMatchObject({ value: 1, href: '/research' });
    for (const c of m.cards) {
      expect(c.definition.length).toBeGreaterThan(20);
      expect(c.source).toMatch(/[a-z_]+/);
      expect(c.error).toBeUndefined();
    }
    expect(Number.isNaN(Date.parse(m.asOf))).toBe(false);
  });

  it('a card whose query fails reads unavailable (null, with the error), and the others still render', async () => {
    const broken = METRIC_CARDS.map((c) => (c.key === 'vault' ? { ...c, read: async (tx: import('postgres').TransactionSql) => tx`select 1 / 0 as n` .then(() => ({ value: 0 })) } : c));
    const m = await metricsWith(db.sql, broken);
    const vault = m.cards.find((c) => c.key === 'vault')!;
    expect(vault.value).toBeNull();
    expect(vault.error).toMatch(/division by zero/);
    expect(m.cards.find((c) => c.key === 'openBriefs')!.value).toBe(1);
  });
});

describe('pulse (§20)', () => {
  it('reports the database, the migration head, the agents, each provider key as Configured or Not configured, and the last ingestion', async () => {
    const rows = await pulse(db.sql, { OPENROUTER_API_KEY: 'sk-or-secret-value' }, deps.registry);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(byLabel.Database).toMatchObject({ state: 'ok' });
    expect(byLabel['Migration head']!.detail).toMatch(/^\d{14}$/);
    expect(byLabel.Agents!.detail).toMatch(/^\d+ registered$/);
    expect(byLabel.OpenRouter).toMatchObject({ state: 'configured', detail: 'OPENROUTER_API_KEY is set (not checked for reachability)' });
    expect(byLabel.Anthropic).toMatchObject({ state: 'not-configured' });
    expect(byLabel['Last ingestion']).toMatchObject({ state: 'unavailable' }); // none in this database
    expect(JSON.stringify(rows)).not.toContain('sk-or-secret-value');
    expect(JSON.stringify(rows)).not.toMatch(/connected|healthy|operational/i);
  });
});

describe('activity', () => {
  it('lists the newest rows across kinds, newest first, each link a real route (or none)', async () => {
    const rows = await activity(db.sql, 12);
    expect(rows.length).toBe(12);
    const times = rows.map((r) => Date.parse(r.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(new Set(rows.map((r) => r.kind)).size).toBeGreaterThan(1);
    for (const r of rows) {
      expect(r.title.length).toBeGreaterThan(0);
      if (r.href !== null) expect(ROUTES.some((p) => p.test(r.href!)), r.href).toBe(true);
    }
  });
});
