import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import type { DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { ENTRYPOINTS, planRequest } from '../../core/orchestrator/orchestrate.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { CLASS_CAPABILITIES } from '../../core/tool-registry/capabilities.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { runTechSystem, TECH_SYSTEM_SERVICE } from '../../tech/entrypoint.ts';
import { loadTechSystem, TECH_MANIFEST } from '../../tech/tech-system.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// Phase 14 proof (part 4): Products / Audio Tools / AI Systems / R&D are TECH sub-components
// (reserved ids; the six-domain taxonomy is unchanged), registered the Phase 7 way: a first-party
// manifest admitted through the gate, one agent per component named after its module, and a TECH
// entrypoint for `pnpm ask`.

let db: TestDb;
let deps: DispatchDeps;
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });

beforeAll(async () => {
  db = await createTestDb('phase14_tech_system', { migrated: true });
  const r = await ingestSource(db.sql, { kind: 'file', path: TECH_MANIFEST, origin: 'first_party' });
  expect(r.status, r.error).toBe('success');
  deps = { sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql }), handlers: HANDLERS };
});
afterAll(async () => {
  await db?.drop();
});

const COMPONENTS = ['tech-products', 'tech-audio-tools', 'tech-ai-systems', 'tech-r-and-d'];

describe('the TECH manifest, admitted through the gate', () => {
  it('declares the parent and the four reserved components, with the phase that builds each', () => {
    const t = loadTechSystem();
    expect(t.parent.slug).toBe('xyp3rn-tech');
    expect(t.components.map((c) => [c.slug, c.builtIn])).toEqual([
      ['tech-products', null], ['tech-audio-tools', '14'], ['tech-ai-systems', null], ['tech-r-and-d', '14'],
    ]);
  });

  it('becomes five TECH modules, each component subdomain_of the parent, written by the gate', async () => {
    const mods = await db.sql<{ slug: string; domain: string; promoted_via: string }[]>`
      select slug, domain::text, promoted_via::text from modules where slug = 'xyp3rn-tech' or slug like 'tech-%' order by slug`;
    expect(mods.map((m) => m.slug)).toEqual(['tech-ai-systems', 'tech-audio-tools', 'tech-products', 'tech-r-and-d', 'xyp3rn-tech']);
    expect(new Set(mods.map((m) => `${m.domain}/${m.promoted_via}`))).toEqual(new Set(['TECH/gate']));
    const edges = await db.sql<{ n: number }[]>`
      select count(*)::int as n from relations r
      join modules s on r.subject_type = 'module' and s.id::text = r.subject_id
      join modules o on r.object_type = 'module' and o.id::text = r.object_id
      where r.predicate = 'subdomain_of' and o.slug = 'xyp3rn-tech'`;
    expect(edges[0]!.n).toBe(4);
  });
});

describe('one agent per component, single-class', () => {
  it('registers exactly the manifest\'s components as tech-* agents; the registry validates', () => {
    expect(registry.validateAll()).toEqual([]);
    expect(registry.list().filter((a) => a.name.startsWith('tech-')).map((a) => a.name).sort()).toEqual([...COMPONENTS].sort());
    const shape = (n: string) => { const a = registry.get(n)!; return [a.class, a.domain, a.model === 'none' ? 'none' : 'llm', [...a.tools].sort()]; };
    expect(shape('tech-products')).toEqual(['Knowledge', 'TECH', 'none', ['log_message', 'retrieve_context']]);
    expect(shape('tech-ai-systems')).toEqual(['Knowledge', 'TECH', 'none', ['log_message', 'retrieve_context']]);
    expect(shape('tech-audio-tools')).toEqual(['Execution', 'TECH', 'none', ['link_trace_report', 'log_message', 'record_trace_analysis']]);
    expect(shape('tech-r-and-d')).toEqual(['Planning', 'TECH', 'llm', ['log_message', 'read_frontier_evidence', 'write_rd_backlog']]);
  });

  it('capabilities: research.read is Planning\'s, trace.write is Execution\'s; each tool declares its own', () => {
    expect(CLASS_CAPABILITIES['research.read']).toEqual(['Planning']);
    expect(CLASS_CAPABILITIES['trace.write']).toEqual(['Execution']);
    const tools = createRuntimeTools({ sql: db.sql });
    expect(['record_trace_analysis', 'link_trace_report', 'read_frontier_evidence', 'write_rd_backlog'].map((t) => tools.get(t)?.capability))
      .toEqual(['trace.write', 'trace.write', 'research.read', 'plan.write']);
    expect(tools.authorize('Planning', 'record_trace_analysis').allow).toBe(false);
    expect(tools.authorize('Execution', 'write_rd_backlog').allow).toBe(false);
    expect(tools.authorize('Knowledge', 'read_frontier_evidence').allow).toBe(false);
  });
});

describe('pnpm ask → TECH', () => {
  it('the router\'s TECH requests now have an entrypoint', () => {
    expect(ENTRYPOINTS.TECH).toEqual({ service: TECH_SYSTEM_SERVICE });
    const plan = planRequest('Add a stereo-width meter feature to the TRACE plugin backlog', ENTRYPOINTS);
    expect(plan).toMatchObject({ action: 'run-service', service: 'tech-system', route: { domain: 'TECH' } });
  });

  it('runs a matching stub component with the request', async () => {
    const r = await runTechSystem(deps, { request: 'Which LLM inference providers do our AI systems use?' });
    expect(r).toMatchObject({ status: 'success', selected: ['tech-ai-systems'] });
    expect(r.outputs['tech-ai-systems']).toMatchObject({ subdomain: 'tech-ai-systems', status: 'stub', builtIn: null });
  }, 60_000);

  it('Audio Tools take measurements, not text: a TRACE request is answered with the service to call', async () => {
    const r = await runTechSystem(deps, { request: 'check the loudness of this mix with the TRACE plugin meter' });
    expect(r).toMatchObject({ status: 'clarify', selected: ['tech-audio-tools'] });
    expect(r.reason).toMatch(/POST \/v1\/trace\/analyses/);
    expect(r.reason).toMatch(/pnpm trace:serve/);
  });

  it('no component matched → clarify naming the components, never a default', async () => {
    const r = await runTechSystem(deps, { request: 'hello there' });
    expect(r).toMatchObject({ status: 'clarify', selected: [] });
    expect(r.reason).toMatch(/Products.*Audio Tools.*AI Systems.*R&D/);
  });
});
