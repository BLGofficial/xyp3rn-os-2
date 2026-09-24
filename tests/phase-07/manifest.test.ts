import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { selectNormalizer } from '../../knowledge/ingestion/normalizers/index.ts';
import { detectModuleManifest, MODULE_MANIFEST_NORMALIZER_ID, normalizeModuleManifest } from '../../knowledge/ingestion/normalizers/module-manifest.ts';
import { loadMusicSystem, MUSIC_SYSTEM_MANIFEST } from '../../records/x3lius/music-system.ts';

// Phase 7: the X3LIUS module and its ten sub-domains are operator-authored first-party data
// (records/x3lius/music-system.manifest.yaml), admitted into canonical knowledge by the gate.

const text = readFileSync(MUSIC_SYSTEM_MANIFEST, 'utf8');
/** The guide's list, verbatim order (Phase 7, task 1). */
const GUIDE_SUBDOMAINS = ['Songwriting', 'Lyrics', 'Vocal DNA', 'Composition', 'Arrangement', 'Genre/Style', 'Suno', 'Production', 'Mix/Master', 'Evaluation'];

describe('module manifest normalizer', () => {
  it('is selected for a module manifest and only for one', () => {
    expect(selectNormalizer([text])?.id).toBe(MODULE_MANIFEST_NORMALIZER_ID);
    expect(MODULE_MANIFEST_NORMALIZER_ID).toBe('xyp-module-manifest-v1');
    expect(detectModuleManifest(['manifest: something-else/v1\ntitle: x'])).toBe(false);
    expect(detectModuleManifest([text, 'a second page'])).toBe(false);
  });

  it("yields the parent + the guide's ten sub-domains under RECORDS, each subdomain_of the parent", () => {
    const doc = normalizeModuleManifest([text]);
    expect(doc.modules.map((m) => m.title)).toEqual(['X3LIUS Music System', ...GUIDE_SUBDOMAINS]);
    expect(new Set(doc.modules.map((m) => m.domain))).toEqual(new Set(['RECORDS']));
    expect(doc.prompts).toEqual([]); // registered-but-empty stubs: no content yet
    expect(doc.relations.filter((r) => r.predicate === 'subdomain_of')).toEqual(
      doc.modules.slice(1).map((m) => ({ subject: { type: 'module', slug: m.slug }, predicate: 'subdomain_of', object: { type: 'module', slug: 'x3lius-music-system' } })),
    );
    expect(doc.relations.filter((r) => r.predicate === 'derived_from')).toHaveLength(11);
    expect(doc).toMatchObject({ normalizer: 'xyp-module-manifest-v1', documentDate: '2026-09-24' });
    expect(doc.coverage.present).toEqual(doc.coverage.expected);
  });

  it('states in each stub description which phase builds it (or that none does yet)', () => {
    const doc = normalizeModuleManifest([text]);
    const by = Object.fromEntries(doc.modules.map((m) => [m.slug, m.description]));
    expect(by['x3lius-suno']).toMatch(/Stub until Phase 9\.$/);
    expect(by['x3lius-composition']).toMatch(/Stub: no build-guide phase implements it yet\.$/);
  });

  it('rejects a malformed manifest loudly (never half-normalized)', () => {
    expect(() => normalizeModuleManifest([text.replace('slug: x3lius-suno', 'slug: X3LIUS Suno')])).toThrow(/slug/);
    expect(() => normalizeModuleManifest([text.replace('domain: RECORDS', 'domain: MUSIC')])).toThrow(/domain/);
    expect(() => normalizeModuleManifest([text.replace('slug: x3lius-lyrics', 'slug: x3lius-songwriting')])).toThrow(/duplicate/);
    expect(() => normalizeModuleManifest([text.replace("built_in: '9'", "built_in: 'nine'")])).toThrow(/built_in/);
  });

  it('loadMusicSystem exposes the same sub-domains the runtime routes to', () => {
    const sys = loadMusicSystem();
    expect(sys.parent.slug).toBe('x3lius-music-system');
    expect(sys.subdomains.map((s) => s.title)).toEqual(GUIDE_SUBDOMAINS);
    expect(sys.subdomains.find((s) => s.slug === 'x3lius-suno')).toMatchObject({ builtIn: '9' });
  });
});
