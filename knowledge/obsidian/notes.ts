import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { sha256Hex } from '../source-registry/acquire.ts';
import { LANGUAGE } from '../source-registry/vault-tools.ts';

/**
 * The owner's Obsidian vault as files (F54): where it is, which notes it holds, and what each note
 * declares (frontmatter, tags, wikilinks). Pure reads; nothing here writes to the vault.
 */

/** The only folder the OS writes into, so its notes never mix with the owner's. */
export const EXPORT_DIR = 'XYP3RN OS';
/** A note above this is listed as skipped, never read into memory whole. */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;

/**
 * The vault root from the configured path. Obsidian keeps its settings in `<vault>/.obsidian`, and
 * that folder is easy to copy by mistake; the vault is its parent. Works on Windows and POSIX
 * strings alike, whatever the host, because the path comes from the owner's machine.
 * @param given - XYP_OBSIDIAN_VAULT as written
 * @returns the root, and whether it was moved up from `.obsidian`
 * @throws on an empty path
 */
export const resolveVaultRoot = (given: string): { readonly root: string; readonly adjusted: boolean } => {
  const trimmed = given.trim().replace(/[\\/]+$/, '');
  if (trimmed === '') throw new Error('XYP_OBSIDIAN_VAULT is empty');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut > 0 && trimmed.slice(cut + 1) === '.obsidian') return { root: trimmed.slice(0, cut), adjusted: true };
  return { root: trimmed, adjusted: false };
};

