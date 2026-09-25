import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { decideArtifact } from '../../governance/approvals.ts';
import { createLocalVaultStore, type VaultStore } from '../../knowledge/source-registry/vault-store.ts';
import { exportVault, VAULT_EXPORT_FORMAT } from '../../knowledge/vault-io/export.ts';
import { importVault } from '../../knowledge/vault-io/import.ts';
import { addAndImport } from '../../records/vault/import.ts';
import { asCommitted, insertRun, insertTake } from '../helpers/records-fixture.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { insertResearchRun } from '../helpers/tech-fixture.ts';

// AOS-01 proof (part 4): xyp-vault-export/v1. Database A is filled through the real agents; its
// Vault is exported, imported into a fresh database B, and exported again: records.ndjson must be
// byte-identical and the blobs identical. Re-import is a no-op; a conflicting row, a tampered
// records file, a corrupt blob and a foreign table each refuse the whole import.

let a: TestDb;
let b: TestDb;
let storeA: VaultStore;
let storeB: VaultStore;
const tmp = mkdtempSync(join(tmpdir(), 'aos01-export-'));
const dir = (name: string) => join(tmp, name);
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const depsFor = (db: TestDb, store: VaultStore): DispatchDeps => ({ sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql, vault: store }), handlers: HANDLERS });
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const file = (name: string, content: string): string => {
  const p = join(dir('files'), name);
  writeFileSync(p, content);
  return p;
};
const ok = async (deps: DispatchDeps, agent: string, input: unknown) => {
  const r = await dispatch(deps, agent, input);
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
  return r.output as Record<string, string>;
};
let songId: string;
let lineageId: string;

beforeAll(async () => {
  [a, b] = await Promise.all([createTestDb('aos01_export_a', { migrated: true }), createTestDb('aos01_export_b', { migrated: true })]);
  mkdirSync(dir('files'));
  storeA = createLocalVaultStore(dir('store-a'));
  storeB = createLocalVaultStore(dir('store-b'));

  const deps = depsFor(a, storeA);
  songId = (await ok(deps, 'records-songs', { create: { title: '[FIXTURE] Night City', artist: 'X3LIUS', language: 'en', genre: 'darkwave' } })).songId!;
  await ok(deps, 'records-songs', { revise: { songId, status: 'writing' } });
  const sheet = await addAndImport(deps, { path: file('night-city.txt', '[Verse 1]\nNeon on the glass\n[Chorus]\nWe run tonight\n'), as: 'lyric_sheet', language: 'en', songId, tags: ['New Era'] });
  const v1 = sheet.lyrics as { artifactId: string; lineageId: string };
  lineageId = v1.lineageId;
  const v2 = await ok(deps, 'x3lius-lyric-editor', { edit: { parentId: v1.artifactId, text: '[Verse 1]\nNeon on the glass, again\n' } });
  await decideArtifact(a.sql, v1.artifactId, { decision: 'approve', approver: 'owner', reason: '[FIXTURE] keep v1' });
  await decideArtifact(a.sql, v2.artifactId!, { decision: 'reject', approver: 'owner', reason: '[FIXTURE] v2 is weaker' });
  const notes = await addAndImport(deps, { path: file('mix-notes.md', '# Mix v3\n\nKick 2 dB down.\n'), songId, tags: ['New Era', 'mix'] });
  // Unlink and link again: the retraction must be restored before the second link.
  await ok(deps, 'records-songs', { unlink: { linkId: notes.file.linkId!, reason: '[FIXTURE] re-linking with a role' } });
  await ok(deps, 'records-songs', { link: { songId, sourceId: notes.file.sourceId, role: 'mix-notes' } });
  const { takeId } = await insertTake(a.sql);
  await ok(deps, 'records-songs', { link: { songId, takeId, role: 'take' } });
  const runId = await insertRun(a.sql, 'records-catalog', 'Execution');
  const trackId = await asCommitted(a.sql, 'xyp_catalog', async (tx) => {
    const [r] = await tx<{ id: string }[]>`insert into releases (title, artist, kind, agent_run_id) values ('[FIXTURE] New Era', 'X3LIUS', 'single', ${runId}) returning id`;
    const [t] = await tx<{ id: string }[]>`
      insert into tracks (release_id, position, title, take_id, agent_run_id) values (${r!.id}, 1, '[FIXTURE] Night City', ${takeId}, ${runId}) returning id`;
    await tx`insert into rights_splits (track_id, version, payee, percentage, agent_run_id) values (${t!.id}, 1, 'X3LIUS', 100, ${runId})`;
    return t!.id;
  });
  await ok(deps, 'records-songs', { link: { songId, trackId, role: 'release' } });
  const researchRun = await insertResearchRun(a.sql);
  const [q] = await a.sql<{ question_id: string }[]>`select question_id from research_runs where id = ${researchRun}`;
  await ok(deps, 'records-songs', { link: { songId, researchQuestionId: q!.question_id, role: 'research' } });
}, 120_000);
afterAll(async () => {
  await Promise.all([a?.drop(), b?.drop()]);
  rmSync(tmp, { recursive: true, force: true });
});

