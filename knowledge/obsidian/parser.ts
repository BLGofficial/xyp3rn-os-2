import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import type { ExtractedWikilink, ObsidianFrontmatter, ParsedObsidianNote } from './types.ts';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
// `[[target#heading|alias]]`, optionally prefixed `!` for an embed. Target stops at `#`, `|`, `]`.
const WIKILINK = /(!?)\[\[([^\]|#\n]+)(?:#([^\]|\n]*))?(?:\|([^\]\n]*))?\]\]/g;
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

const clean = (s: string | undefined): string | null => (s === undefined || s.trim() === '' ? null : s.trim());

const tagList = (v: unknown): string[] => {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
  return raw
    .filter((t): t is string | number => typeof t === 'string' || typeof t === 'number')
    .map((t) => String(t).trim().replace(/^#/, ''))
    .filter((t) => t !== '');
};

/** @returns every wikilink in `text`, in order, ignoring code spans and blocks. */
export const extractWikilinks = (text: string): ExtractedWikilink[] =>
  [...text.replace(CODE, ' ').matchAll(WIKILINK)].map((m) => ({
    target: m[2]!.trim(),
    heading: clean(m[3]),
    alias: clean(m[4]),
    embed: m[1] === '!',
    raw: m[0],
  }));

/** @returns SHA-256 hex of the whole string (UTF-8). */
export const sha256OfString = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex');

/**
 * Parses an Obsidian note: YAML frontmatter between `---` fences, wikilinks, and a hash of the raw text.
 * @param raw - the entire file contents
 */
export const parseObsidianNote = (raw: string): ParsedObsidianNote => {
  const m = FRONTMATTER.exec(raw);
  let data: Record<string, unknown> = {};
  let frontmatterError: string | null = null;
  if (m) {
    try {
      const doc = parseDocument(m[1]!, { logLevel: 'silent' });
      if (doc.errors.length > 0) {
        frontmatterError = doc.errors[0]!.message.split('\n')[0]!;
      } else {
        const parsed: unknown = doc.toJS();
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
      }
    } catch (e) {
      frontmatterError = (e as Error).message.split('\n')[0]!;
    }
  }
  const body = m ? raw.slice(m[0].length) : raw;
  const frontmatter: ObsidianFrontmatter = { ...data, tags: tagList(data.tags) };
  return { frontmatter, body, wikilinks: extractWikilinks(body), sha256: sha256OfString(raw), frontmatterError };
};
