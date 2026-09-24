/**
 * Homoglyph guard for creative artifacts. A word whose letters mix Latin and Cyrillic looks right
 * on screen but is unreadable to anyone downstream, Suno's vocal synthesis included (seen live,
 * 2026-09-24: "Пeak" = Cyrillic П + Latin "eak"). Switching script between words is untouched:
 * which languages a line uses is a canonical rule, not this check's business.
 */

// A word is a run of letters plus combining marks (a stress accent must not split a word). Digits,
// hyphens and apostrophes split words, so "X3LIUS" or "кой-то" never read as one mixed word.
const WORD = /[\p{L}\p{M}]+/gu;
const LATIN = /\p{Script=Latin}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;

export type MixedScriptWord = { readonly word: string; readonly path: string };

/**
 * Finds every word mixing Latin and Cyrillic letters in any string inside a JSON value.
 * @param value - an artifact body (or any JSON value)
 * @param path - JSON path of `value`, used as the prefix of each reported path
 * @returns each offending word with the path of the string it is in, in document order
 */
export const mixedScriptWords = (value: unknown, path = '$'): MixedScriptWord[] => {
  if (typeof value === 'string') {
    return (value.match(WORD) ?? []).filter((w) => LATIN.test(w) && CYRILLIC.test(w)).map((word) => ({ word, path }));
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => mixedScriptWords(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => mixedScriptWords(v, `${path}.${k}`));
  return [];
};
