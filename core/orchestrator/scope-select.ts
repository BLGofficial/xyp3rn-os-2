import { scoreTerms, type Lexicon } from './keyword-match.ts';

/**
 * Scope-keyword selection (Phase 6A for research specialists; reused by the Phase 7 X3LIUS
 * sub-domains). An agent's `## Scope` section states its scope in ONE sentence plus weighted
 * keywords. A request activates only the agents whose keywords score at or above the threshold —
 * never all of them, and never a default set when nothing matches.
 */

export type AgentScope = { readonly name: string; readonly sentence: string; readonly keywords: Lexicon };

/** 3 = one defining term (weight 3) or two supporting ones: enough to justify a specialist run. */
export const SCOPE_THRESHOLD = 3;

const KEYWORD = /^(.+?)\s*\((\d+)\)$/;

/**
 * Parses a `## Scope` section: one sentence, a blank line, then `Keywords: term (w), term (w)`.
 * @param name - agent name
 * @param section - text under `## Scope`
 * @returns the scope
 * @throws Error if the sentence isn't exactly one sentence or keywords are malformed/missing
 */
export const parseScope = (name: string, section: string): AgentScope => {
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
 * Scores a request against every agent scope.
 * @param question - request or research question
 * @param scopes - the candidate agents
 * @returns selected (score >= threshold) and not selected, each sorted by score desc then name
 */
export const selectByScope = (question: string, scopes: readonly AgentScope[]): Selection => {
  const scored = scopes
    .map((s) => ({ name: s.name, ...scoreTerms(question, s.keywords) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return {
    selected: scored.filter((s) => s.score >= SCOPE_THRESHOLD),
    notSelected: scored.filter((s) => s.score < SCOPE_THRESHOLD),
    threshold: SCOPE_THRESHOLD,
  };
};
