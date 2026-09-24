import type { SpecialistScope } from '../orchestrator/select.ts';

/**
 * Renders docs/research/SPECIALISTS.md from the specialists' own `## Scope` sections, so the
 * roster doc can never drift from the agent files (tests/phase-06b compares them byte for byte).
 */

/**
 * Pairs whose topics sit next to each other, with the line that separates them. Overlap is
 * checked mechanically (tests/phase-06b); these record the *semantic* split for reviewers.
 */
export const ADJACENT_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ['ai-vocal-systems-researcher', 'artist-identity-researcher', 'how models render vocals in general vs keeping one artist\'s signature consistent'],
  ['artist-identity-researcher', 'brand-persona-consistency-researcher', 'sonic identity vs non-sonic persona (visuals, narrative, public voice)'],
  ['evaluation-researcher', 'benchmark-scoring-methodology-researcher', 'human judgment protocols vs quantitative metrics and datasets'],
  ['model-version-changelog-researcher', 'frontier-tool-scanner-researcher', 'new versions of tools already in the stack vs tools not yet in it'],
  ['prompt-engineering-researcher', 'prompt-formula-template-researcher', 'individual steering techniques vs whole reusable templates'],
  ['songwriting-structure-researcher', 'lyrics-rhyme-systems-researcher', 'section structure and hook placement vs lyric content, rhyme and pronunciation'],
  ['suno-researcher', 'udio-alt-platform-researcher', 'Suno only vs every other generation platform'],
  ['genre-style-researcher', 'composition-arrangement-researcher', 'descriptor interpretation vs harmonic and instrumental content'],
];

const cell = (s: string) => s.replaceAll('|', '\\|');

/**
 * @param scopes - parsed `## Scope` sections of every Research specialist
 * @returns the full markdown document
 * @throws Error if an adjacent pair names a specialist that doesn't exist
 */
export const renderSpecialistTable = (scopes: readonly SpecialistScope[]): string => {
  const names = new Set(scopes.map((s) => s.name));
  for (const [a, b] of ADJACENT_PAIRS) for (const n of [a, b]) if (!names.has(n)) throw new Error(`adjacent pair names unknown specialist ${n}`);
  const sorted = [...scopes].sort((a, b) => a.name.localeCompare(b.name));
  const rows = sorted.map((s, i) => {
    const defining = s.keywords.filter(([, w]) => w === 3).map(([t]) => t).join(', ');
    const supporting = s.keywords.filter(([, w]) => w < 3).map(([t, w]) => `${t} (${w})`).join(', ');
    return `| ${i + 1} | \`${s.name}\` | ${cell(s.sentence)} | ${cell(defining)} | ${cell(supporting)} |`;
  });
  return [
    '# Research Specialists (Phase 6B)',
    '',
    'Generated from each specialist\'s `## Scope` section by `pnpm specialists:table`. Do not edit by hand: `tests/phase-06b` fails if this file drifts from the agent files.',
    '',
    `No-overlap rule, checked by test: a defining keyword (weight 3) belongs to exactly one specialist, and no pair shares enough keyword weight to reach the selection threshold on shared terms alone.`,
    '',
    '| # | Specialist | Scope (one sentence) | Defining keywords (weight 3) | Supporting keywords |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '## Adjacent pairs: where the line is',
    '',
    '| Specialist | Specialist | Split |',
    '|---|---|---|',
    ...ADJACENT_PAIRS.map(([a, b, why]) => `| \`${a}\` | \`${b}\` | ${cell(why)} |`),
    '',
  ].join('\n');
};
