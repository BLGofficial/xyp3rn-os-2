import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import { DOMAINS } from '../../../core/contracts/taxonomy.ts';
import { createLlmRunner } from '../../../core/llm/runner.ts';
import { dispatch, type DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../../core/runtime/tools.ts';
import { scanRoots } from '../../../knowledge/knowledge-graph/scan.ts';
import { createLocalVaultStore } from '../../../knowledge/source-registry/vault-store.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../../../tests/helpers/db.ts';
import { FAKE_KEYS, fakeModel } from '../../../tests/helpers/fake-llm.ts';
import { asCommitted, insertRun } from '../../../tests/helpers/records-fixture.ts';
import { coverage, lensGroups, listNodes, neighbourhood, nodeDetail } from './graph-loaders.ts';
import { songCreate, songLink, songUnlink } from './ops.ts';
import { runDetail } from './research-loaders.ts';
import { startBrief } from './research-ops.ts';

// AOS-04 Plan C1 Task 5: the projection the Graph list, the inspector and (in C2) the sphere read, as xyp_web.
// A scanned fixture root plus real records written through the existing ops (FAKE MODEL; stubbed page fetch).

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let db: TestDb;
let deps: DispatchDeps;
let songId: string;
let recipeLineageId: string;
let briefId: string;
let runId: string;
let findingId: string;
let evidenceId: string;
let researchSourceId: string;
let songLinkId: string;
let vaultSourceId: string;
const root = mkdtempSync(join(tmpdir(), 'aos04-graph-root-'));
const vaultDir = mkdtempSync(join(tmpdir(), 'aos04-graph-vault-'));
const PAGE = '<html><head><title>[FIXTURE] Suno tips</title></head><body><p>[FIXTURE] Put the vocal descriptor first.</p></body></html>';
const pageFetch: typeof fetch = async () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
const model = fakeModel({
  override: (schema) => ('claims' in ((schema.properties ?? {}) as object)
    ? { claims: [{ passage: 1, quote: 'Put the vocal descriptor first.', claim: '[FAKE] descriptor first', claim_topic: 'suno.vocal-descriptor-position', claim_value: '"first"', model_tag: 'suno-v5', confidence: 0.6, confidence_inputs: { basis: '[FAKE] page', directness: 'direct' } }], declined: [] }
    : undefined),
});
const put = (rel: string, body: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const WORKFLOW = 'name: fixture-graph\ndescription: x\nsteps:\n  - id: one\n    agent: fixture-graph\n';

beforeAll(async () => {
  db = await createTestDb('aos04_graph_web', { migrated: true });
  deps = {
    sql: db.sql, registry: createAgentRegistry({ dir: join(REPO_ROOT, 'agents') }), handlers: HANDLERS,
    tools: createRuntimeTools({ sql: db.sql, env: {}, fetch: pageFetch, vault: createLocalVaultStore(vaultDir) }),
    llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
  };
  put('agents/fixture-graph.agent.md', '---\nname: fixture-graph\nclass: Execution\ndomain: RECORDS\ntools: []\nmodel: none\n---\n\n## Role\n\nx\n\n## Contract\n\nx\n\n## Refuses\n\nx\n');
  put('records/workflows/fixture-graph.workflow.yaml', WORKFLOW);
  put('docs/ARCHITECTURE.md', '# Architecture\n\n**F41. Open after AOS-03.** OPEN.\n[FIXTURE]\n');
  put('core/a.ts', "import { b } from './b.ts';\n");
  put('core/b.ts', 'export const b = 1;\n');
  put('docs/notes.md', 'See [the architecture](ARCHITECTURE.md).\n');
  expect((await scanRoots(db.sql, { roots: [{ id: 'repo', dir: root }], trigger: 'cli', store: createLocalVaultStore(vaultDir) })).status).toBe('success');

  songId = (await songCreate(deps, { title: '[FIXTURE] Night City', artist: 'X3LIUS', language: 'en' })).songId;
  const r = await dispatch(deps, 'x3lius-studio-editor', { recipe: { name: '[FIXTURE] Night drive', style: '[FIXTURE] dark melodic trap', excludeStyles: [] } });
  recipeLineageId = (r.output as { lineageId: string }).lineageId;
  ({ researchRunId: runId } = await startBrief(deps, {
    projectSlug: 'graph', question: '[FIXTURE] Where does the vocal descriptor go?', intendedUse: '[FIXTURE] recipe order', urls: ['https://example.org/suno'],
    specialists: ['suno-researcher'], songIds: [songId], targets: [{ kind: 'lineage', artifactLineageId: recipeLineageId }, { kind: 'decision', decisionKey: 'F41' }],
  }, () => {}));
  const end = Date.now() + 30_000;
  while ((await runDetail(db.sql, runId))!.run.status === 'running') {
    if (Date.now() > end) throw new Error('run did not settle');
    await new Promise((res) => setTimeout(res, 100));
  }
  const [ids] = await db.sql<{ brief: string; finding: string; evidence: string; source: string }[]>`
    select r.question_id as brief, f.id as finding, e.id as evidence, e.research_source_id as source
    from research_runs r join research_findings f on f.research_run_id = r.id join research_evidence e on e.research_run_id = r.id where r.id = ${runId}`;
  ({ brief: briefId, finding: findingId, evidence: evidenceId, source: researchSourceId } = ids!);

  // A song link that is later retracted: it leaves the graph and stays in history.
  ({ linkId: songLinkId } = await songLink(deps, { songId, artifactId: recipeLineageId, role: 'recipe' }));
  await songUnlink(deps, { linkId: songLinkId, reason: '[FIXTURE] wrong recipe' });

  // A run of an earlier revision of the fixture workflow.
  await db.sql`insert into workflow_runs (workflow_name, spec_sha256, spec, input, status, completed_at)
               values ('fixture-graph', ${sha('an earlier revision')}, '{}', '{}', 'success', now())`;

  // A Vault file (stored bytes) as xyp_vault.
  const vaultRun = await insertRun(db.sql, 'vault-curator', 'Execution');
  const { sha256 } = await createLocalVaultStore(vaultDir).put(new TextEncoder().encode('[FIXTURE] vault bytes'));
  vaultSourceId = await asCommitted(db.sql, 'xyp_vault', async (tx) => (await tx<{ id: string }[]>`
    insert into sources (kind, uri, title, checksum_sha256, mime_type, byte_size, storage, media_class, language, agent_run_id, metadata)
    values ('file', ${`vault://${sha256}`}, '[FIXTURE] vault file', ${sha256}, 'text/plain', 21, 'local-vault', 'document', 'en', ${vaultRun}, ${tx.json({ filename: 'fixture.txt' })})
    returning id`)[0]!.id);
}, 180_000);
afterAll(async () => {
  await db?.drop();
  rmSync(root, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

const all = async (filter: Parameters<typeof listNodes>[1] = {}) => (await listNodes(db.sql, { ...filter, perPage: 500 })).nodes;

describe('listNodes', () => {
  it('lists every kind with the fields the inspector needs, and the right backing', async () => {
    const nodes = await all();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      expect(n).toEqual(expect.objectContaining({ id: expect.any(String), kind: expect.any(String), title: expect.any(String), backing: expect.stringMatching(/^(file|record|configuration)$/), sourceRef: expect.any(String), availability: expect.any(String), asOf: expect.any(String), href: expect.any(String) }));
    }
    expect(byId.get('domain:RECORDS')).toMatchObject({ kind: 'domain', backing: 'configuration', href: '/?domain=RECORDS' });
    expect(byId.get(`sources:${vaultSourceId}`)).toMatchObject({ kind: 'vault_file', backing: 'file', title: 'fixture.txt', href: `/vault/files/${vaultSourceId}` });
    expect(byId.get(`songs:${songId}`)).toMatchObject({ kind: 'song', backing: 'record', ownerDomain: 'RECORDS', href: `/songs/${songId}` });
    expect(byId.get(`research_runs:${runId}`)).toMatchObject({ kind: 'research_run', href: `/research/runs/${runId}` });
    expect(byId.get('agent:fixture-graph')).toMatchObject({ kind: 'agent', backing: 'file', ownerDomain: 'RECORDS', sourceRef: 'agents/fixture-graph.agent.md:2' });
    const file = byId.get('file:repo/core/a.ts')!;
    expect(file).toMatchObject({ kind: 'file', backing: 'file', ownerDomain: 'CORE', ownershipBasis: 'domain-path', revision: sha("import { b } from './b.ts';\n") });
    expect(file.href).toMatch(/^\/index\/files\/[0-9a-f-]{36}$/);
    expect(byId.get('decision:F41')).toMatchObject({ kind: 'decision', ownerDomain: null, href: `/node?id=${encodeURIComponent('decision:F41')}` });
  });

  it('filters by domain without dropping anything from the other filters, and pages', async () => {
    const records = await all({ domain: 'RECORDS' });
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((n) => n.ownerDomain === 'RECORDS')).toBe(true);
    const shared = await all({ domain: 'shared' });
    expect(shared.map((n) => n.id)).toEqual(expect.arrayContaining(['file:repo/docs/ARCHITECTURE.md', 'decision:F41']));
    expect(shared.every((n) => n.ownerDomain === null)).toBe(true);
    const everything = await listNodes(db.sql, { perPage: 500 });
    const perDomain = await Promise.all([...DOMAINS, 'shared' as const].map((d) => listNodes(db.sql, { domain: d, perPage: 1 })));
    expect(perDomain.reduce((s, p) => s + p.total, 0)).toBe(everything.total);
    const page2 = await listNodes(db.sql, { perPage: 5, page: 2 });
    expect(page2.nodes).toHaveLength(5);
    expect(page2.nodes[0]!.id).toBe(everything.nodes[5]!.id);
  });
});

describe('nodeDetail', () => {
  it('traces brief → run → evidence → research source, each hop with its row as proof', async () => {
    const run = (await nodeDetail(db.sql, `research_runs:${runId}`))!;
    expect(run.outgoing).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'run_of', other: expect.objectContaining({ id: `research_questions:${briefId}` }), provenance: `research_runs:${runId}#question_id`, verification: 'verified' }),
    ]));
    expect(run.incoming).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'produced_by', other: expect.objectContaining({ id: `research_evidence:${evidenceId}` }) }),
    ]));
    const ev = (await nodeDetail(db.sql, `research_evidence:${evidenceId}`))!;
    expect(ev.outgoing).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'quotes', other: expect.objectContaining({ id: `research_sources:${researchSourceId}` }), detail: 'Put the vocal descriptor first.' }),
    ]));
  });

  it('gives a finding its evidence, and its targets only as inherited from the brief', async () => {
    const f = (await nodeDetail(db.sql, `research_findings:${findingId}`))!;
    expect(f.outgoing).toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'supported_by', other: expect.objectContaining({ id: `research_evidence:${evidenceId}` }) })]));
    expect(f.inherited.map((i) => [i.label, i.targetId]).sort()).toEqual([
      ['Inherited from brief', 'decision:F41'], ['Inherited from brief', `lineage:${recipeLineageId}`], ['Inherited from brief', `songs:${songId}`],
    ].sort());
    expect(f.inherited.every((i) => i.target !== null && i.brief.id === `research_questions:${briefId}`)).toBe(true);
    expect(f.outgoing.filter((c) => c.relation === 'linked_to')).toEqual([]);
  });

  it('moves a retracted song link to history with its reason', async () => {
    const s = (await nodeDetail(db.sql, `songs:${songId}`))!;
    expect(s.outgoing.filter((c) => c.relation === 'linked_to' && c.other.id === `lineage:${recipeLineageId}`)).toEqual([]);
    expect(s.history).toEqual([expect.objectContaining({ linkId: songLinkId, toId: `lineage:${recipeLineageId}`, reason: '[FIXTURE] wrong recipe' })]);
    // The brief the song links is still there.
    expect(s.outgoing).toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'linked_to', other: expect.objectContaining({ id: `research_questions:${briefId}` }) })]));
  });

  it('says when a workflow run ran an earlier revision than the scanned definition', async () => {
    const wf = (await nodeDetail(db.sql, 'workflow:fixture-graph'))!;
    const run = wf.incoming.find((c) => c.relation === 'run_of')!;
    expect(run.verification).toBe('earlier-revision');
    expect(run.note).toBe(`ran an earlier revision (${sha('an earlier revision').slice(0, 12)}…), not the scanned ${sha(WORKFLOW).slice(0, 12)}…`);
  });

  it('shows an import with its file and line, and returns null for an unknown id', async () => {
    const a = (await nodeDetail(db.sql, 'file:repo/core/a.ts'))!;
    expect(a.outgoing).toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'imports', provenance: 'core/a.ts:1', detail: './b.ts', other: expect.objectContaining({ id: 'file:repo/core/b.ts' }) })]));
    expect(await nodeDetail(db.sql, 'file:repo/nope.ts')).toBeNull();
  });
});

