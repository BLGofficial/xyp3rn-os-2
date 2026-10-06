import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DOMAINS } from '../../../../../core/contracts/taxonomy.ts';
import { graphLoaders, hudLoaders, osLoaders, runtime } from '../../../lib/server';

// The Dashboard Pack's /api/v1 reads (apps/web/app/dashboard). Each one adapts a loader the app already has to the
// shape the pack's components fetch; nothing here writes. Behind the session check (middleware.ts: no session, 401).

export const NO_STORE = { 'cache-control': 'no-store' };

/** A JSON GET that logs the cause for the owner and answers the browser without internals. */
export const read = async (what: string, load: () => Promise<unknown>): Promise<Response> => {
  try {
    return Response.json(await load(), { headers: NO_STORE });
  } catch (e) {
    console.error(`v1 ${what} failed:`, e);
    return Response.json({ error: `the server could not read ${what}` }, { status: 500, headers: NO_STORE });
  }
};

type Overview = Awaited<ReturnType<Awaited<ReturnType<typeof graphLoaders>>['overview']>>;
const overview = async (): Promise<Overview> => (await graphLoaders()).overview((await runtime()).sql);

// The pack's eight knowledge groups, from an index node's kind and title.
const groupFor = (kind: string, title: string): string => {
  const t = title.toLowerCase();
  if (kind === 'agent' || kind === 'agent_run') return 'AGENTS';
  if (/handoff/.test(t)) return 'HANDOFFS';
  if (/(^|\/)skills?\//.test(t) || /skill\.md$/.test(t)) return 'SKILLS';
  if (kind === 'decision' || /spec|plan/.test(t)) return 'SPECS';
  if (/research/.test(t)) return 'RESEARCH';
  if (kind === 'vault_file' || kind === 'lineage' || kind === 'artifact_version' || /song|lyric|suno/.test(t)) return 'SONGS';
  if (kind.startsWith('workflow') || kind === 'domain') return 'ARTIST-OS';
  return 'DOCS';
};

/** GET /api/v1/knowledge/graph: the sphere's bounded overview as nodes and links; groups stand in for their members. */
export const knowledgeGraph = async () => {
  const o = await overview();
  const nodes = [
    ...o.nodes.map((n) => ({ id: n.id, label: n.title, group: groupFor(n.kind, n.title), dbPrimaryKey: n.id,
      metadata: { kind: n.kind, domain: n.ownerDomain, availability: n.availability, href: n.href } })),
    ...o.groups.map((g) => ({ id: g.id, label: `${g.label} (${g.count})`, group: groupFor(g.kind, g.label),
      metadata: { kind: g.kind, domain: g.domain, count: g.count, href: g.href } })),
  ];
  const ids = new Set(nodes.map((n) => n.id));
  const links = o.edges.filter((e) => ids.has(e.fromId) && ids.has(e.toId))
    .map((e) => ({ source: e.fromId, target: e.toId, relation: e.grouping ? 'contains' : e.relation }));
  return { nodes, links, asOf: o.asOf };
};

const RING_COLOR = { core: '#D4AF37', skills: '#00F3FF', domain: '#A855F7', tool: '#10B981' } as const;
const SKILLS_SHOWN = 18;

/** GET /api/v1/galaxy/topology: the OS hub, its six domains, their agents (skills ring) and workflows (tool ring). */
export const galaxyTopology = async () => {
  const o = await overview();
  const count = (d: string) => o.nodes.filter((n) => n.ownerDomain === d).length
    + o.groups.filter((g) => g.domain === d).reduce((s, g) => s + g.count, 0);
  const node = (id: string, label: string, ring: keyof typeof RING_COLOR, metadata: Record<string, unknown>) =>
    ({ id, label, ring, color: RING_COLOR[ring], metadata });
  const agents = o.nodes.filter((n) => n.kind === 'agent').slice(0, SKILLS_SHOWN);
  const workflows = o.nodes.filter((n) => n.kind === 'workflow');
  const nodes = [
    node('core', 'XYP3RN', 'core', { indexed: o.counts.indexed, drawn: o.counts.drawn, asOf: o.asOf }),
    ...DOMAINS.map((d) => node(`domain:${d}`, d, 'domain', { domain: d, entities: count(d) })),
    ...agents.map((a) => node(a.id, a.title, 'skills', { kind: a.kind, domain: a.ownerDomain, href: a.href })),
    ...workflows.map((w) => node(w.id, w.title, 'tool', { kind: w.kind, domain: w.ownerDomain, href: w.href })),
  ];
  const links = [
    ...DOMAINS.map((d) => ({ source: 'core', target: `domain:${d}`, strength: 1 })),
    ...[...agents, ...workflows].filter((n) => n.ownerDomain)
      .map((n) => ({ source: `domain:${n.ownerDomain}`, target: n.id, strength: n.kind === 'agent' ? 0.6 : 0.4 })),
  ];
  return { nodes, links };
};

/** GET /api/v1/records/tracks: every Vault audio file, playable through /vault/files/{id}/raw. */
export const recordsTracks = async () => {
  const lib = await (await osLoaders()).audioLibrary((await runtime()).sql, 200);
  return {
    total: lib.total,
    tracks: lib.items.map((a) => ({
      id: a.id, title: a.title, audioUrl: `/vault/files/${a.id}/raw`, updatedAt: a.createdAt,
      type: a.tracks.length ? 'release' : 'demo', releaseName: a.tracks[0]?.releaseTitle,
      artist: a.songs.map((s) => s.title).join(', ') || undefined,
    })),
  };
};

/** GET /api/v1/research/notebooks: the latest research runs, one notebook each. */
export const researchNotebooks = async () => {
  const s = await (await osLoaders()).researchSummary((await runtime()).sql);
  return {
    notebooks: s.runs.map((r) => ({ id: r.id, name: r.question, status: r.status, updatedAt: r.createdAt,
      description: `Research run · ${r.status}` })),
    openBriefs: s.openBriefs, acceptedFindings: s.acceptedFindings, undecidedFindings: s.undecidedFindings,
  };
};

const VAULT_FILES_SHOWN = 500;

/** GET /api/v1/knowledge/obsidian: the owner's vault notes (XYP_OBSIDIAN_VAULT), newest first. Reads the folder only. */
export const obsidianFiles = async () => {
  const root = process.env.XYP_OBSIDIAN_VAULT?.trim();
  if (!root) throw new Error('XYP_OBSIDIAN_VAULT is not set');
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const notes = entries.filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => join(e.parentPath, e.name))
    .filter((abs) => !relative(root, abs).split(/[\\/]/).some((part) => part.startsWith('.')));
  const files = await Promise.all(notes.map(async (abs) => {
    const s = await stat(abs); const rel = relative(root, abs).replaceAll('\\', '/');
    return { id: rel, name: rel.split('/').pop()!.replace(/\.md$/, ''), path: rel, kind: 'markdown', size: s.size, updatedAt: s.mtime.toISOString() };
  }));
  files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { root, total: files.length, files: files.slice(0, VAULT_FILES_SHOWN) };
};

