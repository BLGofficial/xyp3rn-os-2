/**
 * Shared keyword scoring for the Phase 5 router and the Phase 6A specialist selector.
 * A term matches as a whole word (or phrase) with an optional plural "s", case-insensitive.
 */

export type Lexicon = ReadonlyArray<readonly [term: string, weight: number]>;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param term - word or phrase
 * @returns a regex matching it as a whole word with an optional trailing "s"
 */
export const termMatcher = (term: string): RegExp => new RegExp(`(?<![\\w])${escape(term)}s?(?![\\w])`, 'i');

/**
 * Scores text against a weighted lexicon.
 * @param text - request or question
 * @param lexicon - [term, weight] pairs
 * @returns total weight and the matched terms (sorted)
 */
export const scoreTerms = (text: string, lexicon: Lexicon): { score: number; matched: string[] } => {
  const hits = lexicon.filter(([term]) => termMatcher(term).test(text));
  return { score: hits.reduce((a, [, w]) => a + w, 0), matched: hits.map(([t]) => t).sort() };
};
