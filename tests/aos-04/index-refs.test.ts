import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAgents } from '../../core/agent-registry/registry.ts';
import { declaredOf } from '../../knowledge/knowledge-graph/declared.ts';
import { importsOf, markdownLinksOf, resolveImport, resolveLink } from '../../knowledge/knowledge-graph/refs.ts';
import { scanRoots } from '../../knowledge/knowledge-graph/scan.ts';
import { ownerOf } from '../../knowledge/knowledge-graph/scope.ts';
import { createLocalVaultStore } from '../../knowledge/source-registry/vault-store.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// AOS-04 Plan C1 Task 3: what files declare. Imports and Markdown links become edges with their line; agents,
// workflows (and their steps) and ARCHITECTURE decisions become nodes. A reference to nothing is a diagnostic.

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const FILES = new Set(['core/a.ts', 'core/b.ts', 'core/c.ts', 'core/d.ts', 'core/e.ts', 'apps/web/app/ui.tsx', 'apps/web/lib/index.ts', 'docs/ARCHITECTURE.md', 'docs/artist-os/plan.md']);

describe('imports', () => {
  it('lists static, re-exported, dynamic and type-level imports with their line', () => {
    const src = [
      "import x from './a.ts';",
      "import type { T } from '../b.ts';",
      "export * from './c.ts';",
      "const d = await import('./d.ts');",
      "type E = typeof import('./e.ts');",
      "const s = \"import z from './not-an-import.ts'\";",
      "// import y from './commented.ts';",
      "const dyn = await import('./' + name);",
      "import fs from 'node:fs';",
      "import postgres from 'postgres';",
    ].join('\n');
    expect(importsOf(src)).toEqual([
      { specifier: './a.ts', line: 1 },
      { specifier: '../b.ts', line: 2 },
      { specifier: './c.ts', line: 3 },
      { specifier: './d.ts', line: 4 },
      { specifier: './e.ts', line: 5 },
      { specifier: 'node:fs', line: 9 },
      { specifier: 'postgres', line: 10 },
    ]);
  });

  it('reads a .tsx file with JSX', () => {
    const tsx = "import { ScrollTable } from '../ui';\nexport const P = () => <ScrollTable label=\"x\"><tbody /></ScrollTable>;\n";
    expect(importsOf(tsx)).toEqual([{ specifier: '../ui', line: 1 }]);
  });

  it('resolves relative specifiers as Node and Next do; ignores built-ins and packages', () => {
    expect(resolveImport('core/x.ts', './a.ts', FILES)).toBe('core/a.ts');
    expect(resolveImport('apps/web/app/research/page.tsx', '../ui', FILES)).toBe('apps/web/app/ui.tsx');
    expect(resolveImport('apps/web/app/page.tsx', '../lib', FILES)).toBe('apps/web/lib/index.ts');
    expect(resolveImport('core/x.ts', './a.js', FILES)).toBe('core/a.ts');
    expect(resolveImport('core/x.ts', 'node:fs', FILES)).toBeNull();
    expect(resolveImport('core/x.ts', 'postgres', FILES)).toBeNull();
    expect(resolveImport('core/x.ts', '@fontsource/inter/index.css', FILES)).toBeNull();
    expect(resolveImport('core/x.ts', './missing.ts', FILES)).toEqual({ unresolved: 'no such file' });
    expect(resolveImport('core/x.ts', '../../outside.ts', FILES)).toEqual({ unresolved: 'outside the root' });
  });
});

describe('Markdown links', () => {
  it('lists explicit links outside code, and nothing else', () => {
    const md = [
      'See [the architecture](../ARCHITECTURE.md#f42) and ![a diagram](./img.png "title").',
      'A bare mention of ARCHITECTURE.md in prose links nothing.',
      '`[not a link](x.md)` in inline code.',
      '```',
      '[also not a link](y.md)',
      '```',
      '[web](https://example.org) [mail](mailto:a@b.c) [anchor](#top)',
      '[ref]: ./plan.md',
    ].join('\n');
    expect(markdownLinksOf(md)).toEqual([
      { target: '../ARCHITECTURE.md#f42', line: 1 },
      { target: './img.png', line: 1 },
      { target: './plan.md', line: 8 },
    ]);
  });

  it('resolves against the linking file, keeps the anchor out of the path, and reports a dead link', () => {
    expect(resolveLink('docs/artist-os/plan.md', '../ARCHITECTURE.md#f42', FILES)).toBe('docs/ARCHITECTURE.md');
    expect(resolveLink('docs/artist-os/x.md', './plan.md', FILES)).toBe('docs/artist-os/plan.md');
    expect(resolveLink('docs/artist-os/x.md', '/docs/ARCHITECTURE.md', FILES)).toBe('docs/ARCHITECTURE.md');
    expect(resolveLink('docs/artist-os/x.md', '../artist-os/', FILES)).toBeNull(); // a directory is not a node
    expect(resolveLink('docs/artist-os/x.md', './gone.md', FILES)).toEqual({ unresolved: 'no such file' });
  });
});

