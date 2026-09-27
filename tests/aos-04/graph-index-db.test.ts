import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAINS } from '../../core/contracts/taxonomy.ts';
import { migrateDown, migrateUp } from '../../core/db/migrate.ts';
import { asRole, createTestDb, expectPgError, plan, type TestDb } from '../helpers/db.ts';
import { asCommitted, insertArtifact, insertRun } from '../helpers/records-fixture.ts';
import { insertCanonical, insertSong } from '../helpers/research-fixture.ts';

// AOS-04 Plan C1 Task 1: the file index tables, the graph views over them and the live records, and the
// indexer role that writes only the index. Admin sets up records; xyp_indexer writes the index; xyp_web reads.

const MIGRATION = '20260927100000';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('aos04_graph', { migrated: true });
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

type Scan = { scanId: string };
const openScan = (): Promise<Scan> =>
  asCommitted(db.sql, 'xyp_indexer', async (tx) => {
    const [s] = await tx<{ id: string }[]>`insert into index_scans (trigger, roots) values ('cli', ${tx.json({ repo: '[FIXTURE] root' })}) returning id`;
    return { scanId: s!.id };
  });
const indexFile = (scanId: string, path: string, o: { owner?: string | null; basis?: string } = {}) =>
  asCommitted(db.sql, 'xyp_indexer', async (tx) => (await tx<{ id: string }[]>`
    insert into indexed_files (root, path, sha256, size_bytes, mime, mtime, text_indexed, owner_domain, ownership_basis, status, first_scan_id, last_scan_id, indexed_at)
    values ('repo', ${path}, ${sha(path)}, 10, 'text/plain', now(), true, ${o.owner ?? null}, ${o.basis ?? 'shared'}, 'present', ${scanId}, ${scanId}, now())
    returning id`)[0]!.id);

describe('the empty workspace', () => {
  it('has the six taxonomy domains as its only nodes, backed by configuration', async () => {
    const nodes = await asRole(db.sql, 'xyp_web', (tx) => tx<{ id: string; kind: string; backing: string }[]>`select id, kind, backing from graph_nodes order by id`);
    expect(nodes.map((n) => n.id)).toEqual(DOMAINS.map((d) => `domain:${d}`).sort());
    expect(new Set(nodes.map((n) => `${n.kind}/${n.backing}`))).toEqual(new Set(['domain/configuration']));
    const edges = await asRole(db.sql, 'xyp_web', (tx) => tx`select id from graph_edges`);
    expect(edges).toEqual([]);
  });
});

describe('the index tables', () => {
  it('refuses a path that is absolute, climbs, uses backslashes or a drive letter (23514)', async () => {
    const { scanId } = await openScan();
    for (const bad of ['/etc/passwd', '../x', 'a/../b', 'a/./b', 'C:/x', 'C:\\x', '\\\\server\\share\\x', 'a\\b', 'a//b', 'a/', '']) {
      await expectPgError(() => asRole(db.sql, 'xyp_indexer', (tx) => tx`
        insert into indexed_files (root, path, sha256, size_bytes, mtime, text_indexed, ownership_basis, status, first_scan_id, last_scan_id, indexed_at)
        values ('repo', ${bad}, ${sha(bad)}, 1, now(), true, 'shared', 'present', ${scanId}, ${scanId}, now())`), '23514');
    }
  });

  it('keeps one row per root and path (23505)', async () => {
    const { scanId } = await openScan();
    await indexFile(scanId, 'docs/unique.md');
    await expectPgError(() => indexFile(scanId, 'docs/unique.md'), '23505');
  });

  it('requires an error on an unreadable file and a checksum on a present one', async () => {
    const { scanId } = await openScan();
    await expectPgError(() => asRole(db.sql, 'xyp_indexer', (tx) => tx`
      insert into indexed_files (root, path, sha256, size_bytes, mtime, text_indexed, ownership_basis, status, first_scan_id, last_scan_id, indexed_at)
      values ('repo', 'docs/locked.md', null, 1, now(), false, 'shared', 'unreadable', ${scanId}, ${scanId}, now())`), '23514');
    await expectPgError(() => asRole(db.sql, 'xyp_indexer', (tx) => tx`
      insert into indexed_files (root, path, sha256, size_bytes, mtime, text_indexed, ownership_basis, status, first_scan_id, last_scan_id, indexed_at)
      values ('repo', 'docs/nohash.md', null, 1, now(), true, 'shared', 'present', ${scanId}, ${scanId}, now())`), '23514');
  });

  it('seals a scan once it leaves running (55000), and a sealed scan names its counts', async () => {
    const { scanId } = await openScan();
    await asCommitted(db.sql, 'xyp_indexer', (tx) => tx`
      update index_scans set status = 'success', finished_at = now(), counts = ${tx.json({ eligible: 0, indexed: 0, failed: 0 })} where id = ${scanId}`);
    await expectPgError(() => asRole(db.sql, 'xyp_indexer', (tx) => tx`update index_scans set status = 'running', finished_at = null where id = ${scanId}`), '55000');
    const { scanId: other } = await openScan();
    await expectPgError(() => asRole(db.sql, 'xyp_indexer', (tx) => tx`update index_scans set status = 'error', finished_at = now() where id = ${other}`), '23514');
  });
});

