import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractPdfPages } from './extract-pdf.ts';
import { normalizeBuildSequence, PHASE_DOMAINS } from './normalizers/build-sequence-normalize.ts';
import { parseBuildSequence } from './normalizers/build-sequence.ts';
import { selectNormalizer } from './normalizers/index.ts';

const PDF = join(import.meta.dirname, '..', '..', 'XYP3RN_Agentic_OS_Build_Sequence.pdf');
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

let pages: string[];
beforeAll(async () => {
  pages = await extractPdfPages(new Uint8Array(readFileSync(PDF)));
});

describe('build-sequence normalization (real PDF)', () => {
  it('is deterministic: same pages in, deep-equal entries out', () => {
    expect(normalizeBuildSequence(parseBuildSequence(pages))).toEqual(
      normalizeBuildSequence(parseBuildSequence(pages)),
    );
  });

  it('maps every phase 0..17 to exactly one domain (explicit table, no fallback)', () => {
    expect(Object.keys(PHASE_DOMAINS).map(Number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 18 }, (_, i) => i),
    );
  });

  it('emits 19 modules (18 phases + build protocol) and 31 prompts with unique kebab slugs', () => {
    const doc = normalizeBuildSequence(parseBuildSequence(pages));
    expect(doc.modules).toHaveLength(19);
    expect(doc.prompts).toHaveLength(31);
    const slugs = [...doc.modules.map((m) => m.slug), ...doc.prompts.map((p) => p.slug)];
    for (const s of slugs) expect(s).toMatch(KEBAB);
    expect(new Set(doc.modules.map((m) => m.slug)).size).toBe(19);
    expect(new Set(doc.prompts.map((p) => p.slug)).size).toBe(31);
  });

  it('assigns domains per the Phase 0 architecture', () => {
    const doc = normalizeBuildSequence(parseBuildSequence(pages));
    const domainOf = (slug: string) => doc.modules.find((m) => m.slug === slug)?.domain;
    expect(domainOf('phase-0-foundation-contracts')).toBe('CORE');
    expect(domainOf('phase-2-knowledge-ingestion-normalization')).toBe('KNOWLEDGE');
    expect(domainOf('phase-6-ai-music-research-intelligence')).toBe('RESEARCH_INTELLIGENCE');
    expect(domainOf('phase-9-suno-generation-system')).toBe('RECORDS');
    expect(domainOf('phase-14-xyp3rn-tech')).toBe('TECH');
    expect(domainOf('phase-15-legal-governance')).toBe('GOVERNANCE');
    expect(domainOf('build-protocol')).toBe('CORE');
  });

  it('keeps each prompt body verbatim and its sections structured', () => {
    const doc = normalizeBuildSequence(parseBuildSequence(pages));
    const p = doc.prompts.find((x) => x.slug === 'phase-4a-agent-runs-schema')!;
    expect(p.moduleSlug).toBe('phase-4-agent-runtime-registry');
    expect(p.body.startsWith('You are a Staff DB Engineer. PHASE 4A — agent_runs schema.')).toBe(true);
    expect(p.structured).toMatchObject({ key: '4A', phase: 4, task: expect.any(Array), constraints: expect.any(Array) });
    expect(p.tags).toEqual(expect.arrayContaining(['meta-prompt', 'phase-4', 'test-first']));
  });

  it('turns the voice reference into a checkable structured claim on the canonical row (6C)', () => {
    const doc = normalizeBuildSequence(parseBuildSequence(pages));
    const p8 = doc.prompts.find((x) => x.slug === 'phase-8-meta-prompt')!;
    expect(p8.structured.claims).toEqual([
      {
        topic: 'x3lius.voice-reference',
        value: ['modern brutalism', 'aggressive/confrontational', 'bilingual Bulgarian/English', 'dark melodic trap'],
        model_scope: 'model-agnostic',
      },
    ]);
    expect(doc.prompts.filter((x) => x.structured.claims !== undefined).map((x) => x.slug)).toEqual(['phase-8-meta-prompt']);
  });

  it('derives depends_on edges from "Depends on:" text (phase 2 -> phase 1)', () => {
    const doc = normalizeBuildSequence(parseBuildSequence(pages));
    expect(doc.relations).toContainEqual({
      subject: { type: 'module', slug: 'phase-2-knowledge-ingestion-normalization' },
      predicate: 'depends_on',
      object: { type: 'module', slug: 'phase-1-supabase-canonical-data-model' },
    });
  });

  it('reports coverage against the table of contents', () => {
    const doc = normalizeBuildSequence(parseBuildSequence(pages));
    expect(doc.coverage.expected).toHaveLength(21);
    expect(doc.coverage.present).toEqual(doc.coverage.expected);
  });

  it('selects the build-sequence normalizer for the PDF and none for unrelated text', () => {
    expect(selectNormalizer(pages)?.id).toBe('xyp-build-sequence-v2');
    expect(selectNormalizer(['meeting notes: nothing structured here'])).toBeUndefined();
  });
});
