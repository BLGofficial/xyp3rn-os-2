import { scoreTerms, type Lexicon } from '../../core/orchestrator/keyword-match.ts';

/**
 * Research Orchestrator selection (Phase 6A; user decision: scope keywords). Each specialist's
 * `## Scope` section states its evidence-gathering scope in ONE sentence plus weighted keywords.
 * A question activates only the specialists whose keywords score at or above the threshold —
 * never all of them, and never a default set when nothing matches.
 */

export type SpecialistScope = { readonly name: string; readonly sentence: string; readonly keywords: Lexicon };

/** 3 = one defining term (weight 3) or two supporting ones: enough to justify a specialist run. */
export const SELECTION_THRESHOLD = 3;

const KEYWORD = /^(.+?)\s*\((\d+)\)$/;

/**
 * Parses a `## Scope` section: one sentence, a blank line, then `Keywords: term (w), term (w)`.
 * @param name - specialist agent name
 * @param section - text under `## Scope`
 * @returns the scope
 * @throws Error if the sentence isn't exactly one sentence or keywords are malformed/missing
 */
export const parseScope = (name: string, section: string): SpecialistScope => {
  const paragraphs = section.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const sentence = paragraphs[0] ?? '';
  const terminators = sentence.match(/[.!?](?=\s|$)/g) ?? [];
  if (terminators.length !== 1 || !/[.!?]$/.test(sentence)) throw new Error(`${name}: scope must be exactly one sentence`);
  const kw = paragraphs.find((p) => p.startsWith('Keywords:'));
  if (!kw) throw new Error(`${name}: scope must include a Keywords: line`);
  const keywords = kw
    .slice('Keywords:'.length)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      const m = KEYWORD.exec(k);
      if (!m) throw new Error(`${name}: each keyword must be "term (weight)", got "${k}"`);
      return [m[1]!.trim().toLowerCase(), Number(m[2])] as const;
    });
  return { name, sentence, keywords };
};

export type Scored = { readonly name: string; readonly score: number; readonly matched: readonly string[] };
export type Selection = { readonly selected: readonly Scored[]; readonly notSelected: readonly Scored[]; readonly threshold: number };

/**
 * Scores a question against every specialist scope.
 * @param question - research question
 * @param scopes - the roster
 * @returns selected (score >= threshold) and not selected, each sorted by score desc then name
 */
export const selectSpecialists = (question: string, scopes: readonly SpecialistScope[]): Selection => {
  const scored = scopes
    .map((s) => ({ name: s.name, ...scoreTerms(question, s.keywords) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return {
    selected: scored.filter((s) => s.score >= SELECTION_THRESHOLD),
    notSelected: scored.filter((s) => s.score < SELECTION_THRESHOLD),
    threshold: SELECTION_THRESHOLD,
  };
};

export type ResearchPlan = {
  readonly selection: Selection;
  readonly workflow: {
    readonly name: string;
    readonly description: string;
    readonly steps: ReadonlyArray<{ readonly id: string; readonly agent: string; readonly input: { readonly question: string } }>;
  };
};

/**
 * Turns a selection into a Workflow Engine spec: one independent step per selected specialist.
 * (Synthesis of their evidence into findings is added as a dependent step in 6C.)
 * @param question - research question
 * @param scopes - the roster
 * @returns selection evidence + workflow spec
 */
export const planResearch = (question: string, scopes: readonly SpecialistScope[]): ResearchPlan => {
  const selection = selectSpecialists(question, scopes);
  return {
    selection,
    workflow: {
      name: 'research-specialists',
      description: `Evidence gathering for: ${question}`,
      steps: selection.selected.map((s) => ({ id: s.name, agent: s.name, input: { question } })),
    },
  };
};