describe('declared entities', () => {
  const owner = (rel: string, domain: 'RECORDS' | null = null) => (domain ? { domain, basis: 'frontmatter' as const } : ownerOf(rel, null));

  it('declares an agent owned by its frontmatter and defined by its file', () => {
    const text = '---\nname: fixture-declared\nclass: Execution\ndomain: RECORDS\ntools: []\nmodel: none\n---\n\n# Fixture\n\n## Role\n\n[FIXTURE]\n\n## Contract\n\n[FIXTURE]\n\n## Refuses\n\n[FIXTURE]\n';
    const d = declaredOf({ rootId: 'repo', rel: 'agents/fixture-declared.agent.md', text, owner: owner('agents/fixture-declared.agent.md', 'RECORDS'), files: FILES });
    expect(d.nodes).toEqual([expect.objectContaining({ id: 'agent:fixture-declared', kind: 'agent', ownerDomain: 'RECORDS', basis: 'frontmatter', line: 2 })]);
    expect(d.edges).toEqual(expect.arrayContaining([
      { relation: 'owned_by', fromId: 'agent:fixture-declared', toId: 'domain:RECORDS', line: 4, detail: 'domain: RECORDS' },
      { relation: 'defined_by', fromId: 'agent:fixture-declared', toId: 'file:repo/agents/fixture-declared.agent.md', line: 2, detail: 'agents/fixture-declared.agent.md' },
    ]));
  });

  it('reports an invalid agent file as a diagnostic, never a node', () => {
    const d = declaredOf({ rootId: 'repo', rel: 'agents/broken.agent.md', text: '---\nname: broken\n---\n', owner: owner('agents/broken.agent.md'), files: FILES });
    expect(d.nodes).toEqual([]);
    expect(d.edges).toEqual([expect.objectContaining({ relation: 'declares', fromId: 'file:repo/agents/broken.agent.md', toId: null, line: 1 })]);
    expect(d.edges[0]!.detail).toMatch(/^invalid agent file: /);
  });

  it('declares a workflow, its steps, the agents they use and their dependencies, by line', () => {
    const yaml = [
      'name: fixture-flow',            // 1
      'description: "[FIXTURE]"',      // 2
      'input:',                        // 3
      '  required: [query]',           // 4
      'steps:',                        // 5
      '  - id: retrieve',              // 6
      '    agent: context-retriever',  // 7
      '    input: { query: { $from: input.query } }',
      '  - id: summarize',             // 9
      '    agent: nobody-registered',  // 10
      '    dependsOn: [retrieve]',     // 11
      '    input: { items: { $from: steps.retrieve.output.items } }',
    ].join('\n');
    const d = declaredOf({ rootId: 'repo', rel: 'core/workflows/fixture-flow.workflow.yaml', text: yaml, owner: ownerOf('core/workflows/fixture-flow.workflow.yaml', null), files: FILES });
    expect(d.nodes.map((n) => [n.id, n.kind, n.line, n.ownerDomain])).toEqual([
      ['workflow:fixture-flow', 'workflow', 1, 'CORE'],
      ['workflow_step:fixture-flow#retrieve', 'workflow_step', 6, 'CORE'],
      ['workflow_step:fixture-flow#summarize', 'workflow_step', 9, 'CORE'],
    ]);
    expect(d.edges).toEqual(expect.arrayContaining([
      { relation: 'defined_by', fromId: 'workflow:fixture-flow', toId: 'file:repo/core/workflows/fixture-flow.workflow.yaml', line: 1, detail: 'core/workflows/fixture-flow.workflow.yaml' },
      { relation: 'part_of', fromId: 'workflow_step:fixture-flow#retrieve', toId: 'workflow:fixture-flow', line: 6, detail: 'retrieve' },
      { relation: 'step_uses_agent', fromId: 'workflow_step:fixture-flow#retrieve', toId: 'agent:context-retriever', line: 7, detail: 'context-retriever' },
      // An agent the registry doesn't know is still named here; the graph view shows it as a dangling diagnostic.
      { relation: 'step_uses_agent', fromId: 'workflow_step:fixture-flow#summarize', toId: 'agent:nobody-registered', line: 10, detail: 'nobody-registered' },
      { relation: 'depends_on', fromId: 'workflow_step:fixture-flow#summarize', toId: 'workflow_step:fixture-flow#retrieve', line: 11, detail: 'retrieve' },
    ]));
  });

  it('declares each ARCHITECTURE decision with its heading line and a per-section revision', () => {
    const text = ['# Architecture', '', '**F1. First decision.** DECIDED.', 'body one', '', '**F7. Seventh (AOS-9).** PROPOSED.', 'body seven', '', '## Next', 'not in F7'].join('\n');
    const d = declaredOf({ rootId: 'repo', rel: 'docs/ARCHITECTURE.md', text, owner: ownerOf('docs/ARCHITECTURE.md', null), files: FILES });
    expect(d.nodes.map((n) => [n.id, n.title, n.line, n.ownerDomain, n.revision])).toEqual([
      ['decision:F1', 'First decision', 3, null, sha(['**F1. First decision.** DECIDED.', 'body one', ''].join('\n'))],
      ['decision:F7', 'Seventh (AOS-9)', 6, null, sha(['**F7. Seventh (AOS-9).** PROPOSED.', 'body seven', ''].join('\n'))],
    ]);
  });

  it('turns imports and links into edges from the file node, unresolved ones with a null target', () => {
    const d = declaredOf({ rootId: 'repo', rel: 'core/x.ts', text: "import { a } from './a.ts';\nimport { m } from './missing.ts';\n", owner: ownerOf('core/x.ts', null), files: FILES });
    expect(d.edges).toEqual([
      { relation: 'imports', fromId: 'file:repo/core/x.ts', toId: 'file:repo/core/a.ts', line: 1, detail: './a.ts' },
      { relation: 'imports', fromId: 'file:repo/core/x.ts', toId: null, line: 2, detail: './missing.ts' },
    ]);
  });
});

