import { createHash } from 'node:crypto';
import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from 'yaml';
import { parseAgentFile } from '../../core/agent-registry/parse-agent-file.ts';
import type { Domain } from '../../core/contracts/taxonomy.ts';
import { importsOf, markdownLinksOf, resolveImport, resolveLink } from './refs.ts';
import type { Basis, Ownership } from './scope.ts';

/**
 * What one file declares (AOS-04 Plan C1 Task 3, design §15.2–15.3): the entities it defines (an agent, a
 * workflow and its steps, ARCHITECTURE decisions) and the references it makes, each with the line it's on.
 * An edge's `toId` names the entity it points at; whether that entity exists is the graph view's question,
 * so an unknown agent shows up there as a dangling diagnostic. A reference to no file is `toId: null`.
 */

export type DeclaredNode = {
  readonly id: string; readonly kind: 'agent' | 'workflow' | 'workflow_step' | 'decision'; readonly title: string;
  readonly ownerDomain: Domain | null; readonly basis: Basis; readonly line: number; readonly revision: string;
  readonly detail: Readonly<Record<string, unknown>>;
};
export type DeclaredEdge = { readonly relation: string; readonly fromId: string; readonly toId: string | null; readonly line: number; readonly detail: string };
export type Declared = { readonly nodes: DeclaredNode[]; readonly edges: DeclaredEdge[] };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// The registry's own rule: agents/<name>.agent.md, templates (`_`) skipped.
const AGENT_FILE = /^agents\/(?!_)[^/]+\.agent\.md$/;
const WORKFLOW_FILE = /\.workflow\.yaml$/;
const ARCHITECTURE = 'docs/ARCHITECTURE.md';
const DECISION = /^\*\*F(\d+)\. (.+?)\*\*/;

const lineOfKey = (text: string, key: string): number => {
  const i = text.split('\n').findIndex((l) => l.startsWith(`${key}:`));
  return i < 0 ? 1 : i + 1;
};

const agentOf = (rel: string, text: string, fileId: string): Declared => {
  const r = parseAgentFile(rel, text);
  if (!r.ok) return { nodes: [], edges: [{ relation: 'declares', fromId: fileId, toId: null, line: 1, detail: `invalid agent file: ${r.errors.join('; ')}` }] };
  const a = r.agent;
  const id = `agent:${a.name}`;
  const line = lineOfKey(text, 'name');
  return {
    nodes: [{ id, kind: 'agent', title: a.name, ownerDomain: a.domain, basis: 'frontmatter', line, revision: sha256(text), detail: { class: a.class, model: a.model, tools: a.tools } }],
    edges: [
      { relation: 'owned_by', fromId: id, toId: `domain:${a.domain}`, line: lineOfKey(text, 'domain'), detail: `domain: ${a.domain}` },
      { relation: 'defined_by', fromId: id, toId: fileId, line, detail: rel },
    ],
  };
};

