import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractPdfPages } from './extract-pdf.ts';
import { detectBuildSequence, parseBuildSequence, type ParsedBuildSequence } from './normalizers/build-sequence.ts';

// Runs against the real uploaded build guide — no fixture text.
const PDF = join(import.meta.dirname, '..', '..', 'XYP3RN_Agentic_OS_Build_Sequence.pdf');

let pages: string[];
let doc: ParsedBuildSequence;
beforeAll(async () => {
  pages = await extractPdfPages(new Uint8Array(readFileSync(PDF)));
  doc = parseBuildSequence(pages);
});

const allPrompts = () => doc.sections.flatMap((s) => s.prompts);
const prompt = (key: string) => allPrompts().find((p) => p.key === key)!;

describe('build-sequence parser (real PDF)', () => {
  it('detects the document and reads its header', () => {
    expect(pages).toHaveLength(22);
    expect(detectBuildSequence(pages)).toBe(true);
    expect(doc.title).toBe('XYP3RN AGENTIC OS');
    expect(doc.subtitle).toMatch(/^Build Sequence — Meta-Prompt Library/);
    expect(doc.documentDate).toBe('2026-09-01');
  });

  it('reads all 21 table-of-contents entries', () => {
    expect(doc.toc).toHaveLength(21);
    expect(doc.toc[0]).toBe('How to use this');
    expect(doc.toc[1]).toBe('PHASE 0 — Foundation / Contracts');
    expect(doc.toc[20]).toBe('Appendix B — Phase Map (quick reference)');
  });

  it('finds phases 0..17 exactly once, in order, plus the build protocol', () => {
    const phases = doc.sections.filter((s) => s.kind === 'phase').map((s) => s.phase);
    expect(phases).toEqual(Array.from({ length: 18 }, (_, i) => i));
    expect(doc.sections.filter((s) => s.kind === 'protocol')).toHaveLength(1);
  });

  it('splits sub-prompted phases into 4A-4E, 6A-6D, 16A-16D', () => {
    expect(allPrompts().map((p) => p.key)).toEqual([
      ...['0', '1', '2', '3', '4A', '4B', '4C', '4D', '4E', '5', '6A', '6B', '6C', '6D'],
      ...['7', '8', '9', '10', '11', '12', '13', '14', '15', '16A', '16B', '16C', '16D', '17'],
      ...['how-to-use-this', 'appendix-a', 'appendix-b'],
    ]);
  });

  it('gives every phase prompt a role, a task and an output', () => {
    for (const p of allPrompts().filter((x) => /^\d/.test(x.key))) {
      expect(p.role, p.key).toMatch(/^You are /);
      expect(p.task.length, p.key).toBeGreaterThan(0);
      expect(p.output, p.key).toBeTruthy();
    }
  });

  it('parses numbered task items and dash constraints', () => {
    const p4a = prompt('4A');
    expect(p4a.title).toBe('agent_runs Schema');
    expect(p4a.task).toHaveLength(3);
    expect(p4a.task[0]).toMatch(/^Migration: agent_runs\(id, agent_name/);
    expect(p4a.constraints.some((c) => c.startsWith('Test-first'))).toBe(true);
  });

  it('keeps sub-prompt deliverables (6A) but leaves phase deliverables on the phase', () => {
    expect(prompt('6A').deliverables).toBe(
      'the 11 research_* tables, agent_runs ALTER, Research Orchestrator agent.',
    );
    expect(prompt('0').deliverables).toBeUndefined();
    expect(prompt('17').deliverables).toBeUndefined();
  });

  it('keeps inline header text without its separator (phase 0 CONTEXT — …)', () => {
    expect(prompt('0').context).toMatch(/^target architecture, do not deviate/);
  });

  it('extracts the 6B specialist roster from its two-column table', () => {
    const roster = prompt('6B').roster!;
    expect(roster.map((r) => r.n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(roster[0]!.name).toBe('Suno Researcher');
    expect(roster[10]!.name).toBe('Lyrics & Rhyme Systems Researcher');
    expect(roster[19]!.name).toBe('Frontier/Emerging-Tool Scanner Researcher');
  });

  it('rejoins hyphenated line wraps in prose and keeps real phase metadata', () => {
    const p0 = doc.sections.find((s) => s.phase === 0)!;
    expect(p0.goal).toBe(
      'lock the six-domain architecture and the eight agent-class contracts before any code exists.',
    );
    expect(p0.dependsOn).toBe('nothing.');
    expect(p0.deliverables).toMatch(/^\/docs\/ARCHITECTURE\.md, \/docs\/AGENT_CLASSES\.md/);
  });

  it('records the real gap: phase 6 has an intro but no Goal line', () => {
    const p6 = doc.sections.find((s) => s.phase === 6)!;
    expect(p6.goal).toBeUndefined();
    expect(p6.intro).toMatch(/core of the source architecture/);
  });

  it('strips page-number footers from every body', () => {
    for (const p of allPrompts()) {
      expect(p.body.split('\n').filter((l) => /^\d+$/.test(l.trim())), p.key).toEqual([]);
    }
  });

  it('extracts the Phase 8 voice reference as structured data (real source text)', () => {
    expect(prompt('8').voiceReference).toEqual({
      artist: 'X3LIUS',
      descriptors: ['modern brutalism', 'aggressive/confrontational', 'bilingual Bulgarian/English', 'dark melodic trap'],
    });
    expect(prompt('9').voiceReference).toBeUndefined();
  });

  it('does not detect an unrelated document', () => {
    expect(detectBuildSequence(['Some other PDF\nNothing to see'])).toBe(false);
  });
});
