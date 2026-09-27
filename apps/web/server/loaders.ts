import type postgres from 'postgres';
import type { Sql } from '../../../core/db/client.ts';
import { sheetText } from '../../../records/vault/lyric-sheet.ts';

/**
 * What the UI reads (AOS-01 §9, A4). Every loader runs as xyp_web in a read-only transaction: the
 * role can't write, and the transaction couldn't even if it could. Pages only render the result.
 */

const WEB_ROLE = 'xyp_web';
const LYRICS_SCHEMAS = ['x3lius.lyrics/v2', 'x3lius.lyrics/v1'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Runs fn as xyp_web, read only.
 * @param sql - the app's pool
 * @param fn - the reads
 * @returns fn's result
 */
export const asWeb = <T>(sql: Sql, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  sql.begin('read only', async (tx) => {
    await tx.unsafe(`set local role ${WEB_ROLE}`);
    return fn(tx);
  }) as Promise<T>;

export type SongRef = { readonly id: string; readonly title: string };

// Songs linked to each target id (a lineage root or a source), live links only.
const songsByTarget = async (tx: postgres.TransactionSql, ids: readonly string[]): Promise<Map<string, SongRef[]>> => {
  const m = new Map<string, SongRef[]>();
  for (const r of await tx<{ target_id: string; id: string; title: string }[]>`
    select l.target_id, s.id, s.title from current_song_links l join current_songs s on s.id = l.song_id
    where l.target_id = any(${ids}::uuid[]) order by s.title, s.id`) m.set(r.target_id, [...(m.get(r.target_id) ?? []), { id: r.id, title: r.title }]);
  return m;
};

export type VaultFilter = { readonly kind?: string; readonly songId?: string; readonly tag?: string; readonly language?: string };
export type FileRow = { readonly id: string; readonly title: string; readonly mediaClass: string; readonly language: string | null; readonly createdAt: string; readonly tags: readonly string[]; readonly songs: readonly SongRef[] };
export type LineageRow = {
  readonly lineageId: string; readonly title: string; readonly latestId: string; readonly latestVersion: number;
  readonly approvedVersion: number | null; readonly language: string | null; readonly createdAt: string; readonly songs: readonly SongRef[];
};

/**
 * /vault: the owner's files and lyric lineages. kind `lyrics` shows lineages only, a media class
 * files of that class only; a tag keeps files only (lineages carry no tags).
 * @param sql - the app's pool
 * @param f - filters, each optional
 * @returns files and lineages, newest first
 */
export const listVault = (sql: Sql, f: VaultFilter): Promise<{ readonly files: FileRow[]; readonly lineages: LineageRow[] }> =>
  asWeb(sql, async (tx) => {
    if (f.songId !== undefined && !UUID.test(f.songId)) return { files: [], lineages: [] };
    const wantFiles = f.kind !== 'lyrics';
    const wantLineages = (f.kind === undefined || f.kind === 'lyrics') && f.tag === undefined;
    const files = !wantFiles ? [] : await tx<{ id: string; title: string; media_class: string; language: string | null; created_at: Date; tags: string[] }[]>`
      select s.id, s.title, s.media_class, s.language, s.created_at,
             array(select g.slug from source_tags st join tags g on g.id = st.tag_id where st.source_id = s.id order by g.slug) as tags
      from sources s
      where s.storage is not null
        and (${f.kind ?? null}::text is null or s.media_class = ${f.kind ?? null})
        and (${f.language ?? null}::text is null or s.language = ${f.language ?? null})
        and (${f.tag ?? null}::text is null or exists (select from source_tags st join tags g on g.id = st.tag_id where st.source_id = s.id and g.slug = ${f.tag ?? null}))
        and (${f.songId ?? null}::uuid is null or exists (select from current_song_links l where l.song_id = ${f.songId ?? null} and l.source_id = s.id))
      order by s.created_at desc, s.id`;
    const lineages = !wantLineages ? [] : await tx<{ lineage_id: string; brief: string; latest_id: string; latest_version: number; approved_version: number | null; language: string | null; created_at: Date }[]>`
      select a.lineage_id, root.brief, a.id as latest_id, a.version as latest_version, a.approved_version,
             a.body #>> '{sections,0,bars,0,language}' as language, root.created_at
      from (select distinct on (lineage_id) c.id, c.lineage_id, c.version, c.body, ap.approved_version
            from creative_artifacts c join artifact_approvals ap on ap.id = c.id
            where c.schema_id = any(${LYRICS_SCHEMAS}::text[])
            order by lineage_id, version desc) a
      join creative_artifacts root on root.id = a.lineage_id
      where (${f.language ?? null}::text is null or a.body #>> '{sections,0,bars,0,language}' = ${f.language ?? null})
        and (${f.songId ?? null}::uuid is null or exists (select from current_song_links l where l.song_id = ${f.songId ?? null} and l.artifact_lineage_id = a.lineage_id))
      order by root.created_at desc, a.lineage_id`;
    const songs = await songsByTarget(tx, [...files.map((r) => r.id), ...lineages.map((r) => r.lineage_id)]);
    return {
      files: files.map((r) => ({ id: r.id, title: r.title, mediaClass: r.media_class, language: r.language, createdAt: r.created_at.toISOString(), tags: r.tags, songs: songs.get(r.id) ?? [] })),
      lineages: lineages.map((r) => ({
        lineageId: r.lineage_id, title: r.brief, latestId: r.latest_id, latestVersion: r.latest_version, approvedVersion: r.approved_version,
        language: r.language, createdAt: r.created_at.toISOString(), songs: songs.get(r.lineage_id) ?? [],
      })),
    };
  });

export type FileDetail = FileRow & {
  readonly sha256: string; readonly mimeType: string | null; readonly byteSize: number | null; readonly filename: string | null;
  readonly text: string | null; readonly extractor: string | null; readonly uri: string;
  readonly run: { readonly id: string; readonly agentName: string; readonly status: string; readonly createdAt: string } | null;
  /** Indexed for Vault search (AOS-04 Plan C1): the latest vault_embeddings row's model and time, or null when not yet. */
  readonly indexed: { readonly model: string; readonly at: string } | null;
};

/**
 * /vault/files/[id]: one Vault file with its provenance (the run that added it), text, tags, songs.
 * @param sql - the app's pool
 * @param id - sources.id
 * @returns the file, or null when there is no Vault file with that id
 */
export const fileDetail = (sql: Sql, id: string): Promise<FileDetail | null> =>
  asWeb(sql, async (tx) => {
    if (!UUID.test(id)) return null;
    const [r] = await tx<{
      id: string; title: string; media_class: string; language: string | null; created_at: Date; checksum_sha256: string; mime_type: string | null;
      byte_size: string | null; metadata: { filename?: string }; uri: string; text: string | null; extractor: string | null; tags: string[];
      run_id: string | null; agent_name: string | null; run_status: string | null; run_created_at: Date | null;
      indexed_model: string | null; indexed_at: Date | null;
    }[]>`
      select s.id, s.title, s.media_class, s.language, s.created_at, s.checksum_sha256, s.mime_type, s.byte_size::text, s.metadata, s.uri,
             t.text, t.extractor,
             array(select g.slug from source_tags st join tags g on g.id = st.tag_id where st.source_id = s.id order by g.slug) as tags,
             r.id as run_id, r.agent_name, r.status::text as run_status, r.created_at as run_created_at,
             v.model as indexed_model, v.updated_at as indexed_at
      from sources s left join source_texts t on t.source_id = s.id left join agent_runs r on r.id = s.agent_run_id
      left join lateral (select model, updated_at from vault_embeddings v where v.entity_kind = 'source' and v.entity_id = s.id order by updated_at desc limit 1) v on true
      where s.id = ${id} and s.storage is not null`;
    if (!r) return null;
    const songs = await songsByTarget(tx, [r.id]);
    return {
      id: r.id, title: r.title, mediaClass: r.media_class, language: r.language, createdAt: r.created_at.toISOString(), tags: r.tags, songs: songs.get(r.id) ?? [],
      sha256: r.checksum_sha256, mimeType: r.mime_type, byteSize: r.byte_size === null ? null : Number(r.byte_size), filename: r.metadata.filename ?? null,
      text: r.text, extractor: r.extractor, uri: r.uri,
      run: r.run_id ? { id: r.run_id, agentName: r.agent_name!, status: r.run_status!, createdAt: r.run_created_at!.toISOString() } : null,
      indexed: r.indexed_model ? { model: r.indexed_model, at: r.indexed_at!.toISOString() } : null,
    };
  });

export type VersionRow = {
  readonly id: string; readonly version: number; readonly status: string; readonly agentName: string; readonly createdAt: string; readonly brief: string;
  readonly decidedBy: string | null; readonly decidedAt: string | null; readonly decisionReason: string | null; readonly sheet: string;
};

/**
 * /vault/lineages/[id]: every version of a lyrics lineage, oldest first, with its approval state
 * and its text as a lyric sheet (what the diff and the edit form use).
 * @param sql - the app's pool
 * @param lineageId - the lineage root's id
 * @returns the lineage, or null when there is no lyrics lineage with that id
 */
export const lineageDetail = (sql: Sql, lineageId: string): Promise<{
  readonly lineageId: string; readonly schemaId: string; readonly approvedVersion: number | null; readonly versions: VersionRow[]; readonly songs: readonly SongRef[];
} | null> =>
  asWeb(sql, async (tx) => {
    if (!UUID.test(lineageId)) return null;
    const rows = await tx<{
      id: string; version: number; schema_id: string; status: string; agent_name: string; created_at: Date; brief: string; body: Record<string, unknown>;
      decided_by: string | null; decided_at: Date | null; decision_reason: string | null; approved_version: number | null;
    }[]>`
      select c.id, c.version, c.schema_id, ap.status, c.agent_name, c.created_at, c.brief, c.body, ap.decided_by, ap.decided_at, ap.decision_reason, ap.approved_version
      from creative_artifacts c join artifact_approvals ap on ap.id = c.id
      where c.lineage_id = ${lineageId} and c.schema_id = any(${LYRICS_SCHEMAS}::text[])
      order by c.version`;
    if (rows.length === 0) return null;
    const songs = await songsByTarget(tx, [lineageId]);
    const sections = (b: Record<string, unknown>) =>
      Array.isArray(b.sections) ? (b.sections as Parameters<typeof sheetText>[0]['sections']) : [{ ...(b.section as { label: string }), directions: [], bars: b.bars as { text: string }[] }];
    return {
      lineageId, schemaId: rows[0]!.schema_id, approvedVersion: rows[0]!.approved_version, songs: songs.get(lineageId) ?? [],
      versions: rows.map((r) => ({
        id: r.id, version: r.version, status: r.status, agentName: r.agent_name, createdAt: r.created_at.toISOString(), brief: r.brief,
        decidedBy: r.decided_by, decidedAt: r.decided_at?.toISOString() ?? null, decisionReason: r.decision_reason, sheet: sheetText({ sections: sections(r.body) }),
      })),
    };
  });

export type SongRow = {
  readonly id: string; readonly title: string; readonly artist: string; readonly language: string | null; readonly genre: string | null;
  readonly status: string; readonly revision: number; readonly notes: string | null; readonly createdAt: string; readonly links: number;
};

const songRow = (r: { id: string; title: string; artist: string; language: string | null; genre: string | null; status: string; revision: number; notes: string | null; created_at: Date; links: number }): SongRow => ({
  id: r.id, title: r.title, artist: r.artist, language: r.language, genre: r.genre, status: r.status, revision: r.revision, notes: r.notes,
  createdAt: r.created_at.toISOString(), links: r.links,
});

/**
 * /songs: the catalog, each song at its current revision with its count of live links.
 * @param sql - the app's pool
 * @returns songs by title
 */
export const songList = (sql: Sql): Promise<SongRow[]> =>
  asWeb(sql, async (tx) => (await tx<Parameters<typeof songRow>[0][]>`
    select s.id, s.title, s.artist, s.language, s.genre, s.status::text, s.revision, s.notes, s.created_at,
           (select count(*)::int from current_song_links l where l.song_id = s.id) as links
    from current_songs s order by s.title, s.id`).map(songRow));

/**
 * /songs/[id]: a song's revisions and every live link, grouped by what it points at.
 * @param sql - the app's pool
 * @param id - songs.id
 * @returns the song, or null
 */
export const songDetail = (sql: Sql, id: string) =>
  asWeb(sql, async (tx) => {
    if (!UUID.test(id)) return null;
    const [s] = await tx<Parameters<typeof songRow>[0][]>`
      select s.id, s.title, s.artist, s.language, s.genre, s.status::text, s.revision, s.notes, s.created_at,
             (select count(*)::int from current_song_links l where l.song_id = s.id) as links
      from current_songs s where s.id = ${id}`;
    if (!s) return null;
    const revisions = await tx<{ revision: number; title: string; artist: string; language: string | null; genre: string | null; status: string; notes: string | null; created_at: Date; agent_run_id: string }[]>`
      select revision, title, artist, language, genre, status::text, notes, created_at, agent_run_id from song_revisions where song_id = ${id} order by revision desc`;
    const lyrics = await tx<{ link_id: string; role: string | null; lineage_id: string; title: string; latest_version: number; approved_version: number | null }[]>`
      select l.id as link_id, l.role, l.artifact_lineage_id as lineage_id, root.brief as title,
             (select max(c.version) from creative_artifacts c where c.lineage_id = l.artifact_lineage_id) as latest_version,
             (select max(ap.approved_version) from artifact_approvals ap where ap.lineage_id = l.artifact_lineage_id) as approved_version
      from current_song_links l join creative_artifacts root on root.id = l.artifact_lineage_id
      where l.song_id = ${id} and root.schema_id = any(${LYRICS_SCHEMAS}::text[]) order by l.created_at`;
    const files = await tx<{ link_id: string; role: string | null; id: string; title: string; media_class: string | null }[]>`
      select l.id as link_id, l.role, s.id, s.title, s.media_class from current_song_links l join sources s on s.id = l.source_id
      where l.song_id = ${id} order by l.created_at`;
    // A take is a URL or, since AOS-03, a Vault audio file (audio_url null).
    const takes = await tx<{ link_id: string; role: string | null; id: string; title: string | null; audio_url: string | null }[]>`
      select l.id as link_id, l.role, t.id, t.title, t.audio_url from current_song_links l join suno_takes t on t.id = l.take_id
      where l.song_id = ${id} order by l.created_at`;
    const tracks = await tx<{ link_id: string; role: string | null; id: string; title: string; release_title: string; release_status: string }[]>`
      select l.id as link_id, l.role, t.id, t.title, r.title as release_title, r.status::text as release_status
      from current_song_links l join tracks t on t.id = l.track_id join releases r on r.id = t.release_id
      where l.song_id = ${id} order by l.created_at`;
    const research = await tx<{ link_id: string; role: string | null; id: string; question: string }[]>`
      select l.id as link_id, l.role, q.id, q.question from current_song_links l join research_questions q on q.id = l.research_question_id
      where l.song_id = ${id} order by l.created_at`;
    return {
      song: songRow(s),
      revisions: revisions.map((r) => ({ revision: r.revision, title: r.title, artist: r.artist, language: r.language, genre: r.genre, status: r.status, notes: r.notes, createdAt: r.created_at.toISOString(), runId: r.agent_run_id })),
      lyrics: lyrics.map((r) => ({ linkId: r.link_id, role: r.role, lineageId: r.lineage_id, title: r.title, latestVersion: r.latest_version, approvedVersion: r.approved_version })),
      files: files.map((r) => ({ linkId: r.link_id, role: r.role, id: r.id, title: r.title, mediaClass: r.media_class })),
      takes: takes.map((r) => ({ linkId: r.link_id, role: r.role, id: r.id, title: r.title, audioUrl: r.audio_url })),
      tracks: tracks.map((r) => ({ linkId: r.link_id, role: r.role, id: r.id, title: r.title, releaseTitle: r.release_title, releaseStatus: r.release_status })),
      research: research.map((r) => ({ linkId: r.link_id, role: r.role, id: r.id, question: r.question })),
    };
  });

const VAULT_AGENTS = ['vault-curator', 'records-songs', 'x3lius-lyric-editor'];

/**
 * /ingest: the ingestion status view, from rows (§6): recent Vault agent runs, recent knowledge
 * ingestion runs, and how many Vault entities `pnpm embed` has not indexed yet.
 * @param sql - the app's pool
 * @returns runs, ingestion runs, backlog per kind
 */
export const ingestStatus = (sql: Sql) =>
  asWeb(sql, async (tx) => {
    const runs = await tx<{ id: string; agent_name: string; status: string; error_detail: string | null; latency_ms: number | null; created_at: Date }[]>`
      select id, agent_name, status::text, error_detail, latency_ms, created_at from agent_runs
      where agent_name = any(${VAULT_AGENTS}::text[]) order by created_at desc, id limit 25`;
    const ingestion = await tx<{ id: string; requested_uri: string; status: string; started_at: Date }[]>`
      select id, requested_uri, status::text, started_at from ingestion_runs order by started_at desc, id limit 10`;
    const [b] = await tx<{ artifact: number; source: number; research_finding: number }[]>`
      select (select count(*)::int from creative_artifacts c where not exists (select from vault_embeddings v where v.entity_kind = 'artifact' and v.entity_id = c.id)) as artifact,
             (select count(*)::int from sources s where s.storage is not null and not exists (select from vault_embeddings v where v.entity_kind = 'source' and v.entity_id = s.id)) as source,
             (select count(*)::int from research_findings f where not exists (select from vault_embeddings v where v.entity_kind = 'research_finding' and v.entity_id = f.id)) as research_finding`;
    return {
      runs: runs.map((r) => ({ id: r.id, agentName: r.agent_name, status: r.status, error: r.error_detail, latencyMs: r.latency_ms, createdAt: r.created_at.toISOString() })),
      ingestionRuns: ingestion.map((r) => ({ id: r.id, uri: r.requested_uri, status: r.status, startedAt: r.started_at.toISOString() })),
      backlog: b!,
    };
  });