const lines = (d: string) => readFileSync(join(d, 'records.ndjson'), 'utf8');
const blobs = (d: string) => Object.fromEntries(readdirSync(join(d, 'blobs')).sort().map((f) => [f, sha(readFileSync(join(d, 'blobs', f)))]));
const count = async (db: TestDb) => (await db.sql<{ n: number }[]>`
  select (select count(*) from songs) + (select count(*) from song_links) + (select count(*) from creative_artifacts) + (select count(*) from sources)
         + (select count(*) from approval_queue) + (select count(*) from agent_runs) as n`)[0]!.n;

describe('xyp-vault-export/v1: A → B → A\' round trip', () => {
  it('exports the Vault and the closure of its links, with a manifest and one blob per stored file', async () => {
    const out = await exportVault(a.sql, storeA, dir('export-a'));
    const manifest = JSON.parse(readFileSync(join(dir('export-a'), 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ format: VAULT_EXPORT_FORMAT, recordsSha256: sha(readFileSync(join(dir('export-a'), 'records.ndjson'))) });
    expect(manifest.migrationHead).toMatch(/^\d{14}$/);
    expect(manifest.counts).toMatchObject({
      songs: 1, song_revisions: 2, song_links: 7, song_link_retractions: 1, source_texts: 2, source_tags: 3, tags: 2,
      // the lyrics lineage (v1, v2) and the take's formula artifact
      creative_artifacts: 2 + 1, approval_queue: 2, suno_takes: 1, suno_submissions: 1, tracks: 1, releases: 1, rights_splits: 1,
      research_questions: 1, research_projects: 1,
    });
    expect(manifest.counts.sources).toBe(2);
    expect(out.records).toBe(Object.values(manifest.counts as Record<string, number>).reduce((x, y) => x + y, 0));
    expect(Object.keys(blobs(dir('export-a'))).length).toBe(2);
    for (const [name, hash] of Object.entries(blobs(dir('export-a')))) expect(hash).toBe(name);
    const types = lines(dir('export-a')).trim().split('\n').map((l) => JSON.parse(l).type as string);
    expect(types.indexOf('song_link_retractions')).toBeLessThan(types.lastIndexOf('song_links'));
    expect(types).not.toContain('canonical_prompts');
  });

  it('imports into a fresh database: every link resolves, the approved pointer and revisions hold', async () => {
    const r = await importVault(b.sql, storeB, dir('export-a'));
    expect(r).toMatchObject({ inserted: r.records, skipped: 0 });
    expect(await b.sql`select count(*)::int as n from current_song_links where song_id = ${songId}`).toEqual([{ n: 6 }]);
    const unresolved = await b.sql`
      select l.id from song_links l
      where coalesce(l.artifact_lineage_id, l.source_id, l.take_id, l.track_id, l.research_question_id) is null`;
    expect(unresolved).toEqual([]);
    expect(await b.sql`select version, status, approved_version from artifact_approvals where lineage_id = ${lineageId} order by version`).toEqual([
      { version: 1, status: 'approved', approved_version: 1 }, { version: 2, status: 'rejected', approved_version: 1 },
    ]);
    expect(await b.sql`select revision, status::text from song_revisions where song_id = ${songId} order by revision`).toEqual([
      { revision: 1, status: 'idea' }, { revision: 2, status: 'writing' },
    ]);
    for (const f of await b.sql<{ checksum_sha256: string }[]>`select checksum_sha256 from sources where storage is not null`) {
      expect(sha(await storeB.get(f.checksum_sha256))).toBe(f.checksum_sha256);
    }
  });

  it('re-exporting B is byte-identical; re-importing changes nothing', async () => {
    await exportVault(b.sql, storeB, dir('export-b'));
    expect(lines(dir('export-b'))).toBe(lines(dir('export-a')));
    expect(blobs(dir('export-b'))).toEqual(blobs(dir('export-a')));
    const before = await count(b);
    const again = await importVault(b.sql, storeB, dir('export-a'));
    expect(again).toMatchObject({ inserted: 0, skipped: again.records });
    expect(await count(b)).toBe(before);
  });
});

describe('import refuses, and changes nothing, when', () => {
  /** A copy of export-a with records.ndjson edited and the manifest hash updated to match. */
  const edited = (name: string, edit: (records: string) => string): string => {
    const d = dir(name);
    cpSync(dir('export-a'), d, { recursive: true });
    const records = edit(lines(d));
    writeFileSync(join(d, 'records.ndjson'), records);
    const manifest = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'));
    writeFileSync(join(d, 'manifest.json'), JSON.stringify({ ...manifest, recordsSha256: sha(records) }, null, 2));
    return d;
  };

  it('a row differs from the one already there: every conflict is listed', async () => {
    const d = edited('conflict', (r) => r.replaceAll('[FIXTURE] Night City', '[FIXTURE] Night City (edited)'));
    const before = await count(b);
    await expect(importVault(b.sql, storeB, d)).rejects.toThrow(/conflict.*song_revisions/s);
    expect(await count(b)).toBe(before);
  });

  it('records.ndjson does not match the manifest, a blob is corrupt, or a blob is missing', async () => {
    const tampered = dir('tampered');
    cpSync(dir('export-a'), tampered, { recursive: true });
    writeFileSync(join(tampered, 'records.ndjson'), `${lines(tampered)}\n`);
    await expect(importVault(b.sql, storeB, tampered)).rejects.toThrow(/records\.ndjson.*sha256/);
    const corrupt = dir('corrupt');
    cpSync(dir('export-a'), corrupt, { recursive: true });
    const blob = readdirSync(join(corrupt, 'blobs'))[0]!;
    writeFileSync(join(corrupt, 'blobs', blob), 'not the bytes');
    await expect(importVault(b.sql, storeB, corrupt)).rejects.toThrow(/blob .* is corrupt/);
    rmSync(join(corrupt, 'blobs', blob));
    await expect(importVault(b.sql, storeB, corrupt)).rejects.toThrow(/blob .* is missing/);
  });

  it('a record names a table outside the Vault export, or the schema version differs', async () => {
    const foreign = edited('foreign', (r) => `${r}{"type":"canonical_prompts","row":{"id":"00000000-0000-4000-8000-000000000000"}}\n`);
    await expect(importVault(b.sql, storeB, foreign)).rejects.toThrow(/canonical_prompts is not a Vault export table/);
    const head = dir('head');
    cpSync(dir('export-a'), head, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(head, 'manifest.json'), 'utf8'));
    writeFileSync(join(head, 'manifest.json'), JSON.stringify({ ...manifest, migrationHead: '20990101000000' }));
    await expect(importVault(b.sql, storeB, head)).rejects.toThrow(/migration/);
  });
});

describe('export refuses what a restore could not recreate', () => {
  it('a linked release that is no longer a draft (a release is registered as a draft; its history is AOS-08)', async () => {
    await a.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update releases set status = 'scheduled', release_date = current_date + 30, rights_check_run_id = agent_run_id`;
    });
    await expect(exportVault(a.sql, storeA, dir('export-scheduled'))).rejects.toThrow(/release .* is scheduled/);
  });
});
