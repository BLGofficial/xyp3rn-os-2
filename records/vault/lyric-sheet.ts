import { sectionLabels } from '../x3lius/creative/lyrics.ts';

/**
 * Lyric sheets → x3lius.lyrics/v2 sections (AOS-01). The owner writes lyrics as plain text, the
 * way Suno reads them: `[Verse 1]`, `[Chorus]`… tags, one sung line per row. The words are kept
 * exactly; only the structure is read.
 */

export type SheetBar = { readonly n: number; readonly text: string; readonly language: string; readonly rhymeTag: string };
export type SheetSection = {
  readonly sectionId: string;
  readonly kind: string;
  readonly label: string;
  readonly bars: readonly SheetBar[];
  readonly rhymeScheme: string;
  readonly devices: readonly never[];
  readonly directions: readonly string[];
};
export type ParsedSheet = {
  /** Sung sections in song order, shaped as v2 `sections`. */
  readonly sections: readonly SheetSection[];
  /** Ids of tagged sections with no sung line: v2 lists them by id only (the Suno renderer skips them). */
  readonly instrumental: readonly string[];
  /** Sheet text the v2 shape cannot hold; the sheet itself (a Vault file) keeps it. */
  readonly warnings: readonly string[];
};

// Tag text → the existing SECTION_KIND enum (records/x3lius/creative/schemas.ts).
const KINDS: Readonly<Record<string, string>> = {
  intro: 'intro', verse: 'verse', 'pre chorus': 'pre-chorus', prechorus: 'pre-chorus', chorus: 'chorus',
  'post chorus': 'post-chorus', postchorus: 'post-chorus', hook: 'hook', bridge: 'bridge', breakdown: 'breakdown',
  break: 'breakdown', outro: 'outro',
};

/** "[Verse 2: whispered]" → { kind: 'verse', note: 'whispered' }; an unknown tag → null (a direction). */
const sectionTag = (inner: string): { readonly kind: string; readonly note: string } | null => {
  const [head = '', ...rest] = inner.split(':');
  const key = head.toLowerCase().replace(/[\s_-]+/g, ' ').replace(/\s*\d+$/, '').trim();
  const kind = KINDS[key];
  return kind ? { kind, note: rest.join(':').trim() } : null;
};

type Draft = { kind: string; lines: string[]; directions: string[] };

/**
 * Reads a lyric sheet. With section tags, every tag opens a section, lines before the first tag
 * are a verse, and any other bracketed line is a direction (never sung, F21) for the section it
 * sits in, or the next one when none is open yet. Without tags, stanzas separated by blank lines
 * are verses. A tagged section with no sung line is instrumental.
 * @param text - the sheet (LF or CRLF)
 * @param language - every bar's language (ISO 639-1, `mixed` or `und`): the sheet's, not guessed per line
 * @returns v2 sections, instrumental ids, and what the v2 shape could not keep
 * @throws when the sheet has no sung line
 */
export const parseLyricSheet = (text: string, language: string): ParsedSheet => {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const bracket = (l: string) => /^\[(.+)\]$/.exec(l)?.[1]?.trim() ?? null;
  const tagged = lines.some((l) => { const b = bracket(l); return b !== null && sectionTag(b) !== null; });

  const drafts: Draft[] = [];
  let pending: string[] = [];
  let gap = false;
  const current = () => drafts.at(-1);
  // Untagged: a blank line after sung lines ends the stanza, so what follows belongs to the next one.
  const stanzaEnded = () => !tagged && gap && (current()?.lines.length ?? 0) > 0;
  const open = (kind: string, directions: readonly string[] = []) => {
    drafts.push({ kind, lines: [], directions: [...pending, ...directions] });
    pending = [];
  };

  for (const line of lines) {
    if (line === '') {
      gap = true;
      continue;
    }
    const inner = bracket(line);
    const tag = inner === null ? null : sectionTag(inner);
    if (tag) {
      open(tag.kind, tag.note ? [tag.note] : []);
    } else if (inner !== null) {
      if (current() === undefined || stanzaEnded()) pending.push(inner);
      else current()!.directions.push(inner);
    } else {
      if (current() === undefined || stanzaEnded()) open('verse');
      current()!.lines.push(line);
    }
    gap = false;
  }
  if (pending.length > 0 && current()) current()!.directions.push(...pending);
  if (!drafts.some((d) => d.lines.length > 0)) throw new Error('lyric sheet: no lyrics (not one sung line)');

  const ids = drafts.map((_, i) => `s${i + 1}`);
  const sung = drafts.map((d, i) => ({ d, id: ids[i]! })).filter(({ d }) => d.lines.length > 0);
  const labels = sectionLabels(sung.map(({ d }) => d.kind));
  const instrumental = drafts.map((d, i) => ({ d, id: ids[i]! })).filter(({ d }) => d.lines.length === 0);
  return {
    sections: sung.map(({ d, id }, i) => ({
      sectionId: id,
      kind: d.kind,
      label: labels[i]!,
      bars: d.lines.map((t, n) => ({ n: n + 1, text: t, language, rhymeTag: '' })),
      rhymeScheme: '',
      devices: [],
      directions: d.directions,
    })),
    instrumental: instrumental.map(({ id }) => id),
    warnings: instrumental
      .filter(({ d }) => d.directions.length > 0)
      .map(({ d, id }) => `${id} (${sectionLabels([d.kind])[0]}) has no sung lines, so it is instrumental; its directions ${d.directions.map((x) => `"${x}"`).join(', ')} stay only in the sheet`),
  };
};