describe('the real repository (read-only)', () => {
  it('declares exactly the agents the registry loads, with the same domains', async () => {
    const dir = join(REPO_ROOT, 'agents');
    const registry = loadAgents(dir);
    const declared: { name: string; domain: string | null }[] = [];
    for (const f of (await readdir(dir)).filter((n) => n.endsWith('.agent.md') && !n.startsWith('_')).sort()) {
      const rel = `agents/${f}`;
      const d = declaredOf({ rootId: 'repo', rel, text: await readFile(join(dir, f), 'utf8'), owner: ownerOf(rel, null), files: new Set() });
      for (const n of d.nodes) declared.push({ name: n.id.slice('agent:'.length), domain: n.ownerDomain });
    }
    const byName = (x: { name: string }, y: { name: string }) => x.name.localeCompare(y.name);
    expect(declared.sort(byName)).toEqual(registry.agents.map((a) => ({ name: a.name, domain: a.domain })).sort(byName));
  });

  it('parses every workflow file into a workflow node with at least one step', async () => {
    for (const rel of ['core/workflows/retrieve-and-summarize.workflow.yaml', 'records/workflows/build-suno-package.workflow.yaml', 'records/workflows/register-track.workflow.yaml',
      'records/workflows/schedule-release.workflow.yaml', 'records/x3lius/song-to-suno.workflow.yaml', 'tech/workflows/trace-intake.workflow.yaml']) {
      const d = declaredOf({ rootId: 'repo', rel, text: await readFile(join(REPO_ROOT, rel), 'utf8'), owner: ownerOf(rel, null), files: new Set() });
      expect(d.nodes.filter((n) => n.kind === 'workflow')).toHaveLength(1);
      expect(d.nodes.filter((n) => n.kind === 'workflow_step').length).toBeGreaterThan(0);
    }
  });
});

