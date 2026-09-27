import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { SELECTION_THRESHOLD, parseScope, selectSpecialists, type SpecialistScope } from '../../research-intelligence/orchestrator/select.ts';
import { renderSpecialistTable } from '../../research-intelligence/specialists/table.ts';
import { REPO_ROOT } from '../helpers/db.ts';

// Phase 6B proof: 20 Research specialists, non-overlapping scopes (checked mechanically), and the
// Phase 17 acceptance question activates the five the source architecture names — not all 20.

// The guide's roster (F13, confirmed by the user), in its numbering.
const ROSTER = [
  'suno-researcher',
  'udio-alt-platform-researcher',
  'model-version-changelog-researcher',
  'ai-vocal-systems-researcher',
  'voice-cloning-researcher',
  'mix-master-ai-tooling-researcher',
  'prompt-engineering-researcher',
  'prompt-formula-template-researcher',
  'negative-prompt-failure-mode-researcher',
  'songwriting-structure-researcher',
  'lyrics-rhyme-systems-researcher',
  'genre-style-researcher',
  'composition-arrangement-researcher',
  'artist-identity-researcher',
  'brand-persona-consistency-researcher',
  'evaluation-researcher',
  'benchmark-scoring-methodology-researcher',
  'rights-licensing-researcher',
  'release-strategy-platform-algo-researcher',
  'frontier-tool-scanner-researcher',
];

const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const specialists = () => registry.list().filter((a) => a.class === 'Research');
const scopes = (): SpecialistScope[] => specialists().map((a) => parseScope(a.name, a.sections.Scope ?? ''));

describe('the 20 specialist definitions', () => {
  it('are exactly the confirmed roster, all valid in the registry', () => {
    expect(registry.validateAll()).toEqual([]);
    expect(specialists().map((a) => a.name).sort()).toEqual([...ROSTER].sort());
  });

  it.each(ROSTER)('%s: Research / RESEARCH_INTELLIGENCE, evidence tools only, LLM-backed', (name) => {
    const a = registry.get(name)!;
    // AOS-04 R1: the specialists run on the OpenRouter free route.
    expect(a).toMatchObject({ class: 'Research', domain: 'RESEARCH_INTELLIGENCE', model: 'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free' });
    expect([...a.tools].sort()).toEqual(['fetch_source', 'log_message', 'retrieve_context', 'write_evidence']);
  });

  it.each(ROSTER)('%s: one-sentence scope + weighted keywords', (name) => {
    const s = parseScope(name, registry.get(name)!.sections.Scope ?? '');
    expect(s.sentence.length).toBeGreaterThan(20);
    expect(s.keywords.length).toBeGreaterThan(0);
  });

  it.each(ROSTER)('%s: writes only evidence/sources, model/version-tagged; refuses promotion and unsourced claims', (name) => {
    const a = registry.get(name)!;
    expect(a.contract).toMatch(/\*\*Writes:\*\* ONLY `research_sources` and `research_evidence`/);
    expect(a.contract).toMatch(/model\/version tag/);
    expect(a.refuses).toMatch(/Promoting anything to canonical knowledge/);
    expect(a.refuses).toMatch(/without a `research_sources` row backing it/);
  });
});

describe('no scope overlap (mechanical)', () => {
  it('every defining keyword (weight 3) belongs to exactly one specialist', () => {
    const owners = new Map<string, string[]>();
    for (const s of scopes()) for (const [term, w] of s.keywords) if (w === 3) owners.set(term, [...(owners.get(term) ?? []), s.name]);
    const shared = [...owners].filter(([, o]) => o.length > 1);
    expect(shared).toEqual([]);
  });

  it(`no pair shares enough keyword weight to co-activate on shared terms alone (< ${SELECTION_THRESHOLD})`, () => {
    const all = scopes();
    const collisions: string[] = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = new Map(all[i]!.keywords);
        const shared = all[j]!.keywords.filter(([t]) => a.has(t)).reduce((sum, [t, w]) => sum + Math.min(w, a.get(t)!), 0);
        if (shared >= SELECTION_THRESHOLD) collisions.push(`${all[i]!.name} × ${all[j]!.name} (${shared})`);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('docs/research/SPECIALISTS.md is the rendered roster table (no drift)', () => {
    expect(readFileSync(join(REPO_ROOT, 'docs', 'research', 'SPECIALISTS.md'), 'utf8')).toBe(renderSpecialistTable(scopes()));
  });
});

describe('Phase 17 acceptance question', () => {
  it('activates the five source-named specialists — and not all twenty', () => {
    const r = selectSpecialists('Research the best current method for controlling dark baritone vocals in Suno.', scopes());
    const names = r.selected.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(['suno-researcher', 'ai-vocal-systems-researcher', 'prompt-engineering-researcher', 'artist-identity-researcher', 'evaluation-researcher']),
    );
    expect(names.length).toBeLessThan(ROSTER.length);
    expect(names).toHaveLength(5);
  });
});
