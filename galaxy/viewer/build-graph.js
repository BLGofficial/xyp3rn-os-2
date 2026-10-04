// Browser-native model: source identities survive index renumbering and input order changes.
/** @param {import('./graph.types.ts').SourceGraph} source @returns {import('./graph.types.ts').GraphData} */
export function buildGraph(source) {
  if (!source || !Array.isArray(source.nodes) || !Array.isArray(source.links)) throw Error('Invalid graph data');
  const ids = new Map(), paths = new Set(), groups = new Map();
  /** @type {import('./graph.types.ts').GraphNode[]} */
  const nodes = source.nodes.map(note => {
    if (!Number.isInteger(note.id) || note.id < 0 || typeof note.path !== 'string' || !note.path ||
        typeof note.label !== 'string' || typeof note.group !== 'string' || !note.group ||
        ids.has(note.id) || paths.has(note.path)) throw Error('Invalid or duplicate note identity');
    const id = `note:${note.path}`;
    ids.set(note.id, id); paths.add(note.path);
    if (!groups.has(note.group)) groups.set(note.group, []);
    groups.get(note.group).push(note.path);
    return { id, kind: note.path === 'README.md' ? 'core' : 'note', label: note.label, group: note.group, paths: [note.path], note };
  });
  /** @type {import('./graph.types.ts').GraphEdge[]} */
  const edges = [];
  const seen = new Set(), related = new Set();
  for (const link of source.links) {
    const a = ids.get(typeof link.source === 'object' ? link.source?.id : link.source);
    const b = ids.get(typeof link.target === 'object' ? link.target?.id : link.target);
    if (!a || !b || a === b) throw Error('Dangling or self-linked source relationship');
    const [s, t] = [a, b].sort(), id = JSON.stringify(['related', s, t]);
    if (seen.has(id)) continue;
    seen.add(id); related.add(s); related.add(t);
    edges.push({ id, source: s, target: t, kind: 'related', directed: false,
      provenance: 'galaxy/build.py: filename/title mention, wikilink, or shared wiki reference; original direction unavailable' });
  }
  const isolated = nodes.filter(n => !related.has(n.id)).map(n => n.id).sort();
  for (const [group, members] of groups) {
    const id = `group:${group}`;
    nodes.push({ id, kind: 'cluster', label: group, group, paths: members.sort() });
    for (const path of members) edges.push({ id: JSON.stringify(['contains', id, path]), source: id,
      target: `note:${path}`, kind: 'contains', directed: true, provenance: `Indexed group membership: ${path}` });
  }
  return { nodes: nodes.sort((a, b) => compare(a.id, b.id)), edges: edges.sort((a, b) => compare(a.id, b.id)), isolated };
}

// Locale-independent ordering keeps seeded layout stable across operating systems.
/** @param {string} a @param {string} b */
export function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