describe('the scan writes what files declare', () => {
  let db: TestDb;
  let root: string;
  const put = async (rel: string, body: string) => {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), body);
  };
  const scan = () => scanRoots(db.sql, { roots: [{ id: 'repo', dir: root }], trigger: 'cli', store: createLocalVaultStore(join(root, '.vault')) });

  beforeAll(async () => {
    db = await createTestDb('aos04_refs', { migrated: true });
    root = await mkdtemp(join(tmpdir(), 'xyp-refs-'));
    await put('agents/fixture-retriever.agent.md', '---\nname: fixture-retriever\nclass: Knowledge\ndomain: CORE\ntools: []\nmodel: none\n---\n\n## Role\n\nx\n\n## Contract\n\nx\n\n## Refuses\n\nx\n');
    await put('core/workflows/fixture.workflow.yaml', 'name: fixture\ndescription: x\nsteps:\n  - id: one\n    agent: fixture-retriever\n  - id: two\n    agent: fixture-ghost\n    dependsOn: [one]\n');
    await put('core/workflows/zz-copy.workflow.yaml', 'name: fixture\ndescription: a second file claiming the same name\nsteps:\n  - id: one\n    agent: fixture-retriever\n');
    await put('core/a.ts', "import { b } from './b.ts';\nimport { gone } from './gone.ts';\n");
    await put('core/b.ts', 'export const b = 1;\n');
  }, 60_000);
  afterAll(async () => {
    await db?.drop();
    await rm(root, { recursive: true, force: true });
  });

  it('draws the proven edges and diagnoses the rest, including a duplicate workflow name', async () => {
    expect((await scan()).status).toBe('success');
    const edges = await db.sql<{ relation: string; from_id: string; to_id: string; provenance: string }[]>`
      select relation, from_id, to_id, provenance from graph_edges where origin = 'index' and relation <> 'owned_by'`;
    expect(edges).toEqual(expect.arrayContaining([
      { relation: 'imports', from_id: 'file:repo/core/a.ts', to_id: 'file:repo/core/b.ts', provenance: 'core/a.ts:1' },
      { relation: 'step_uses_agent', from_id: 'workflow_step:fixture#one', to_id: 'agent:fixture-retriever', provenance: 'core/workflows/fixture.workflow.yaml:5' },
      { relation: 'depends_on', from_id: 'workflow_step:fixture#two', to_id: 'workflow_step:fixture#one', provenance: 'core/workflows/fixture.workflow.yaml:8' },
    ]));
    const diags = await db.sql<{ problem: string; relation: string; detail: string; source_ref: string }[]>`
      select problem, relation, detail, source_ref from graph_diagnostics order by source_ref`;
    // Two files claim workflow:fixture: the first path (sorted) declares it; the other is a diagnostic, not a crash.
    expect(diags).toEqual([
      { problem: 'unresolved', relation: 'imports', detail: './gone.ts', source_ref: 'core/a.ts:2' },
      { problem: 'dangling', relation: 'step_uses_agent', detail: 'fixture-ghost', source_ref: 'core/workflows/fixture.workflow.yaml:7' },
      { problem: 'unresolved', relation: 'declares', detail: 'duplicate workflow:fixture (declared in core/workflows/fixture.workflow.yaml)', source_ref: 'core/workflows/zz-copy.workflow.yaml:1' },
    ]);
    const [agent] = await db.sql<{ owner_domain: string }[]>`select owner_domain::text from graph_nodes where id = 'agent:fixture-retriever'`;
    expect(agent).toEqual({ owner_domain: 'CORE' });
    // Stored as a JSON object, not a JSON string holding one.
    const [detail] = await db.sql<{ t: string; cls: string }[]>`select jsonb_typeof(detail) as t, detail->>'class' as cls from index_nodes where id = 'agent:fixture-retriever'`;
    expect(detail).toEqual({ t: 'object', cls: 'Knowledge' });
  });

  it('replaces a changed file\'s declarations and drops a vanished file\'s', async () => {
    const declaredIn = async () =>
      (await db.sql<{ file: string }[]>`select f.path as file from index_nodes n join indexed_files f on f.id = n.file_id where n.id = 'workflow:fixture'`)[0]?.file;
    await put('core/a.ts', "import { b } from './b.ts';\n");
    await unlink(join(root, 'core/workflows/fixture.workflow.yaml'));
    expect((await scan()).status).toBe('success');
    expect(await db.sql`select detail from graph_diagnostics where relation = 'imports'`).toEqual([]);
    // The declaring file is gone, so is its workflow. The copy is unchanged: a quick scan doesn't re-read it,
    // a full scan does, and then it declares the workflow.
    expect(await declaredIn()).toBeUndefined();
    const full = await scanRoots(db.sql, { roots: [{ id: 'repo', dir: root }], trigger: 'cli', store: createLocalVaultStore(join(root, '.vault')), full: true });
    expect(full.status).toBe('success');
    expect(await declaredIn()).toBe('core/workflows/zz-copy.workflow.yaml');
  });
});
