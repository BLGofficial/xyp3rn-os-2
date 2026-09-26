import type postgres from 'postgres';
import type { Sql } from '../../../core/db/client.ts';
import { LYRICS_SCHEMA_ID, META_TAG_SET_SCHEMA_ID, STYLE_RECIPE_SCHEMA_ID, SUNO_PACKAGE_SCHEMA_ID } from '../../../records/x3lius/creative/schemas.ts';
import { readPackageExport, type SunoPackageExport } from '../../../records/x3lius/suno/package-export.ts';
import { defaultTagSet, type TagSection } from '../../../records/x3lius/studio/tags.ts';
import { asWeb, type SongRef } from './loaders.ts';

export { packageText } from '../../../records/x3lius/suno/package-export.ts';

/**
 * What the Studio screens read (AOS-03 §6), as xyp_web in read-only transactions: the owner's style
 * recipes and tag sets with their versions and approvals, the song's Studio section, and each Suno
 * prompt package with its trace, what blocks its handoff, its attempts, takes and ratings.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND_OF: Readonly<Record<string, 'recipe' | 'tags'>> = { [STYLE_RECIPE_SCHEMA_ID]: 'recipe', [META_TAG_SET_SCHEMA_ID]: 'tags' };

/**
 * The section kinds a tag set can tag, with the code labels as their defaults: the new tag set form's rows.
 * @returns the default set's sections
 */
export const tagKinds = (): readonly TagSection[] => defaultTagSet().sections;

export type StudioLineageRow = {
  readonly lineageId: string; readonly name: string; readonly latestVersion: number; readonly approvedVersion: number | null;
  readonly updatedAt: string; readonly packages: number;
};
type LineageDb = { lineage_id: string; name: string; latest_version: number; approved_version: number | null; created_at: Date; packages: number };

// Each lineage at its latest version, with how many packages were built from any of its versions.
const lineagesOf = async (tx: postgres.TransactionSql, schemaId: string): Promise<StudioLineageRow[]> =>
  (await tx<LineageDb[]>`
    select a.lineage_id, a.body->>'name' as name, a.version as latest_version, a.created_at,
           (select max(ap.approved_version) from artifact_approvals ap where ap.lineage_id = a.lineage_id) as approved_version,
           (select count(distinct p.id)::int from creative_artifacts p
            cross join jsonb_array_elements(p.body->'sources') x
            join creative_artifacts v on v.id::text = x->>'artifactId'
            where p.schema_id = ${SUNO_PACKAGE_SCHEMA_ID} and v.lineage_id = a.lineage_id) as packages
    from creative_artifacts a
    where a.schema_id = ${schemaId} and a.version = (select max(x.version) from creative_artifacts x where x.lineage_id = a.lineage_id)
    order by a.created_at desc, a.lineage_id`).map((r) => ({
    lineageId: r.lineage_id, name: r.name, latestVersion: r.latest_version, approvedVersion: r.approved_version, updatedAt: r.created_at.toISOString(), packages: r.packages,
  }));

export type AttemptRow = {
  readonly submissionId: string; readonly createdAt: string; readonly adapter: string; readonly sunoModel: string; readonly packageId: string;
  readonly title: string | null; readonly songId: string | null; readonly songTitle: string | null; readonly takeCount: number; readonly isTraced: boolean;
};

/**
 * /studio: every recipe and tag set lineage, the recent generation attempts, and the time it was read.
 * @param sql - the app's pool
 * @returns the Studio index
 */
export const studioIndex = (sql: Sql) =>
  asWeb(sql, async (tx) => {
    const attempts = await tx<{ submission_id: string; created_at: Date; adapter: string; suno_model: string; package_id: string; title: string | null; song_id: string | null; song_title: string | null; take_count: number; is_traced: boolean }[]>`
      select g.submission_id, g.created_at, g.adapter, g.suno_model, g.package_id, g.title, g.song_id, s.title as song_title, g.take_count, g.is_traced
      from generation_attempts g left join current_songs s on s.id = g.song_id
      order by g.created_at desc, g.submission_id limit 25`;
    const [now] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
    return {
      recipes: await lineagesOf(tx, STYLE_RECIPE_SCHEMA_ID),
      tagSets: await lineagesOf(tx, META_TAG_SET_SCHEMA_ID),
      attempts: attempts.map((a): AttemptRow => ({
        submissionId: a.submission_id, createdAt: a.created_at.toISOString(), adapter: a.adapter, sunoModel: a.suno_model, packageId: a.package_id,
        title: a.title, songId: a.song_id, songTitle: a.song_title, takeCount: a.take_count, isTraced: a.is_traced,
      })),
      asOf: now!.now.toISOString(),
    };
  });

