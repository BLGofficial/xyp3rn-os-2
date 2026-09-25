export type DiffLine = { readonly op: ' ' | '-' | '+'; readonly line: string };

/**
 * Line diff by longest common subsequence: what a newer version of the lyrics removed and added.
 * O(n·m), which is fine for a song's few dozen lines.
 * @param a - the older version's lines
 * @param b - the newer version's lines
 * @returns every line once, marked kept (' '), removed ('-') or added ('+'), in reading order
 */
export const lineDiff = (a: readonly string[], b: readonly string[]): DiffLine[] => {
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: ' ', line: a[i]! });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // On a tie the removal comes first, so a changed line reads as "-old" then "+new".
      out.push({ op: '-', line: a[i++]! });
    } else {
      out.push({ op: '+', line: b[j++]! });
    }
  }
  return out;
};