/** What one note declares. */
export type ParsedNote = {
  readonly title: string | null;
  readonly language: string | null;
  readonly tags: readonly string[];
  readonly wikilinks: readonly string[];
  /** Set on notes the OS exported (frontmatter `xyp3rn_id`, `xyp3rn_kind`). */
  readonly exported: { readonly id: string; readonly kind: string } | null;
  /** The YAML error when the frontmatter does not parse; the body is still read. */
  readonly frontmatterError: string | null;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
// Obsidian's rules: a wikilink target stops at `|` (alias) or `#` (heading); an embed is `![[…]]`.
const WIKILINK = /!?\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g;
// A tag is `#` after whitespace or line start, then letters (any script), digits, `_`, `-`, `/`.
const INLINE_TAG = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const tagList = (v: unknown): string[] => {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
  return raw.filter((t): t is string => typeof t === 'string').map((t) => t.trim().replace(/^#/, '')).filter((t) => t !== '');
};

/**
 * Parses a note. Code blocks hold neither tags nor links, as in Obsidian. A number-only `#123` is not a tag.
 * @param md - the note's text
 * @returns title, language, sorted unique tags and wikilink targets, the export marker
 */
export const parseNote = (md: string): ParsedNote => {
  const m = FRONTMATTER.exec(md);
  let fm: Record<string, unknown> = {};
  let frontmatterError: string | null = null;
  if (m) {
    try {
      const parsed: unknown = parseYaml(m[1]!);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
    } catch (e) {
      frontmatterError = (e as Error).message.split('\n')[0]!;
    }
  }
  const body = (m ? md.slice(m[0].length) : md).replace(CODE, ' ');
  const inline = [...body.matchAll(INLINE_TAG)].map((x) => x[1]!).filter((t) => !/^\d+$/.test(t));
  const lang = str(fm.lang) ?? str(fm.language);
  const id = str(fm.xyp3rn_id);
  const kind = str(fm.xyp3rn_kind);
  return {
    title: str(fm.title),
    language: lang !== null && LANGUAGE.test(lang) ? lang : null,
    tags: [...new Set([...tagList(fm.tags), ...inline])].sort(),
    wikilinks: [...new Set([...body.matchAll(WIKILINK)].map((x) => x[1]!.trim()).filter((t) => t !== ''))].sort(),
    exported: id && kind ? { id, kind } : null,
    frontmatterError,
  };
};

/** The vault's wikilink graph: counts, the most linked-to notes, and links to nothing. */
export type LinkGraph = {
  readonly notes: number;
  /** Distinct resolved note-to-note links (an embed of a non-note is not counted). */
  readonly links: number;
  readonly unresolved: readonly { readonly from: string; readonly target: string }[];
  readonly top: readonly { readonly rel: string; readonly backlinks: number }[];
};

/**
 * Resolves each note's wikilinks as Obsidian does: a path without `.md` (`[[Songs/Hook]]`), else a note
 * name anywhere in the vault (`[[Hook]]`), case-insensitively; a name two notes share goes to the
 * shortest path. A target with a file extension other than `.md` is an attachment, not a note.
 * @param notes - each note's path and text
 * @param top - how many most-linked notes to return
 * @returns the graph summary
 */
export const linkGraph = (notes: readonly { readonly rel: string; readonly text: string }[], top = 8): LinkGraph => {
  const byPath = new Map(notes.map((n) => [n.rel.slice(0, -3).toLowerCase(), n.rel]));
  const byName = new Map<string, string>();
  for (const n of [...notes].sort((a, b) => a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : 1))) {
    const name = n.rel.split('/').pop()!.slice(0, -3).toLowerCase();
    if (!byName.has(name)) byName.set(name, n.rel);
  }
  const edges = new Set<string>();
  const back = new Map<string, number>();
  const unresolved: { from: string; target: string }[] = [];
  for (const n of notes) {
    for (const target of parseNote(n.text).wikilinks) {
      const key = target.replace(/\.md$/i, '').toLowerCase();
      if (/\.[a-z0-9]{2,5}$/i.test(target) && !/\.md$/i.test(target)) continue;
      const to = byPath.get(key) ?? byName.get(key.split('/').pop()!);
      if (!to) {
        unresolved.push({ from: n.rel, target });
        continue;
      }
      if (to === n.rel || edges.has(`${n.rel}\u0000${to}`)) continue;
      edges.add(`${n.rel}\u0000${to}`);
      back.set(to, (back.get(to) ?? 0) + 1);
    }
  }
  return {
    notes: notes.length,
    links: edges.size,
    unresolved,
    top: [...back].map(([rel, backlinks]) => ({ rel, backlinks })).sort((a, b) => b.backlinks - a.backlinks || (a.rel < b.rel ? -1 : 1)).slice(0, top),
  };
};

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * The vault path of an exported record. Windows refuses `<>:"/\|?*`, control characters, trailing
 * dots and spaces, and device names; the id suffix keeps two records with one title apart.
 * @param kind - Song or Finding
 * @param title - the record's title
 * @param id - the record's uuid
 * @returns a posix path under EXPORT_DIR
 */
export const exportFileName = (kind: 'Song' | 'Finding', title: string, id: string): string => {
  let name = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80).trim();
  if (name === '') name = 'untitled';
  if (RESERVED.test(name)) name = `${name}_`;
  return `${EXPORT_DIR}/${kind}s/${name} (${id.slice(0, 8)}).md`;
};

/** A Markdown note on disk. */
export type NoteFile = { readonly rel: string; readonly abs: string; readonly sha256: string; readonly size: number };

/**
 * Walks the vault for `.md` notes. Dot folders (`.obsidian`, `.trash`, `.git`) are not notes. Symbolic
 * links and junctions are never followed: one could point outside the vault, and the sync must
 * only read and write inside it.
 * @param root - the vault root
 * @returns notes (posix paths, sorted) and notes skipped for size
 * @throws when the root is not a readable folder
 */
export const scanVault = async (root: string): Promise<{ readonly notes: readonly NoteFile[]; readonly skipped: readonly string[] }> => {
  try {
    if (!(await stat(root)).isDirectory()) throw new Error('not a folder');
  } catch (e) {
    throw new Error(`Obsidian vault not readable at ${root}: ${(e as Error).message}`);
  }
  const notes: NoteFile[] = [];
  const skipped: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries: Dirent[] = await readdir(dir, { withFileTypes: true });
    for (const d of entries) {
      if (d.name.startsWith('.') || d.isSymbolicLink()) continue;
      const abs = join(dir, d.name);
      const r = rel === '' ? d.name : `${rel}/${d.name}`;
      if (d.isDirectory()) await walk(abs, r);
      else if (d.isFile() && d.name.toLowerCase().endsWith('.md')) {
        const size = (await stat(abs)).size;
        if (size > MAX_NOTE_BYTES) skipped.push(r);
        else notes.push({ rel: r, abs, sha256: sha256Hex(new Uint8Array(await readFile(abs))), size });
      }
    }
  };
  await walk(root, '');
  notes.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { notes, skipped: skipped.sort() };
};

/**
 * @param root - the vault root
 * @returns the vault's Markdown notes (see scanVault)
 */
export const listNotes = async (root: string): Promise<readonly NoteFile[]> => (await scanVault(root)).notes;
