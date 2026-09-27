import { posix } from 'node:path';
import ts from 'typescript-api';

/**
 * References between repository files (AOS-04 Plan C1 Task 3, design §15.3): static, dynamic and type-level
 * imports, and explicit Markdown links. A bare mention of a filename in prose is never a reference.
 */

export type Ref = { readonly specifier: string; readonly line: number };
export type Resolved = string | { readonly unresolved: string } | null;

const lineAt = (text: string, pos: number): number => {
  let line = 1;
  for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

/**
 * Every import a TS/JS file makes (TypeScript's own pre-processor: `.tsx` included; strings and comments skipped;
 * `typeof import('…')` counted; a non-literal `import(expr)` names no file and is not listed).
 * @param source - the file's text
 * @returns each specifier with the line it's on, in file order
 */
export const importsOf = (source: string): Ref[] =>
  ts.preProcessFile(source, true, true).importedFiles
    .filter((f) => wholeLiteral(source, f.pos, f.fileName.length))
    .map((f) => ({ specifier: f.fileName, line: lineAt(source, f.pos) }));

// The pre-processor also reports the leading literal of `import('./' + name)`; a call's argument names a file
// only when the literal is the whole argument (the next token closes the call or starts import attributes).
// `pos` is the opening quote; the closing one sits `length + 1` after it.
const wholeLiteral = (src: string, pos: number, length: number): boolean => {
  let before = pos - 1;
  while (before >= 0 && /\s/.test(src[before]!)) before--;
  if (src[before] !== '(') return true;
  let after = pos + length + 2;
  while (after < src.length && /\s/.test(src[after]!)) after++;
  return src[after] === ')' || src[after] === ',';
};

const inside = (p: string) => p !== '..' && !p.startsWith('../') && !posix.isAbsolute(p);

/**
 * Resolves a relative import against the repository's files, as Node (explicit extension) and Next (extensionless,
 * `index`) do; a `.js` specifier may name its `.ts` source.
 * @param fromRel - the importing file, root-relative
 * @param specifier - as written
 * @param files - every indexed path in the root
 * @returns the target path; `{ unresolved }` when it names no indexed file; null for built-ins and packages
 */
export const resolveImport = (fromRel: string, specifier: string, files: ReadonlySet<string>): Resolved => {
  if (!specifier.startsWith('.')) return specifier.startsWith('/') ? { unresolved: 'absolute specifier' } : null;
  const base = posix.normalize(posix.join(posix.dirname(fromRel), specifier));
  if (!inside(base)) return { unresolved: 'outside the root' };
  const js = /\.(m|c)?jsx?$/.test(base) ? base.replace(/\.(m|c)?jsx?$/, '') : null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`, ...(js ? [`${js}.ts`, `${js}.tsx`] : [])];
  return candidates.find((c) => files.has(c)) ?? { unresolved: 'no such file' };
};

// Fenced blocks and inline code spans are not prose: their brackets are not links. Replaced by spaces of the
// same length so every offset (and so every line number) stays where it was.
const blankCode = (md: string): string =>
  md
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Explicit Markdown links (`[text](target)`, `![alt](target)`, `[ref]: target`) outside code, to local targets.
 * @param md - the Markdown text
 * @returns each target as written (anchor kept) with its line; web, mail and same-page anchor links left out
 */
export const markdownLinksOf = (md: string): { target: string; line: number }[] => {
  const text = blankCode(md);
  const out: { target: string; line: number; pos: number }[] = [];
  for (const m of text.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ target: m[1]!, line: lineAt(text, m.index), pos: m.index });
  for (const m of text.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm)) out.push({ target: m[1]!, line: lineAt(text, m.index), pos: m.index });
  return out
    .filter((l) => !SCHEME.test(l.target) && !l.target.startsWith('#'))
    .sort((a, b) => a.pos - b.pos)
    .map(({ target, line }) => ({ target, line }));
};

/**
 * Resolves a Markdown link target. A leading `/` is the root (as on GitHub); the anchor and query are dropped.
 * @param fromRel - the linking file, root-relative
 * @param target - as written
 * @param files - every indexed path in the root
 * @returns the target file; null for a directory (not a node); `{ unresolved }` for a dead link
 */
export const resolveLink = (fromRel: string, target: string, files: ReadonlySet<string>): Resolved => {
  let path = target.split('#')[0]!.split('?')[0]!;
  try {
    path = decodeURI(path);
  } catch {
    return { unresolved: 'malformed link' };
  }
  const base = posix.normalize(path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(fromRel), path)).replace(/\/$/, '');
  if (!inside(base)) return { unresolved: 'outside the root' };
  if (files.has(base)) return base;
  for (const f of files) if (f.startsWith(`${base}/`)) return null;
  return { unresolved: 'no such file' };
};
