import { readFile } from 'node:fs/promises';
import type { Sql } from '../../../core/db/client.ts';
import { linkGraph, type LinkGraph } from '../../../knowledge/obsidian/notes.ts';
import { previewSync, VAULT_ENV } from '../../../knowledge/obsidian/sync.ts';
import { asWeb, type SongRef } from './loaders.ts';

/**
 * /os (F54): the unified dashboard's reads. Each panel reads its own rows as xyp_web, read only; the
 * Obsidian panel also reads the owner's vault folder. Nothing is cached or estimated: a failed read is an
 * error state, never a zero.
 */

export type AudioItem = {
  readonly id: string;
  readonly title: string;
  readonly mimeType: string | null;
  readonly byteSize: number | null;
  readonly language: string | null;
  readonly createdAt: string;
  readonly songs: readonly SongRef[];
  /** Suno takes this file is the audio of, with the owner's latest rating (1–5) if any. */
  readonly takes: readonly { readonly id: string; readonly rating: number | null }[];
  /** Release tracks whose recording is this file, directly or through its take. */
  readonly tracks: readonly { readonly id: string; readonly title: string; readonly releaseTitle: string }[];
};

/**
 * Records / Audio Library: every Vault audio file, newest first, with its songs, takes and tracks.
 * @param sql - pool
 * @param limit - rows to return (the total is counted apart)
 * @returns the items and the total
 */
export const audioLibrary = (sql: Sql, limit = 50): Promise<{ readonly items: readonly AudioItem[]; readonly total: number }> =>
  asWeb(sql, async (tx) => {
    const [count] = await tx<{ n: number }[]>`select count(*)::int as n from sources where storage is not null and media_class = 'audio'`;
    const rows = await tx<{
      id: string; title: string; mime_type: string | null; byte_size: string | null; language: string | null; created_at: Date;
      songs: SongRef[]; takes: { id: string; rating: number | null }[]; tracks: { id: string; title: string; releaseTitle: string }[];
    }[]>`
      select s.id, s.title, s.mime_type, s.byte_size::text, s.language, s.created_at,
             coalesce((select jsonb_agg(jsonb_build_object('id', cs.id, 'title', cs.title) order by cs.title, cs.id)
                       from current_song_links l join current_songs cs on cs.id = l.song_id where l.source_id = s.id), '[]'::jsonb) as songs,
             coalesce((select jsonb_agg(jsonb_build_object('id', t.id,
                         'rating', (select r.rating from take_ratings r where r.take_id = t.id order by r.created_at desc, r.id desc limit 1)) order by t.id)
                       from suno_takes t where t.source_id = s.id), '[]'::jsonb) as takes,
             coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'title', k.title, 'releaseTitle', rl.title) order by rl.title, k.position)
                       from tracks k join releases rl on rl.id = k.release_id
                       where k.source_id = s.id or k.take_id in (select t.id from suno_takes t where t.source_id = s.id)), '[]'::jsonb) as tracks
      from sources s
      where s.storage is not null and s.media_class = 'audio'
      order by s.created_at desc, s.id
      limit ${limit}`;
    return {
      total: count!.n,
      items: rows.map((r) => ({
        id: r.id, title: r.title, mimeType: r.mime_type, byteSize: r.byte_size === null ? null : Number(r.byte_size), language: r.language,
        createdAt: r.created_at.toISOString(), songs: r.songs, takes: r.takes, tracks: r.tracks,
      })),
    };
  });

export type ResearchSummary = {
  readonly openBriefs: number;
  readonly acceptedFindings: number;
  /** Findings with no owner decision yet. */
  readonly undecidedFindings: number;
  readonly runs: readonly { readonly id: string; readonly status: string; readonly question: string; readonly createdAt: string }[];
};

/**
 * Research: open briefs, the Findings Library, findings awaiting a decision, and the latest runs.
 * @param sql - pool
 * @returns the summary
 */