describe('neighbourhood, coverage and the creative lens', () => {
  it('returns one hop of actual edges around a node', async () => {
    const n = await neighbourhood(db.sql, `songs:${songId}`);
    expect(n.center!.id).toBe(`songs:${songId}`);
    expect(n.edges.length).toBeGreaterThan(0);
    for (const e of n.edges) expect([e.fromId, e.toId]).toContain(`songs:${songId}`);
    expect(new Set(n.nodes.map((x) => x.id))).toEqual(new Set(n.edges.map((e) => (e.fromId === `songs:${songId}` ? e.toId : e.fromId))));
  });

  it('reports the last scan exactly as the database holds it', async () => {
    const c = await coverage(db.sql);
    const [last] = await db.sql<{ id: string; counts: unknown }[]>`select id, counts from index_scans order by started_at desc limit 1`;
    expect(c.lastScan).toMatchObject({ id: last!.id, counts: last!.counts });
    expect(c.roots).toEqual([{ id: 'repo', dir: root }]);
    expect(c.nodes).toBe((await listNodes(db.sql, { perPage: 1 })).total);
  });

  it('groups the creative lens over the same ids, with real members only', async () => {
    const l = await lensGroups(db.sql);
    const g = Object.fromEntries(l.groups.map((x) => [x.key, x]));
    expect(g.songs).toMatchObject({ count: 1, memberIds: [`songs:${songId}`] });
    expect(g.styles).toMatchObject({ count: 1, memberIds: [`lineage:${recipeLineageId}`] });
    expect(g.lyrics).toMatchObject({ count: 0, memberIds: [] });
    expect(g['meta-tags']).toMatchObject({ count: 0 });
    expect(g.research).toMatchObject({ count: 1, memberIds: [`research_questions:${briefId}`] });
    expect(g.workflows).toMatchObject({ count: 1, memberIds: ['workflow:fixture-graph'] });
    for (const x of l.groups) expect(x.query.length).toBeGreaterThan(0);
    const ids = new Set((await all()).map((n) => n.id));
    for (const x of l.groups) for (const m of x.memberIds) expect(ids.has(m)).toBe(true);
    // No X3LIUS module in this fixture database: the lens says so rather than inventing an anchor.
    expect(l.anchor).toBeNull();
    const songs = await all({ lens: 'creative', group: 'songs' });
    expect(songs.map((n) => n.id)).toEqual([`songs:${songId}`]);
  });
});

describe('an empty workspace', () => {
  it('lists the six domains and the files, and nothing else', async () => {
    const empty = await createTestDb('aos04_graph_empty', { migrated: true });
    const emptyRoot = mkdtempSync(join(tmpdir(), 'aos04-graph-empty-'));
    try {
      writeFileSync(join(emptyRoot, 'README.md'), '[FIXTURE]\n');
      writeFileSync(join(emptyRoot, 'notes.txt'), '[FIXTURE]\n');
      await scanRoots(empty.sql, { roots: [{ id: 'repo', dir: emptyRoot }], trigger: 'cli', store: createLocalVaultStore(vaultDir) });
      const l = await listNodes(empty.sql, { perPage: 100 });
      expect(l.nodes.map((n) => n.id).sort()).toEqual([...DOMAINS.map((d) => `domain:${d}`), 'file:repo/README.md', 'file:repo/notes.txt'].sort());
    } finally {
      await empty.drop();
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