describe('the roles', () => {
  it('lets xyp_indexer write the index and nothing else (42501)', async () => {
    await expectPgError(() => asRole(db.sql, 'xyp_indexer', (tx) => tx`insert into sources (kind, uri, title, checksum_sha256) values ('file', 'file:///x', 'x', ${sha('x')})`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_indexer', (tx) => tx`insert into songs (agent_run_id) values (null)`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_indexer', (tx) => tx`insert into research_links (question_id, decision_key) values (gen_random_uuid(), 'F1')`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_indexer', (tx) => tx`insert into canonical_prompts (module_id, slug, title, body, promoted_via) values (gen_random_uuid(), 'x', 'x', 'x', 'gate')`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_indexer', (tx) => tx`insert into relations (subject_type, subject_id, predicate, object_type, object_id) values ('agent', 'a', 'uses', 'agent', 'b')`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_indexer', (tx) => tx`delete from index_scans`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_indexer', (tx) => tx`delete from indexed_files`), '42501');
  });

  it('reads the Vault check columns of sources as xyp_indexer, and no other column', async () => {
    await asRole(db.sql, 'xyp_indexer', (tx) => tx`select id, checksum_sha256, byte_size, storage from sources`);
    await expectPgError(() => asRole(db.sql, 'xyp_indexer', (tx) => tx`select uri from sources`), '42501');
  });

  it('lets xyp_web read the views and index tables, never write them', async () => {
    await asRole(db.sql, 'xyp_web', async (tx) => {
      for (const v of ['graph_nodes', 'graph_edges', 'graph_diagnostics', 'graph_link_history', 'index_scans', 'indexed_files', 'index_nodes', 'index_edges', 'index_vault_status']) {
        await tx.unsafe(`select * from public.${v} limit 1`);
      }
    });
    const { scanId } = await openScan();
    await expectPgError(() => asRole(db.sql, 'xyp_web', (tx) => tx`insert into index_scans (trigger, roots) values ('cli', '{}')`), '42501');
    await expectPgError(() => asRole(db.sql, 'xyp_web', (tx) => tx`
      insert into indexed_files (root, path, sha256, size_bytes, mtime, text_indexed, ownership_basis, status, first_scan_id, last_scan_id, indexed_at)
      values ('repo', 'x.md', ${sha('x.md')}, 1, now(), true, 'shared', 'present', ${scanId}, ${scanId}, now())`), '42501');
  });

  it('keeps service_role read-only (G20) and gives anon and authenticated nothing', async () => {
    await asRole(db.sql, 'service_role', (tx) => tx`select id from graph_nodes limit 1`);
    await expectPgError(() => asRole(db.sql, 'service_role', (tx) => tx`insert into index_scans (trigger, roots) values ('cli', '{}')`), '42501');
    for (const role of ['anon', 'authenticated']) {
      await expectPgError(() => asRole(db.sql, role, (tx) => tx`select id from graph_nodes limit 1`), '42501');
      await expectPgError(() => asRole(db.sql, role, (tx) => tx`select id from indexed_files limit 1`), '42501');
    }
  });
});