export const researchSummary = (sql: Sql): Promise<ResearchSummary> =>
  asWeb(sql, async (tx) => {
    const [c] = await tx<{ open: number; accepted: number; undecided: number }[]>`
      select (select count(*)::int from research_questions where status = 'open') as open,
             (select count(*)::int from findings_library) as accepted,
             (select count(*)::int from research_findings f where not exists (select from current_finding_decisions d where d.finding_id = f.id)) as undecided`;
    const runs = await tx<{ id: string; status: string; question: string; created_at: Date }[]>`
      select rr.id, rr.status::text, q.question, rr.created_at from research_runs rr join research_questions q on q.id = rr.question_id
      order by rr.created_at desc, rr.id limit 5`;
    return {
      openBriefs: c!.open, acceptedFindings: c!.accepted, undecidedFindings: c!.undecided,
      runs: runs.map((r) => ({ id: r.id, status: r.status, question: r.question, createdAt: r.created_at.toISOString() })),
    };
  });

export type KnowledgeSummary = {
  readonly vaultFiles: readonly { readonly mediaClass: string; readonly count: number }[];
  readonly canonicalPrompts: number;
  /** Distinct Obsidian notes imported into the Vault, across vaults. */
  readonly obsidianImports: number;
};

/**
 * Knowledge: Vault files by kind, canonical prompts, Obsidian notes imported.
 * @param sql - pool
 * @returns the counts
 */
export const knowledgeSummary = (sql: Sql): Promise<KnowledgeSummary> =>
  asWeb(sql, async (tx) => {
    const files = await tx<{ media_class: string; n: number }[]>`
      select media_class::text, count(*)::int as n from sources where storage is not null group by media_class order by media_class`;
    const [c] = await tx<{ canonical: number; imports: number }[]>`
      select (select count(*)::int from canonical_prompts) as canonical,
             (select count(*)::int from (select distinct vault_root, note_path from obsidian_sync_events where direction = 'import') x) as imports`;
    return { vaultFiles: files.map((f) => ({ mediaClass: f.media_class, count: f.n })), canonicalPrompts: c!.canonical, obsidianImports: c!.imports };
  });

export type ObsidianPanel =
  | { readonly state: 'not-configured'; readonly envVar: string }
  | { readonly state: 'error'; readonly error: string }
  | {
      readonly state: 'ready';
      readonly root: string;
      readonly adjusted: boolean;
      readonly planHash: string;
      readonly counts: { readonly import: number; readonly export: number; readonly conflicts: number; readonly unchanged: number; readonly gone: number; readonly skipped: number };
      /** The first actions and conflicts, for the owner to read before Apply. */
      readonly actions: readonly { readonly kind: 'import' | 'export'; readonly rel: string; readonly update: boolean }[];
      readonly conflicts: readonly { readonly rel: string; readonly reason: string }[];
      readonly graph: LinkGraph;
      readonly lastSync: string | null;
    };

const SHOWN = 40;

/**
 * Knowledge / Obsidian: the vault's sync preview and its wikilink graph. Writes nothing.
 * @param sql - pool
 * @param env - environment (XYP_OBSIDIAN_VAULT)
 * @returns not-configured, error, or the preview
 */
export const obsidianPanel = async (sql: Sql, env: Readonly<Record<string, string | undefined>>): Promise<ObsidianPanel> => {
  const configured = env[VAULT_ENV];
  if (!configured || configured.trim() === '') return { state: 'not-configured', envVar: VAULT_ENV };
  try {
    const p = await previewSync(sql, configured);
    const texts = await Promise.all(p.notes.map(async (n) => ({ rel: n.rel, text: await readFile(n.abs, 'utf8') })));
    const [last] = await asWeb(sql, (tx) => tx<{ at: Date | null }[]>`select max(created_at) as at from obsidian_sync_events where vault_root = ${p.root}`);
    const imports = p.plan.actions.filter((a) => a.kind === 'import').length;
    return {
      state: 'ready', root: p.root, adjusted: p.adjusted, planHash: p.plan.hash,
      counts: {
        import: imports, export: p.plan.actions.length - imports, conflicts: p.plan.conflicts.length, unchanged: p.plan.unchanged,
        gone: p.plan.gone.length, skipped: p.skipped.length,
      },
      actions: p.plan.actions.slice(0, SHOWN).map((a) => ({ kind: a.kind, rel: a.rel, update: a.kind === 'export' && a.expectedSha !== null })),
      conflicts: p.plan.conflicts.slice(0, SHOWN),
      graph: linkGraph(texts),
      lastSync: last?.at ? last.at.toISOString() : null,
    };
  } catch (e) {
    return { state: 'error', error: (e as Error).message };
  }
};