const workflowOf = (rel: string, text: string, fileId: string, owner: Ownership): Declared => {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const lineOf = (n: YamlNode | null | undefined): number => (n?.range ? lc.linePos(n.range[0]).line : 1);
  const name = doc.get('name', true);
  if (doc.errors.length > 0 || !isScalar(name) || typeof name.value !== 'string') {
    const why = doc.errors[0]?.message.split('\n')[0] ?? 'no name';
    return { nodes: [], edges: [{ relation: 'declares', fromId: fileId, toId: null, line: 1, detail: `invalid workflow file: ${why}` }] };
  }
  const wf = name.value;
  const id = `workflow:${wf}`;
  const revision = sha256(text);
  const base = { ownerDomain: owner.domain, basis: owner.basis, revision };
  const nodes: DeclaredNode[] = [{ id, kind: 'workflow', title: wf, line: lineOf(name), detail: {}, ...base }];
  const edges: DeclaredEdge[] = [{ relation: 'defined_by', fromId: id, toId: fileId, line: lineOf(name), detail: rel }];
  if (owner.domain) edges.push({ relation: 'owned_by', fromId: id, toId: `domain:${owner.domain}`, line: lineOf(name), detail: owner.basis });
  const steps = doc.get('steps', true);
  for (const step of isSeq(steps) ? steps.items : []) {
    if (!isMap(step)) continue;
    const sid = step.get('id', true);
    if (!isScalar(sid) || typeof sid.value !== 'string') continue;
    const stepId = `workflow_step:${wf}#${sid.value}`;
    nodes.push({ id: stepId, kind: 'workflow_step', title: `${wf} · ${sid.value}`, line: lineOf(sid), detail: {}, ...base });
    edges.push({ relation: 'part_of', fromId: stepId, toId: id, line: lineOf(sid), detail: sid.value });
    const agent = step.get('agent', true);
    if (isScalar(agent) && typeof agent.value === 'string') {
      edges.push({ relation: 'step_uses_agent', fromId: stepId, toId: `agent:${agent.value}`, line: lineOf(agent), detail: agent.value });
    }
    const deps = step.get('dependsOn', true);
    for (const d of isSeq(deps) ? deps.items : []) {
      if (isScalar(d) && typeof d.value === 'string') {
        edges.push({ relation: 'depends_on', fromId: stepId, toId: `workflow_step:${wf}#${d.value}`, line: lineOf(d), detail: d.value });
      }
    }
  }
  return { nodes, edges };
};

// A decision's section runs from its heading to the next decision or the next Markdown heading; its revision
// is that section's hash, so an edit to one decision doesn't mark every other one changed.
const decisionsOf = (text: string): Declared => {
  const lines = text.split('\n');
  const nodes: DeclaredNode[] = [];
  lines.forEach((l, i) => {
    const m = DECISION.exec(l);
    if (!m) return;
    let end = i + 1;
    while (end < lines.length && !DECISION.test(lines[end]!) && !/^#{1,6} /.test(lines[end]!)) end++;
    nodes.push({
      // Known by its number: the title leads with it, so a list, a search or an inherited target reads "F41 · …".
      id: `decision:F${m[1]}`, kind: 'decision', title: `F${m[1]} · ${m[2]!.replace(/\.$/, '')}`, ownerDomain: null, basis: 'shared', line: i + 1,
      revision: sha256(lines.slice(i, end).join('\n')), detail: {},
    });
  });
  return { nodes, edges: [] };
};

/**
 * What a file declares.
 * @param o.rootId - the index root (`repo`)
 * @param o.rel - the file's root-relative path
 * @param o.text - its text
 * @param o.owner - its ownership (scope.ownerOf)
 * @param o.files - every indexed path in the root, to resolve references against
 * @returns the entities it defines and the edges it proves (unresolved references with `toId: null`)
 */
export const declaredOf = (o: { readonly rootId: string; readonly rel: string; readonly text: string; readonly owner: Ownership; readonly files: ReadonlySet<string> }): Declared => {
  const fileId = `file:${o.rootId}/${o.rel}`;
  const out: Declared = { nodes: [], edges: [] };
  const add = (d: Declared) => {
    out.nodes.push(...d.nodes);
    out.edges.push(...d.edges);
  };
  if (AGENT_FILE.test(o.rel)) add(agentOf(o.rel, o.text, fileId));
  if (WORKFLOW_FILE.test(o.rel)) add(workflowOf(o.rel, o.text, fileId, o.owner));
  if (o.rel === ARCHITECTURE) add(decisionsOf(o.text));
  if (CODE.test(o.rel)) {
    for (const r of importsOf(o.text)) {
      const to = resolveImport(o.rel, r.specifier, o.files);
      if (to !== null) out.edges.push({ relation: 'imports', fromId: fileId, toId: typeof to === 'string' ? `file:${o.rootId}/${to}` : null, line: r.line, detail: r.specifier });
    }
  }
  if (o.rel.endsWith('.md')) {
    for (const l of markdownLinksOf(o.text)) {
      const to = resolveLink(o.rel, l.target, o.files);
      if (to !== null) out.edges.push({ relation: 'references', fromId: fileId, toId: typeof to === 'string' ? `file:${o.rootId}/${to}` : null, line: l.line, detail: l.target });
    }
  }
  return out;
};
