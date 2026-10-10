import { readFile, stat } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { Sql } from '../../core/db/client.ts';
import { asRole } from '../source-registry/vault-tools.ts';
import { MAX_NOTE_BYTES } from './notes.ts';
import { parseObsidianNote } from './parser.ts';

/**
 * Ingests the owner's local Obsidian edits into the `obsidian_findings` staging table. Staging only: every
 * row is written 'pending_approval' as xyp_obsidian_watch, a role that can touch nothing else, so a note
 * reaches canonical knowledge only through the Promotion Gate.
 */

export const WATCH_ROLE = 'xyp_obsidian_watch';
/** Vault folders the watcher listens to; `canonical/` and `templates/` are never ingested. */
export const WATCHED_DIRS = ['inbox', 'research', 'creative'] as const;

export type StagedRow = {
  readonly domain: string;
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly rawContent: string;
  readonly metadata: Record<string, unknown>;
  readonly extractedLinks: readonly unknown[];
};

/**
 * Maps a note to its staging row. Domain is the frontmatter `domain`, else the top folder it sits in.
 * @param rel - vault-relative posix path
 * @param raw - the note's whole text
 */
export const toRow = (rel: string, raw: string): StagedRow => {
  const note = parseObsidianNote(raw);
  const fmDomain = note.frontmatter.domain;
  return {
    domain: typeof fmDomain === 'string' && fmDomain.trim() !== '' ? fmDomain.trim() : rel.split('/')[0]!,
    sourcePath: rel,
    contentHash: note.sha256,
    rawContent: raw,
    // JSON round-trip: YAML dates and the like become plain JSON.
    metadata: JSON.parse(JSON.stringify(note.frontmatter)) as Record<string, unknown>,
    extractedLinks: note.wikilinks,
  };
};

export type IngestResult = 'staged' | 'unchanged' | 'skipped';

export class ObsidianWatcherService {
  private watcher: FSWatcher | undefined;
  readonly #root: string;
  readonly #sql: Sql;
  readonly #log: (line: string) => void;

  /**
   * @param sql - pool allowed to SET ROLE xyp_obsidian_watch
   * @param vaultRoot - the vault folder (contains inbox/, research/, creative/)
   * @param log - one line per staged or failed note
   */
  constructor(sql: Sql, vaultRoot: string, log: (line: string) => void = (l) => console.log(l)) {
    this.#sql = sql;
    this.#root = resolve(vaultRoot);
    this.#log = log;
  }

  /** Starts watching; resolves once existing notes have been scanned (unchanged ones cost one hash compare). */
  start(): Promise<void> {
    const dirs = WATCHED_DIRS.map((d) => resolve(this.#root, d));
    const w = watch(dirs, {
      ignoreInitial: false,
      ignored: (p, s) => !!s?.isFile() && !p.endsWith('.md'),
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
    });
    this.watcher = w;
    const onFile = (abs: string): void => {
      void this.ingest(abs).catch((e: unknown) => this.#log(`obsidian-watch: ${basename(abs)}: ${(e as Error).message}`));
    };
    w.on('add', onFile).on('change', onFile).on('error', (e) => this.#log(`obsidian-watch: ${(e as Error).message}`));
    return new Promise((ok) => w.once('ready', () => ok()));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  /**
   * Upserts one note into staging. A changed note resets to 'pending_approval'; an unchanged one is left alone.
   * @param abs - absolute path of the note
   */
  async ingest(abs: string): Promise<IngestResult> {
    const rel = relative(this.#root, abs).split(sep).join('/');
    if (!abs.endsWith('.md') || rel.startsWith('..')) return 'skipped';
    if ((await stat(abs)).size > MAX_NOTE_BYTES) {
      this.#log(`obsidian-watch: ${rel} skipped (over ${MAX_NOTE_BYTES} bytes)`);
      return 'skipped';
    }
    const r = toRow(rel, await readFile(abs, 'utf8'));
    const rows = await asRole(this.#sql, WATCH_ROLE, (tx) => tx`
      insert into obsidian_findings (domain, source_path, content_hash, raw_content, metadata, extracted_links, status)
      values (${r.domain}, ${r.sourcePath}, ${r.contentHash}, ${r.rawContent},
              ${tx.json(r.metadata as never)}, ${tx.json(r.extractedLinks as never)}, 'pending_approval')
      on conflict (source_path) do update set
        domain = excluded.domain, content_hash = excluded.content_hash, raw_content = excluded.raw_content,
        metadata = excluded.metadata, extracted_links = excluded.extracted_links,
        status = 'pending_approval', updated_at = now()
      where obsidian_findings.content_hash is distinct from excluded.content_hash
      returning id`);
    if (rows.length === 0) return 'unchanged';
    this.#log(`obsidian-watch: staged ${rel} (pending_approval)`);
    return 'staged';
  }
}