describe('the graph views', () => {
  let songId: string;
  let lineageId: string;
  let linkId: string;
  let scanId: string;

  beforeAll(async () => {
    ({ songId } = await insertSong(db.sql, '[FIXTURE] Graph Song'));
    lineageId = await insertArtifact(db.sql, 'x3lius.lyrics/v2', { fixture: '[FIXTURE] lyrics' });
    const runId = await insertRun(db.sql, 'records-songs', 'Execution');
    [{ id: linkId }] = await db.sql<{ id: string }[]>`
      insert into song_links (song_id, artifact_lineage_id, role, agent_run_id) values (${songId}, ${lineageId}, 'lyrics', ${runId}) returning id` as unknown as [{ id: string }];
    ({ scanId } = await openScan());
    const agentFile = await indexFile(scanId, 'agents/fixture-graph.agent.md', { owner: 'RECORDS', basis: 'frontmatter' });
    const codeFile = await indexFile(scanId, 'records/fixture-graph.ts', { owner: 'RECORDS', basis: 'domain-path' });
    await indexFile(scanId, 'core/fixture-dep.ts', { owner: 'CORE', basis: 'domain-path' });
    await asCommitted(db.sql, 'xyp_indexer', async (tx) => {
      await tx`insert into index_nodes (id, kind, title, owner_domain, ownership_basis, file_id, line, revision, scan_id)
               values ('agent:fixture-graph', 'agent', 'fixture-graph', 'RECORDS', 'frontmatter', ${agentFile}, 1, ${sha('agents/fixture-graph.agent.md')}, ${scanId})`;
      await tx`insert into index_edges (relation, from_id, to_id, file_id, line, detail, revision, scan_id) values
               ('defined_by', 'agent:fixture-graph', 'file:repo/agents/fixture-graph.agent.md', ${agentFile}, 1, 'agents/fixture-graph.agent.md', ${sha('agents/fixture-graph.agent.md')}, ${scanId}),
               ('imports', 'file:repo/records/fixture-graph.ts', 'file:repo/core/fixture-dep.ts', ${codeFile}, 3, '../core/fixture-dep.ts', ${sha('records/fixture-graph.ts')}, ${scanId}),
               ('imports', 'file:repo/records/fixture-graph.ts', null, ${codeFile}, 4, './missing.ts', ${sha('records/fixture-graph.ts')}, ${scanId})`;
    });
    await insertCanonical(db.sql, { slug: 'fixture-graph', body: '[FIXTURE] graph body' });
  }, 60_000);

  it('lists files, declared entities and records with their backing and owner', async () => {
    const nodes = await asRole(db.sql, 'xyp_web', (tx) => tx<{ id: string; kind: string; backing: string; owner_domain: string | null; source_ref: string; revision: string | null; availability: string }[]>`
      select id, kind, backing, owner_domain::text, source_ref, revision, availability from graph_nodes`);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get('file:repo/records/fixture-graph.ts')).toMatchObject({ kind: 'file', backing: 'file', owner_domain: 'RECORDS', revision: sha('records/fixture-graph.ts'), availability: 'present' });
    expect(byId.get('agent:fixture-graph')).toMatchObject({ kind: 'agent', backing: 'file', owner_domain: 'RECORDS', source_ref: 'agents/fixture-graph.agent.md:1' });
    expect(byId.get(`songs:${songId}`)).toMatchObject({ kind: 'song', backing: 'record', owner_domain: 'RECORDS' });
    expect(byId.get(`lineage:${lineageId}`)).toMatchObject({ kind: 'lineage', backing: 'record', owner_domain: 'RECORDS' });
    expect(byId.get('module:fixture-graph-module')).toMatchObject({ kind: 'module', backing: 'record', owner_domain: 'RECORDS', revision: 'v1' });
    // An ingested source (no stored bytes) is a Record, never a File.
    const ingested = nodes.find((n) => n.kind === 'source');
    expect(ingested).toMatchObject({ backing: 'record' });
  });

  it('draws a song link as linked_to with its row as proof, and moves it to history on retraction', async () => {
    const edge = async () => asRole(db.sql, 'xyp_web', (tx) => tx<{ id: string; relation: string; provenance: string }[]>`
      select id, relation, provenance from graph_edges where from_id = ${`songs:${songId}`} and to_id = ${`lineage:${lineageId}`}`);
    expect(await edge()).toEqual([{ id: `linked_to:song_links:${linkId}`, relation: 'linked_to', provenance: `song_links:${linkId}` }]);
    const runId = await insertRun(db.sql, 'records-songs', 'Execution');
    await db.sql`insert into song_link_retractions (song_link_id, reason, agent_run_id) values (${linkId}, '[FIXTURE] wrong lyrics', ${runId})`;
    expect(await edge()).toEqual([]);
    const history = await asRole(db.sql, 'xyp_web', (tx) => tx<{ link_id: string; from_id: string; to_id: string; reason: string }[]>`
      select link_id, from_id, to_id, reason from graph_link_history where link_id = ${linkId}`);
    expect(history).toEqual([{ link_id: linkId, from_id: `songs:${songId}`, to_id: `lineage:${lineageId}`, reason: '[FIXTURE] wrong lyrics' }]);
  });

  it('keeps an unresolved reference as a diagnostic, never an edge', async () => {
    const diag = await asRole(db.sql, 'xyp_web', (tx) => tx<{ from_id: string; detail: string; source_ref: string }[]>`
      select from_id, detail, source_ref from graph_diagnostics where detail = './missing.ts'`);
    expect(diag).toEqual([{ from_id: 'file:repo/records/fixture-graph.ts', detail: './missing.ts', source_ref: 'records/fixture-graph.ts:4' }]);
    const edges = await asRole(db.sql, 'xyp_web', (tx) => tx`select id from graph_edges where to_id is null`);
    expect(edges).toEqual([]);
  });

  it('proves every edge: a provenance and both endpoints in graph_nodes', async () => {
    const orphans = await asRole(db.sql, 'xyp_web', (tx) => tx`
      select e.id from graph_edges e
      where e.provenance is null
         or not exists (select from graph_nodes n where n.id = e.from_id)
         or not exists (select from graph_nodes n where n.id = e.to_id)`);
    expect(orphans).toEqual([]);
    const imports = await asRole(db.sql, 'xyp_web', (tx) => tx<{ provenance: string; revision: string }[]>`
      select provenance, revision from graph_edges where relation = 'imports' and from_id = 'file:repo/records/fixture-graph.ts'`);
    expect(imports).toEqual([{ provenance: 'records/fixture-graph.ts:3', revision: sha('records/fixture-graph.ts') }]);
    const owned = await asRole(db.sql, 'xyp_web', (tx) => tx<{ to_id: string }[]>`
      select to_id from graph_edges where relation = 'owned_by' and from_id = 'file:repo/records/fixture-graph.ts'`);
    expect(owned).toEqual([{ to_id: 'domain:RECORDS' }]);
  });

  it('marks a missing file missing and drops nothing silently', async () => {
    await asCommitted(db.sql, 'xyp_indexer', (tx) => tx`update indexed_files set status = 'missing' where path = 'core/fixture-dep.ts'`);
    const [n] = await asRole(db.sql, 'xyp_web', (tx) => tx<{ availability: string }[]>`select availability from graph_nodes where id = 'file:repo/core/fixture-dep.ts'`);
    expect(n).toEqual({ availability: 'missing' });
  });
});

describe('the rollback', () => {
  it('drops the index and the views, revokes the role, and comes back up (twice)', async () => {
    const r = await createTestDb('aos04_graph_rt', { migrated: true });
    try {
      for (let i = 0; i < 2; i++) {
        expect(await migrateDown(r.sql, plan(), 1)).toEqual([MIGRATION]);
        const [gone] = await r.sql<{ n: number }[]>`select count(*)::int as n from pg_class where relname in ('graph_nodes', 'indexed_files') and relnamespace = 'public'::regnamespace`;
        expect(gone!.n).toBe(0);
        // The role is cluster-wide and stays (as xyp_tasks does); it loses what the migration granted it.
        const [role] = await r.sql<{ reads: boolean }[]>`select has_column_privilege('xyp_indexer', 'public.sources', 'checksum_sha256', 'select') as reads`;
        expect(role!.reads).toBe(false);
        expect(await migrateUp(r.sql, plan())).toEqual([MIGRATION]);
      }
      const [back] = await r.sql<{ n: number }[]>`select count(*)::int as n from graph_nodes`;
      expect(back!.n).toBe(DOMAINS.length);
    } finally {
      await r.drop();
    }
  }, 120_000);
});

