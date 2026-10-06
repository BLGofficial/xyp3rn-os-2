import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { EXPORT_DIR } from '../../knowledge/obsidian/notes.ts';
import { applySync, previewSync } from '../../knowledge/obsidian/sync.ts';
import { createLocalVaultStore } from '../../knowledge/source-registry/vault-store.ts';
import { createTestDb, expectPgError, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// F54 proof: the two-way Obsidian sync through the real agents, tools, DB roles and a real folder.
// What is real: dispatch, vault-curator and obsidian-sync runs, the ledger's grants and guards, the files.

let db: TestDb;
let deps: DispatchDeps;
const vault = mkdtempSync(join(tmpdir(), 'obsidian-vault-'));
const store = mkdtempSync(join(tmpdir(), 'obsidian-store-'));
const outside = mkdtempSync(join(tmpdir(), 'obsidian-outside-'));
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
let songId: string;

const ok = async (agent: string, input: unknown) => {
  const r = await dispatch(deps, agent, input);
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
  return r.output as Record<string, any>;
};
const songPath = () => `${EXPORT_DIR}/Songs/Нова ера (${songId.slice(0, 8)}).md`;

beforeAll(async () => {
  db = await createTestDb('obsidian_sync', { migrated: true });
  deps = { sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql, vault: createLocalVaultStore(store) }), handlers: HANDLERS };
  mkdirSync(join(vault, '.obsidian'));
  writeFileSync(join(vault, '.obsidian', 'app.json'), '{}');
  mkdirSync(join(vault, 'Songs'));
  writeFileSync(join(vault, 'Home.md'), '---\ntitle: Home\n---\nStart at [[Songs/Hook]] #index\n');
  writeFileSync(join(vault, 'Songs', 'Hook.md'), '---\nlang: bg\ntags: [hook]\n---\nПрипев идея\n');
  songId = (await ok('records-songs', { create: { title: 'Нова ера', artist: 'X3LIUS', status: 'writing' } })).songId;
});
afterAll(async () => {
  await db?.drop();
  for (const d of [vault, store, outside]) rmSync(d, { recursive: true, force: true });
});

describe('F54: two-way Obsidian sync', () => {
  it('previews from the .obsidian path, imports notes into the Vault and exports the song, each step an agent run', async () => {
    const p = await previewSync(db.sql, join(vault, '.obsidian'));
    expect(p.adjusted).toBe(true);
    expect(p.plan.actions.map((a) => [a.kind, a.rel])).toEqual([['export', songPath()], ['import', 'Home.md'], ['import', 'Songs/Hook.md']]);

    const r = await applySync(deps, join(vault, '.obsidian'), p.plan.hash);
    expect(r.failed).toEqual([]);
    expect(r.imported.map((i) => i.rel)).toEqual(['Home.md', 'Songs/Hook.md']);
    expect(r.exported.map((e) => e.rel)).toEqual([songPath()]);

    const note = readFileSync(join(vault, ...songPath().split('/')), 'utf8');
    expect(note).toContain(`xyp3rn_id: ${songId}`);
    expect(note).toContain('- Status: writing');

    const [hook] = await db.sql<{ title: string; language: string; tags: string[] }[]>`
      select s.title, s.language, array(select g.label from source_tags st join tags g on g.id = st.tag_id where st.source_id = s.id order by g.label) as tags
      from sources s where s.id = ${r.imported[1]!.sourceId}`;
    expect(hook).toEqual({ title: 'Hook', language: 'bg', tags: ['hook', 'obsidian'] });

    const runs = await db.sql<{ agent_name: string; status: string }[]>`
      select ar.agent_name, ar.status::text from obsidian_sync_events e join agent_runs ar on ar.id = e.agent_run_id order by e.note_path`;
    expect(runs).toEqual([{ agent_name: 'obsidian-sync', status: 'success' }, { agent_name: 'obsidian-sync', status: 'success' }, { agent_name: 'obsidian-sync', status: 'success' }]);
  });

  it('is idempotent: a second preview plans nothing', async () => {
    const p = await previewSync(db.sql, vault);
    expect(p.plan.actions).toEqual([]);
    expect(p.plan.unchanged).toBe(3);
  });

  it('updates an export nobody touched when the song changes', async () => {
    await ok('records-songs', { revise: { songId, status: 'producing' } });
    const p = await previewSync(db.sql, vault);
    expect(p.plan.actions.map((a) => [a.kind, a.rel])).toEqual([['export', songPath()]]);
    await applySync(deps, vault, p.plan.hash);
    expect(readFileSync(join(vault, ...songPath().split('/')), 'utf8')).toContain('- Status: producing');
  });

  it('never overwrites the owner\'s edit: conflict, the edit is imported, the file keeps the owner\'s text', async () => {
    const file = join(vault, ...songPath().split('/'));
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nOwner note: keep the 808 dry.\n`);
    await ok('records-songs', { revise: { songId, status: 'releasing' } });
    const p = await previewSync(db.sql, vault);
    expect(p.plan.conflicts.map((c) => c.rel)).toEqual([songPath()]);
    expect(p.plan.actions.map((a) => [a.kind, a.rel])).toEqual([['import', songPath()]]);
    const r = await applySync(deps, vault, p.plan.hash);
    expect(r.failed).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('keep the 808 dry');
    expect(readFileSync(file, 'utf8')).not.toContain('- Status: releasing');
  });

  it('refuses a stale plan hash and writes nothing', async () => {
    writeFileSync(join(vault, 'New.md'), 'new idea');
    const before = await db.sql<{ n: number }[]>`select count(*)::int as n from obsidian_sync_events`;
    await expect(applySync(deps, vault, '0'.repeat(64))).rejects.toThrow(/preview the sync again/);
    expect(await db.sql<{ n: number }[]>`select count(*)::int as n from obsidian_sync_events`).toEqual(before);
  });

  it('write_obsidian_note refuses paths outside the export folder, through a link, or over a changed file', async () => {
    const step = (notePath: string, expectedSha: string | null = null) =>
      dispatch(deps, 'obsidian-sync', { export: { vaultRoot: vault, notePath, content: 'x', expectedSha, planHash: 'a'.repeat(64) } });
    expect((await step('Home.md')).error).toMatch(/only under "XYP3RN OS\/"/);
    expect((await step(`${EXPORT_DIR}/../Home.md`)).error).toMatch(/"\.\." segment/);
    expect((await step(songPath())).error).toMatch(/changed since the preview/);
    let linked = true;
    try {
      symlinkSync(outside, join(vault, EXPORT_DIR, 'Escape'), 'dir');
    } catch {
      linked = false;
    }
    if (linked) expect((await step(`${EXPORT_DIR}/Escape/x.md`)).error).toMatch(/is a link/);
  });

  it('keeps the ledger append-only: no UPDATE grant for the writer, and a trigger even for the owner', async () => {
    await expectPgError(() => db.sql.begin(async (tx) => {
      await tx.unsafe('set local role xyp_vault');
      await tx`update obsidian_sync_events set sha256 = ${'b'.repeat(64)}`;
    }), '42501');
    await expectPgError(() => db.sql`delete from obsidian_sync_events`, '55000');
  });

  it('refuses a ledger path that climbs out of the vault, at the DB', async () => {
    const [run] = await db.sql<{ id: string }[]>`select id from agent_runs limit 1`;
    await expectPgError(() => db.sql`
      insert into obsidian_sync_events (vault_root, note_path, direction, sha256, plan_hash, agent_run_id)
      values (${vault}, ${'../x.md'}, 'export', ${'c'.repeat(64)}, ${'c'.repeat(64)}, ${run!.id})`, '23514');
  });
});