export type StudioVersionRow = {
  readonly id: string; readonly version: number; readonly status: string; readonly agentName: string; readonly createdAt: string;
  readonly body: Record<string, any>; readonly warnings: readonly { message?: string }[];
  readonly decidedBy: string | null; readonly decidedAt: string | null; readonly decisionReason: string | null;
};

/**
 * /studio/recipes/[id] and /studio/tags/[id]: a recipe or tag set lineage, every version with its
 * status and body, and the packages built from any of its versions.
 * @param sql - the app's pool
 * @param lineageId - the lineage root's id
 * @returns the lineage, or null when there is no recipe or tag set lineage with that id
 */
export const studioLineage = (sql: Sql, lineageId: string) =>
  asWeb(sql, async (tx) => {
    if (!UUID.test(lineageId)) return null;
    const rows = await tx<{
      id: string; version: number; schema_id: string; status: string; agent_name: string; created_at: Date; body: Record<string, any>; warnings: { message?: string }[];
      decided_by: string | null; decided_at: Date | null; decision_reason: string | null; approved_version: number | null;
    }[]>`
      select c.id, c.version, c.schema_id, ap.status, c.agent_name, c.created_at, c.body, c.warnings, ap.decided_by, ap.decided_at, ap.decision_reason, ap.approved_version
      from creative_artifacts c join artifact_approvals ap on ap.id = c.id
      where c.lineage_id = ${lineageId} and c.schema_id = any(${Object.keys(KIND_OF)}::text[])
      order by c.version`;
    if (rows.length === 0) return null;
    const packages = await tx<{ package_id: string; title: string; created_at: Date; version: number; song_id: string | null; song_title: string | null }[]>`
      select p.id as package_id, p.body->>'title' as title, p.created_at, v.version, l.song_id, s.title as song_title
      from creative_artifacts p
      cross join jsonb_array_elements(p.body->'sources') x
      join creative_artifacts v on v.id::text = x->>'artifactId'
      left join current_song_links l on l.artifact_lineage_id = p.lineage_id and l.role = 'suno-package'
      left join current_songs s on s.id = l.song_id
      where p.schema_id = ${SUNO_PACKAGE_SCHEMA_ID} and v.lineage_id = ${lineageId}
      order by p.created_at desc, p.id`;
    return {
      kind: KIND_OF[rows[0]!.schema_id]!, lineageId, schemaId: rows[0]!.schema_id, approvedVersion: rows[0]!.approved_version,
      versions: rows.map((r): StudioVersionRow => ({
        id: r.id, version: r.version, status: r.status, agentName: r.agent_name, createdAt: r.created_at.toISOString(), body: r.body, warnings: r.warnings,
        decidedBy: r.decided_by, decidedAt: r.decided_at?.toISOString() ?? null, decisionReason: r.decision_reason,
      })),
      packages: packages.map((p) => ({
        packageId: p.package_id, title: p.title, createdAt: p.created_at.toISOString(), version: p.version,
        song: p.song_id ? ({ id: p.song_id, title: p.song_title ?? p.song_id } satisfies SongRef) : null,
      })),
    };
  });

export type VersionOption = { readonly id: string; readonly lineageId: string; readonly version: number; readonly status: string; readonly name: string };

/**
 * The song workspace's Studio section: what a package can be built from (the song's lyric versions,
 * every recipe and tag set version, each with its status; newest first) and the song's packages
 * with what blocks each one's handoff.
 * @param sql - the app's pool
 * @param songId - songs.id (checked by the caller)
 * @returns the options and packages
 */
export const songStudio = (sql: Sql, songId: string) =>
  asWeb(sql, async (tx) => {
    const empty = { lyrics: [] as VersionOption[], recipes: [] as VersionOption[], tagSets: [] as VersionOption[], packages: [] as PackageRow[] };
    if (!UUID.test(songId)) return empty;
    const lyrics = await tx<{ id: string; lineage_id: string; version: number; status: string; name: string }[]>`
      select c.id, c.lineage_id, c.version, ap.status, root.brief as name
      from current_song_links l
      join creative_artifacts root on root.id = l.artifact_lineage_id
      join creative_artifacts c on c.lineage_id = root.id
      join artifact_approvals ap on ap.id = c.id
      where l.song_id = ${songId} and c.schema_id = ${LYRICS_SCHEMA_ID}
      order by l.created_at, c.version desc`;
    const versionsOf = (schemaId: string) => tx<{ id: string; lineage_id: string; version: number; status: string; name: string }[]>`
      select c.id, c.lineage_id, c.version, ap.status, c.body->>'name' as name
      from creative_artifacts c join artifact_approvals ap on ap.id = c.id
      join creative_artifacts root on root.id = c.lineage_id
      where c.schema_id = ${schemaId}
      order by root.created_at desc, c.lineage_id, c.version desc`;
    const packages = await tx<{ id: string; title: string; created_at: Date; reasons: string[]; attempts: number }[]>`
      select p.id, p.body->>'title' as title, p.created_at, xyp_suno_package_ready(p.id) as reasons,
             (select count(*)::int from suno_submissions s where s.formula_artifact_id = p.id) as attempts
      from current_song_links l join creative_artifacts p on p.id = l.artifact_lineage_id
      where l.song_id = ${songId} and l.role = 'suno-package' and p.schema_id = ${SUNO_PACKAGE_SCHEMA_ID}
      order by p.created_at desc, p.id`;
    const option = (r: { id: string; lineage_id: string; version: number; status: string; name: string }): VersionOption =>
      ({ id: r.id, lineageId: r.lineage_id, version: r.version, status: r.status, name: r.name });
    return {
      lyrics: lyrics.map(option),
      recipes: (await versionsOf(STYLE_RECIPE_SCHEMA_ID)).map(option),
      tagSets: (await versionsOf(META_TAG_SET_SCHEMA_ID)).map(option),
      packages: packages.map((p): PackageRow => ({
        packageId: p.id, title: p.title, createdAt: p.created_at.toISOString(), ready: p.reasons.length === 0, blockers: p.reasons.length, attempts: p.attempts,
      })),
    };
  });

