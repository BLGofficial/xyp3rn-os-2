import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stringify as toYaml } from 'yaml';
import type { Sql } from '../../core/db/client.ts';
import { asRole } from '../source-registry/vault-tools.ts';
import { parseObsidianNote } from './parser.ts';

/**
 * Writes approved lyric versions back to the owner's vault as read-only notes in `canonical/lyrics/`.
 * Only versions the owner approved (artifact_approvals.status = 'approved') are read, and an approved
 * version never changes (creative_artifacts is insert-only), so a note is written once and then left alone.
 * The watcher never listens to `canonical/`, so an export cannot loop back into staging.
 */

const READ_ROLE = 'xyp_web';
export const LYRICS_SCHEMAS = ['x3lius.lyrics/v2', 'x3lius.lyrics/v1'];
export const LYRICS_DIR = 'canonical/lyrics';
/** Wikilink targets. The notes behind them are the owner's; until they exist the links dangle. */
export const VOCAL_DNA_NOTE = 'X3LIUS Vocal DNA';
export const genreRecipeNote = (genre: string): string => `Genre Recipe - ${genre}`;

export type CanonicalLyricRecord = {
  readonly artifactId: string;
  readonly lineageId: string;
  readonly version: number;
  readonly title: string;
  readonly artist: string | null;
  readonly genre: string | null;
  readonly language: string | null;
  readonly sections: readonly { readonly label: string; readonly bars: readonly { readonly n: number; readonly text: string }[] }[];
  /** SHA-256 (hex) of the approved artifact's stored body: the note's provenance. */
  readonly sourceSha256: string;
};

export type ExportResult = { readonly path: string; readonly result: 'written' | 'unchanged' };

/** A filesystem-safe name from a title: letters (any script) and digits, hyphen-joined. */
export const slugTitle = (title: string): string =>
  title.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';

/** @returns the note's text: complete frontmatter, then one `## LABEL` section per lyric section. */
export const renderLyricNote = (r: CanonicalLyricRecord): string => {
  const fm = toYaml({
    type: 'lyrics',
    domain: 'canonical',
    tags: ['xyp3rn', 'lyrics', 'canonical'],
    author: r.artist ?? 'X3LIUS',
    status: 'canonical',
    source_sha256: r.sourceSha256,
    schema_id: LYRICS_SCHEMAS[0],
    artifact_id: r.artifactId,
    lineage_id: r.lineageId,
    version: r.version,
    title: r.title,
    ...(r.language ? { language: r.language } : {}),
    ...(r.genre ? { genre: r.genre } : {}),
  }, { lineWidth: 0 }).trimEnd();
  const profiles = [`Vocal DNA: [[${VOCAL_DNA_NOTE}]]`, ...(r.genre ? [`Genre: [[${genreRecipeNote(r.genre)}]]`] : [])].join(' · ');
  const sections = r.sections.map((s) => `## ${s.label.toUpperCase()}\n\n${s.bars.map((b) => b.text).join('\n')}`).join('\n\n');
  return `---\n${fm}\n---\n\n# ${r.title}\n\n> ${profiles}\n> Canonical and read-only: exported by XYP3RN OS. Revise the lyrics in the OS, not here.\n\n${sections}\n`;
};

export class ObsidianExporterService {
  readonly #root: string;

  /** @param vaultRoot - the vault folder (contains canonical/lyrics/) */
  constructor(vaultRoot: string) {
    this.#root = resolve(vaultRoot);
  }

  /**
   * Writes one approved lyric as `canonical/lyrics/<song_title>_<version>.md`, mode 0444.
   * Idempotent: an existing note with the same `source_sha256` is left untouched.
   * @throws when a note exists at the path with a different source (same title and version, other lineage)
   */
  async exportApprovedLyric(record: CanonicalLyricRecord): Promise<ExportResult> {
    const dir = join(this.#root, LYRICS_DIR);
    const path = join(dir, `${slugTitle(record.title)}_${record.version}.md`);
    const text = renderLyricNote(record);
    try {
      const existing = parseObsidianNote(await readFile(path, 'utf8')).frontmatter.source_sha256;
      if (existing === record.sourceSha256) return { path, result: 'unchanged' };
      throw new Error(`${path} exists with a different source (${String(existing)}); refusing to overwrite a canonical note`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await mkdir(dir, { recursive: true });
    await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
    // Security invariant: read-only on disk so a stray local edit cannot overwrite canonical text.
    await chmod(path, 0o444);
    return { path, result: 'written' };
  }

  /** Exports every approved lyric version in the database; returns one result per version. */
  async exportAllApproved(sql: Sql): Promise<readonly ExportResult[]> {
    const out: ExportResult[] = [];
    for (const record of await loadApprovedLyrics(sql)) out.push(await this.exportApprovedLyric(record));
    return out;
  }
}

type Row = {
  id: string; lineage_id: string; version: number; brief: string; body: { sections?: { label?: string; bars?: { n: number; text: string }[] }[] };
  title: string | null; artist: string | null; genre: string | null;
};

/** Every owner-approved lyric version, with its linked song's title, artist and genre when it has one. */
export const loadApprovedLyrics = (sql: Sql): Promise<readonly CanonicalLyricRecord[]> =>
  asRole(sql, READ_ROLE, async (tx) => {
    const rows = await tx<Row[]>`
      select a.id, a.lineage_id, a.version, a.brief, a.body, s.title, s.artist, s.genre
      from creative_artifacts a
      join artifact_approvals ap on ap.id = a.id and ap.status = 'approved'
      left join lateral (
        select cs.title, cs.artist, cs.genre
        from current_song_links l join current_songs cs on cs.id = l.song_id
        where l.artifact_lineage_id = a.lineage_id
        order by cs.id limit 1) s on true
      where a.schema_id = any(${LYRICS_SCHEMAS}::text[])
      order by a.lineage_id, a.version`;
    return rows.map((r) => ({
      artifactId: r.id,
      lineageId: r.lineage_id,
      version: r.version,
      title: r.title ?? (r.brief.split('\n')[0]!.slice(0, 60).trim() || 'Untitled'),
      artist: r.artist,
      genre: r.genre,
      language: (r.body.sections?.[0]?.bars?.[0] as { language?: string } | undefined)?.language ?? null,
      sections: (r.body.sections ?? []).map((s) => ({ label: s.label ?? 'Section', bars: s.bars ?? [] })),
      // jsonb comes back key-ordered by Postgres, so this hash is stable for a stored version.
      sourceSha256: createHash('sha256').update(JSON.stringify(r.body), 'utf8').digest('hex'),
    }));
  }, 'read only');