type HudEvent = Awaited<ReturnType<Awaited<ReturnType<typeof hudLoaders>>['hudEventsSince']>>['events'][number];
export type SseFrame = { readonly event: string; readonly data: unknown };

const POLL_MS = 2000;
const HEARTBEAT_MS = 15_000;

/**
 * The HUD activity feed (as /api/events/stream: a 2 s cursor poll, a heartbeat every 15 s) re-shaped per event
 * for a pack component.
 * @param req - the request (its abort closes the stream)
 * @param frames - the SSE frames one activity row becomes
 */
export const hudSse = async (req: Request, frames: (e: HudEvent) => readonly SseFrame[]): Promise<Response> => {
  const [rt, hl] = [await runtime(), await hudLoaders()];
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      let cursor: string | null = null; let seen: ReadonlySet<string> = new Set();
      let lastBeat = Date.now(); let closed = false;
      const close = () => { if (closed) return; closed = true; clearTimeout(timer); try { ctrl.close(); } catch { /* already closed */ } };
      req.signal.addEventListener('abort', close);
      const tick = async () => {
        if (closed) return;
        try {
          const r = await hl.hudEventsSince(rt.sql, cursor, seen);
          cursor = r.cursor; seen = r.seen;
          for (const e of r.events) for (const f of frames(e)) ctrl.enqueue(enc.encode(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`));
          if (Date.now() - lastBeat > HEARTBEAT_MS) { ctrl.enqueue(enc.encode(': heartbeat\n\n')); lastBeat = Date.now(); }
        } catch (e) {
          console.error('v1 stream failed:', e);
        }
        if (!closed) timer = setTimeout(tick, POLL_MS);
      };
      ctrl.enqueue(enc.encode('retry: 5000\n\n'));
      await tick();
    },
    cancel() { clearTimeout(timer); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' } });
};

export const isLive = (status: string) => /running|started|queued|pending|active/i.test(status);

/** Which ContextDispatchPipeline lane a HUD event drives. */
export const laneOf = (e: HudEvent): string =>
  e.kind === 'research' ? 'research' : e.kind === 'scan' ? 'knowledge-ingest'
    : /song|lyric|suno|music/i.test(e.title) ? 'songwriting' : /release|distribut/i.test(e.title) ? 'release-ops' : 'artist-os';