export type PackageRow = { readonly packageId: string; readonly title: string; readonly createdAt: string; readonly ready: boolean; readonly blockers: number; readonly attempts: number };

export type TakeRow = {
  readonly takeId: string; readonly createdAt: string; readonly title: string | null; readonly fileTitle: string | null; readonly sourceId: string | null;
  readonly audioUrl: string | null; readonly audioSha256: string | null; readonly durationSeconds: number | null;
  readonly rating: number | null; readonly keep: string | null; readonly change: string | null; readonly ratedAt: string | null;
};

/**
 * /studio/packages/[id]: the package export (each source with its lineage), its song, and every
 * attempt (submission) with its takes and their current ratings.
 * @param sql - the app's pool
 * @param id - a x3lius.suno-package/v1 artifact id
 * @returns the package, or null when there is no package with that id
 */
export const packageDetail = (sql: Sql, id: string) =>
  asWeb(sql, async (tx) => {
    if (!UUID.test(id)) return null;
    const [a] = await tx<{ lineage_id: string }[]>`select lineage_id from creative_artifacts where id = ${id} and schema_id = ${SUNO_PACKAGE_SCHEMA_ID}`;
    if (!a) return null;
    const e: SunoPackageExport = await readPackageExport(tx, id);
    const lineages = new Map((await tx<{ id: string; lineage_id: string }[]>`
      select id, lineage_id from creative_artifacts where id = any(${e.sources.map((s) => s.artifactId)}::uuid[])`).map((r) => [r.id, r.lineage_id]));
    const [song] = await tx<{ id: string; title: string }[]>`
      select s.id, s.title from current_song_links l join current_songs s on s.id = l.song_id
      where l.artifact_lineage_id = ${a.lineage_id} and l.role = 'suno-package' order by l.created_at limit 1`;
    const subs = await tx<{ id: string; created_at: Date; adapter: string; provider_task_id: string | null }[]>`
      select id, created_at, adapter, provider_task_id from suno_submissions where formula_artifact_id = ${id} order by created_at, id`;
    const takes = await tx<{
      take_id: string; submission_id: string; created_at: Date; title: string | null; file_title: string | null; source_id: string | null; audio_url: string | null;
      audio_sha256: string | null; duration_seconds: string | null; rating: number | null; keep: string | null; change: string | null; rated_at: Date | null;
    }[]>`
      select take_id, submission_id, created_at, title, file_title, source_id, audio_url, audio_sha256, duration_seconds::text, rating, keep, change, rated_at
      from generation_takes where submission_id = any(${subs.map((s) => s.id)}::uuid[]) order by created_at, take_id`;
    return {
      export: { ...e, sources: e.sources.map((s) => ({ ...s, lineageId: lineages.get(s.artifactId) ?? null })) },
      song: song ? ({ id: song.id, title: song.title } satisfies SongRef) : null,
      attempts: subs.map((s) => ({
        submissionId: s.id, createdAt: s.created_at.toISOString(), adapter: s.adapter, providerTaskId: s.provider_task_id,
        takes: takes.filter((t) => t.submission_id === s.id).map((t): TakeRow => ({
          takeId: t.take_id, createdAt: t.created_at.toISOString(), title: t.title, fileTitle: t.file_title, sourceId: t.source_id, audioUrl: t.audio_url,
          audioSha256: t.audio_sha256, durationSeconds: t.duration_seconds === null ? null : Number(t.duration_seconds),
          rating: t.rating, keep: t.keep, change: t.change, ratedAt: t.rated_at?.toISOString() ?? null,
        })),
      })),
    };
  });
