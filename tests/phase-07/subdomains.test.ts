import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { ENTRYPOINTS, planRequest } from '../../core/orchestrator/orchestrate.ts';
import { BUILT_SUBDOMAINS, HANDLERS } from '../../core/runtime/handlers.ts';
import { parseScope } from '../../research-intelligence/orchestrator/select.ts';
import { loadMusicSystem, MUSIC_SYSTEM_SERVICE, selectSubdomains } from '../../records/x3lius/music-system.ts';
import { REPO_ROOT } from '../helpers/db.ts';

// Phase 7 task 3: module + ten stub sub-domains registered in the Agent Registry, routable.

const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const system = loadMusicSystem();

// Later phases replace stubs with real agents under the same names (Phase 8: Songwriting, Lyrics,
// Composition; Phase 9: Suno, Genre/Style; Phase 10: Vocal DNA — tests/phase-08..10). The rest stay stubs.
const BUILT: readonly string[] = BUILT_SUBDOMAINS;
// Agents that work inside a sub-domain without being one (Phase 10: the Vocal DNA's RVC consumer).
const SUBDOMAIN_MEMBERS = ['x3lius-rvc-post'];

describe('Agent Registry: one agent per sub-domain', () => {
  it.each(system.subdomains.filter((s) => !BUILT.includes(s.slug)).map((s) => [s.slug]))('%s: read-only Knowledge stub under RECORDS with a handler and a scope', (slug) => {
    const a = registry.get(slug);
    expect(a).toMatchObject({ name: slug, class: 'Knowledge', domain: 'RECORDS', tools: ['retrieve_context', 'log_message'], model: 'none' });
    expect(HANDLERS[slug]).toBeTypeOf('function');
    expect(() => parseScope(slug, a!.sections.Scope ?? '')).not.toThrow();
  });

  it('has no x3lius-* agent outside the manifest, and the whole registry still validates', () => {
    const names = new Set(system.subdomains.map((s) => s.slug));
    expect(registry.list().filter((a) => a.name.startsWith('x3lius-') && !names.has(a.name)).map((a) => a.name)).toEqual(SUBDOMAIN_MEMBERS);
    expect(registry.validateAll()).toEqual([]);
  });
});

describe('routing into the sub-domains', () => {
  it.each([
    ['Write a Suno style prompt for the next X3LIUS single', ['x3lius-suno']],
    ['Master the new X3LIUS track to -9 LUFS', ['x3lius-mix-master']],
    ['Write the hook and chorus for an X3LIUS song', ['x3lius-songwriting']],
    ['Write rhymes and lyric bars for X3LIUS', ['x3lius-lyrics']],
    ['Describe the X3LIUS vocal DNA and ad-lib style', ['x3lius-vocal-dna']],
    ['Pick the chord progression and melody for the X3LIUS intro', ['x3lius-composition']],
  ])('selects by scope keywords: %s', (request, expected) => {
    expect(selectSubdomains(request, registry).selected.map((s) => s.name)).toEqual(expected);
  });

  it('selects nothing when no sub-domain matches — never a default', () => {
    expect(selectSubdomains('Plan the X3LIUS release calendar', registry).selected).toEqual([]);
  });

  it('RECORDS requests go to the X3LIUS Music System entrypoint', () => {
    expect(MUSIC_SYSTEM_SERVICE).toBe('x3lius-music-system');
    expect(planRequest('Write a Suno style prompt for the next X3LIUS single', ENTRYPOINTS)).toMatchObject({
      action: 'run-service', service: 'x3lius-music-system', route: { status: 'routed', domain: 'RECORDS' },
    });
  });
});
