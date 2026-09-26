import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../core/db/client.ts';
import { defineTool, type Tool } from '../../core/tool-registry/registry.ts';

/**
 * Records ops tools (Phase 13). Reads run as xyp_runtime in read-only transactions (catalog.read);
 * catalog writes as xyp_catalog, calendar moves as xyp_release_calendar (catalog.write). The DB
 * enforces the split sum, the scheduling guard, code formats and transitions: tools check input
 * shape only and surface the DB's refusal as the error, so there is one source of truth.
 */

export const CATALOG_ROLE = 'xyp_catalog';
export const CALENDAR_ROLE = 'xyp_release_calendar';
const READ_ROLE = 'xyp_runtime';
export const MIX_REPORT_SCHEMA_ID = 'x3lius.mix-report/v1';

type Deps = { readonly sql: Sql };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Runs fn under a DB role in one transaction (mode e.g. 'read only'). */
export const asRole = <T>(sql: Sql, role: string, fn: (tx: postgres.TransactionSql) => Promise<T>, mode = ''): Promise<T> =>
  sql.begin(mode, async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(role)}`);
    return fn(tx);
  }) as Promise<T>;
const asReader = <T>(sql: Sql, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> => asRole(sql, READ_ROLE, fn, 'read only');

/** @returns args as an object, or throws naming the tool. */
export const obj = (tool: string, args: unknown): Record<string, unknown> => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${tool}: input must be an object`);
  return args as Record<string, unknown>;
};
/** @returns v as a uuid, or throws naming the tool and field. */
export const uuid = (tool: string, field: string, v: unknown): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw new Error(`${tool}: ${field} must be a uuid`);
  return v;
};
/** @returns v as a string, or throws naming the tool and field. */
export const text = (tool: string, field: string, v: unknown): string => {
  if (typeof v !== 'string') throw new Error(`${tool}: ${field} must be a string`);
  return v;
};

// ─── reads (catalog.read) ─────────────────────────────────────────────────────────────────────────

/** What resolve_take returns: one take's provenance, formula to audio. */
export type TakeChain = {
  readonly take: { readonly id: string; readonly audioUrl: string | null; readonly title: string | null; readonly durationSeconds: number | null };
  readonly submission: { readonly id: string; readonly adapter: string; readonly sunoModel: string };
  readonly formula: { readonly artifactId: string; readonly schemaId: string; readonly title: string | null };
  readonly mixReport: { readonly artifactId: string; readonly schemaId: string } | null;
};

/**
 * resolve_take (catalog.read): a take's chain — take → submission → formula artifact — plus the
 * schema of a mix report the caller wants linked. The lookup's only view of creative output: it
 * returns ids, titles and schema ids, never artifact bodies (Knowledge holds no artifact.read).
 * @param deps - pool; reads as xyp_runtime, read only
 * @returns the tool definition
 */
export const createResolveTakeTool = (deps: Deps): Tool =>
  defineTool({
    name: 'resolve_take',
    capability: 'catalog.read',
    description: "One take's provenance (take → Suno submission → formula artifact) and a mix report's schema id.",
    handler: async (_ctx, args) => {
      const a = obj('resolve_take', args);
      const takeId = uuid('resolve_take', 'takeId', a.takeId);
      const mixId = a.mixReportArtifactId === undefined || a.mixReportArtifactId === null ? null : uuid('resolve_take', 'mixReportArtifactId', a.mixReportArtifactId);
      return asReader(deps.sql, async (tx) => {
        // xyp_runtime can't read the Suno trail (Phase 9); xyp_resolve_take returns this one chain.
        const [row] = await tx<{
          // Null since AOS-03 when the take is a Vault audio file (suno_takes.source_id).
          take_id: string; audio_url: string | null; take_title: string | null; duration_seconds: string | null;
          submission_id: string; adapter: string; suno_model: string; formula_artifact_id: string; formula_schema_id: string; formula_title: string | null;
        }[]>`
          select take_id, audio_url, take_title, duration_seconds::text, submission_id, adapter, suno_model,
                 formula_artifact_id, formula_schema_id, formula_title
          from public.xyp_resolve_take(${takeId})`;
        if (!row) throw new Error(`resolve_take: no take ${takeId}`);
        let mixReport: TakeChain['mixReport'] = null;
        if (mixId) {
          const [m] = await tx<{ schema_id: string }[]>`select schema_id from creative_artifacts where id = ${mixId}`;
          if (!m) throw new Error(`resolve_take: no artifact ${mixId}`);
          mixReport = { artifactId: mixId, schemaId: m.schema_id };
        }
        return {
          take: { id: row.take_id, audioUrl: row.audio_url, title: row.take_title, durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds) },
          submission: { id: row.submission_id, adapter: row.adapter, sunoModel: row.suno_model },
          formula: { artifactId: row.formula_artifact_id, schemaId: row.formula_schema_id, title: row.formula_title },
          mixReport,
        } satisfies TakeChain;
      });
    },
  });

export type ReleaseStatus = 'draft' | 'scheduled' | 'released';
export type SplitRow = { readonly payee: string | null; readonly percentage: number };
/** What read_catalog returns: one release, its tracks in order, each with its current split set. */
export type CatalogRecord = {
  readonly release: {
    readonly id: string; readonly title: string; readonly artist: string; readonly kind: string; readonly upc: string | null;
    readonly status: ReleaseStatus; readonly releaseDate: string | null; readonly rightsCheckRunId: string | null;
  };
  readonly tracks: ReadonlyArray<{
    readonly id: string; readonly position: number; readonly title: string; readonly isrc: string | null;
    /** The recording (AOS-02, B4): exactly one of a Suno take or a Vault audio file. */
    readonly takeId: string | null; readonly sourceId: string | null; readonly mixReportArtifactId: string | null;
    readonly splits: { readonly version: number; readonly rows: readonly SplitRow[] } | null;
  }>;
};

/**
 * read_catalog (catalog.read): a release, its tracks by position, and each track's current split set
 * (null when the track has none).
 * @param deps - pool; reads as xyp_runtime, read only
 * @returns the tool definition
 */
export const createReadCatalogTool = (deps: Deps): Tool =>
  defineTool({
    name: 'read_catalog',
    capability: 'catalog.read',
    description: 'One release with its tracks in order and each track\'s current rights split set.',
    handler: async (_ctx, args) => {
      const releaseId = uuid('read_catalog', 'releaseId', obj('read_catalog', args).releaseId);
      return asReader(deps.sql, async (tx) => {
        const [r] = await tx<{ id: string; title: string; artist: string; kind: string; upc: string | null; status: ReleaseStatus; release_date: string | null; rights_check_run_id: string | null }[]>`
          select id, title, artist, kind, upc, status::text as status, release_date::text, rights_check_run_id from releases where id = ${releaseId}`;
        if (!r) throw new Error(`read_catalog: no release ${releaseId}`);
        const tracks = await tx<{ id: string; position: number; title: string; isrc: string | null; take_id: string | null; source_id: string | null; mix_report_artifact_id: string | null }[]>`
          select id, position, title, isrc, take_id, source_id, mix_report_artifact_id from tracks where release_id = ${releaseId} order by position`;
        const splits = await tx<{ track_id: string; version: number; payee: string | null; percentage: string }[]>`
          select c.track_id, c.version, c.payee, c.percentage::text from current_rights_splits c
          join tracks t on t.id = c.track_id where t.release_id = ${releaseId} order by c.percentage desc, c.payee nulls last`;
        return {
          release: { id: r.id, title: r.title, artist: r.artist, kind: r.kind, upc: r.upc, status: r.status, releaseDate: r.release_date, rightsCheckRunId: r.rights_check_run_id },
          tracks: tracks.map((t) => {
            const own = splits.filter((s) => s.track_id === t.id);
            return {
              id: t.id, position: t.position, title: t.title, isrc: t.isrc, takeId: t.take_id, sourceId: t.source_id, mixReportArtifactId: t.mix_report_artifact_id,
              splits: own.length === 0 ? null : { version: own[0]!.version, rows: own.map((s) => ({ payee: s.payee, percentage: Number(s.percentage) })) },
            };
          }),
        } satisfies CatalogRecord;
      });
    },
  });

// ─── catalog writes (catalog.write, as xyp_catalog) ─────────────────────────────────────────────────

/** A fully specified registration: the catalog lookup's output, the catalog writer's input. */
export type Registration = {
  readonly release: { readonly id: string } | { readonly title: string; readonly artist: string; readonly kind: string };
  /** The recording is exactly one of a Suno take (takeId) or a Vault audio file (sourceId; AOS-02, B4). */
  readonly track: {
    readonly position: number; readonly title: string; readonly takeId: string | null; readonly sourceId: string | null;
    readonly mixReportArtifactId: string | null;
  };
};

/**
 * @param v - candidate registration
 * @returns the registration, shape-checked (the DB checks values)
 * @throws Error naming the first malformed field
 */
export const parseRegistration = (v: unknown): Registration => {
  const a = obj('registration', v);
  const release = obj('registration.release', a.release);
  const track = obj('registration.track', a.track);
  const r: Registration['release'] = 'id' in release
    ? { id: uuid('registration', 'release.id', release.id) }
    : { title: text('registration', 'release.title', release.title), artist: text('registration', 'release.artist', release.artist), kind: text('registration', 'release.kind', release.kind) };
  if (!Number.isInteger(track.position)) throw new Error('registration: track.position must be an integer');
  const given = (k: 'takeId' | 'sourceId') => track[k] !== undefined && track[k] !== null;
  if (given('takeId') === given('sourceId')) throw new Error('registration: the track needs exactly one of takeId, sourceId');
  return {
    release: r,
    track: {
      position: track.position as number,
      title: text('registration', 'track.title', track.title),
      takeId: given('takeId') ? uuid('registration', 'track.takeId', track.takeId) : null,
      sourceId: given('sourceId') ? uuid('registration', 'track.sourceId', track.sourceId) : null,
      mixReportArtifactId: track.mixReportArtifactId === undefined || track.mixReportArtifactId === null ? null : uuid('registration', 'track.mixReportArtifactId', track.mixReportArtifactId),
    },
  };
};

/**
 * register_track (catalog.write): one transaction — a new draft release when the registration names
 * none — and the track on it. The DB refuses a non-draft release, a taken position or take, and a
 * mix report link that is not a mix report.
 * @param deps - pool; writes as xyp_catalog
 * @returns the tool definition
 */
export const createRegisterTrackTool = (deps: Deps): Tool =>
  defineTool({
    name: 'register_track',
    capability: 'catalog.write',
    description: 'Register a finished recording (a Suno take or a Vault audio file) as a track, on an existing draft release or a new one.',
    handler: async (ctx, args) => {
      const reg = parseRegistration(args);
      return asRole(deps.sql, CATALOG_ROLE, async (tx) => {
        let releaseId: string;
        const createdRelease = !('id' in reg.release);
        if ('id' in reg.release) {
          releaseId = reg.release.id;
        } else {
          const [r] = await tx<{ id: string }[]>`
            insert into releases (title, artist, kind, agent_run_id)
            values (${reg.release.title}, ${reg.release.artist}, ${reg.release.kind}, ${ctx.runId}) returning id`;
          releaseId = r!.id;
        }
        const [t] = await tx<{ id: string }[]>`
          insert into tracks (release_id, position, title, take_id, source_id, mix_report_artifact_id, agent_run_id)
          values (${releaseId}, ${reg.track.position}, ${reg.track.title}, ${reg.track.takeId}, ${reg.track.sourceId}, ${reg.track.mixReportArtifactId}, ${ctx.runId})
          returning id`;
        const recording = reg.track.takeId ? `take ${reg.track.takeId}` : `Vault file ${reg.track.sourceId}`;
        ctx.log('info', `register_track: track ${t!.id} at position ${reg.track.position} on ${createdRelease ? 'new' : 'existing'} release ${releaseId} (${recording})`);
        return { releaseId, trackId: t!.id, createdRelease };
      });
    },
  });

/**
 * write_splits (catalog.write): the track's next split set, written whole in one transaction. The DB
 * refuses a set that doesn't sum to exactly 100 at commit, and an unassigned (null-payee) share once
 * the release is scheduled.
 * @param deps - pool; writes as xyp_catalog
 * @returns the tool definition
 */
export const createWriteSplitsTool = (deps: Deps): Tool =>
  defineTool({
    name: 'write_splits',
    capability: 'catalog.write',
    description: "Write a track's next rights split set (payee null = unassigned share); the set must sum to 100.",
    handler: async (ctx, args) => {
      const a = obj('write_splits', args);
      const trackId = uuid('write_splits', 'trackId', a.trackId);
      if (!Array.isArray(a.splits) || a.splits.length === 0) throw new Error('write_splits: splits must be a non-empty array');
      const rows: SplitRow[] = a.splits.map((s, i) => {
        const r = obj(`write_splits: splits[${i}]`, s);
        if (r.payee !== null && typeof r.payee !== 'string') throw new Error(`write_splits: splits[${i}].payee must be a string or null (unassigned)`);
        if (typeof r.percentage !== 'number' || !Number.isFinite(r.percentage)) throw new Error(`write_splits: splits[${i}].percentage must be a number`);
        return { payee: r.payee as string | null, percentage: r.percentage };
      });
      const version = await asRole(deps.sql, CATALOG_ROLE, async (tx) => {
        const [v] = await tx<{ next: number }[]>`select coalesce(max(version), 0) + 1 as next from rights_splits where track_id = ${trackId}`;
        for (const r of rows) {
          await tx`insert into rights_splits (track_id, version, payee, percentage, agent_run_id) values (${trackId}, ${v!.next}, ${r.payee}, ${r.percentage}, ${ctx.runId})`;
        }
        return v!.next;
      });
      // Thousandths, as the column stores them: no float drift in the reported share.
      const unassigned = rows.filter((r) => r.payee === null).reduce((s, r) => s + Math.round(r.percentage * 1000), 0) / 1000;
      ctx.log('info', `write_splits: track ${trackId} version ${version}, ${rows.length} row(s), unassigned ${unassigned}`);
      return { trackId, version, rows: rows.length, unassigned };
    },
  });

/**
 * assign_codes (catalog.write): exactly one of an ISRC on a track or a UPC on a release. The DB checks
 * the format (and the UPC's GS1 check digit) and refuses changing a code already assigned.
 * @param deps - pool; writes as xyp_catalog
 * @returns the tool definition
 */
export const createAssignCodesTool = (deps: Deps): Tool =>
  defineTool({
    name: 'assign_codes',
    capability: 'catalog.write',
    description: 'Assign an ISRC to a track ({trackId, isrc}) or a UPC to a release ({releaseId, upc}); once.',
    handler: async (ctx, args) => {
      const a = obj('assign_codes', args);
      const isTrack = a.trackId !== undefined;
      if (isTrack === (a.releaseId !== undefined) || (isTrack ? a.upc !== undefined : a.isrc !== undefined)) {
        throw new Error('assign_codes: exactly one of {trackId, isrc} or {releaseId, upc}');
      }
      if (isTrack) {
        const trackId = uuid('assign_codes', 'trackId', a.trackId);
        const isrc = text('assign_codes', 'isrc', a.isrc);
        const rows = await asRole(deps.sql, CATALOG_ROLE, (tx) => tx`update tracks set isrc = ${isrc} where id = ${trackId} returning id`);
        if (rows.length === 0) throw new Error(`assign_codes: no track ${trackId}`);
        ctx.log('info', `assign_codes: track ${trackId} ISRC ${isrc}`);
        return { trackId, isrc };
      }
      const releaseId = uuid('assign_codes', 'releaseId', a.releaseId);
      const upc = text('assign_codes', 'upc', a.upc);
      const rows = await asRole(deps.sql, CATALOG_ROLE, (tx) => tx`update releases set upc = ${upc} where id = ${releaseId} returning id`);
      if (rows.length === 0) throw new Error(`assign_codes: no release ${releaseId}`);
      ctx.log('info', `assign_codes: release ${releaseId} UPC ${upc}`);
      return { releaseId, upc };
    },
  });

// ─── the calendar (catalog.write, as xyp_release_calendar) ─────────────────────────────────────────

/**
 * schedule_release (catalog.write): schedule (date + the Rights run that cleared it), unschedule, or
 * mark released. The DB guard re-checks the release's splits, date and Rights run on every move into
 * scheduled/released, and refuses any other transition.
 * @param deps - pool; writes as xyp_release_calendar (status, date and rights run columns only)
 * @returns the tool definition
 */
export const createScheduleReleaseTool = (deps: Deps): Tool =>
  defineTool({
    name: 'schedule_release',
    capability: 'catalog.write',
    description: 'Move a release through the calendar: schedule (date, rights check run), unschedule, release.',
    handler: async (ctx, args) => {
      const a = obj('schedule_release', args);
      const releaseId = uuid('schedule_release', 'releaseId', a.releaseId);
      type Row = { id: string; status: ReleaseStatus; release_date: string | null };
      const rows = await asRole(deps.sql, CALENDAR_ROLE, async (tx): Promise<Row[]> => {
        switch (a.action) {
          case 'schedule': {
            const date = text('schedule_release', 'releaseDate', a.releaseDate);
            if (!ISO_DATE.test(date)) throw new Error('schedule_release: releaseDate must be YYYY-MM-DD');
            const runId = uuid('schedule_release', 'rightsCheckRunId', a.rightsCheckRunId);
            return tx<Row[]>`update releases set status = 'scheduled', release_date = ${date}::date, rights_check_run_id = ${runId}
              where id = ${releaseId} returning id, status::text as status, release_date::text`;
          }
          case 'unschedule':
            return tx<Row[]>`update releases set status = 'draft' where id = ${releaseId} returning id, status::text as status, release_date::text`;
          case 'release':
            return tx<Row[]>`update releases set status = 'released' where id = ${releaseId} returning id, status::text as status, release_date::text`;
          default:
            throw new Error(`schedule_release: action must be schedule, unschedule or release, not ${String(a.action)}`);
        }
      });
      const row = rows[0];
      if (!row) throw new Error(`schedule_release: no release ${releaseId}`);
      ctx.log('info', `schedule_release: ${String(a.action)} → release ${releaseId} is ${row.status}${row.release_date ? ` (${row.release_date})` : ''}`);
      return { releaseId, status: row.status, releaseDate: row.release_date };
    },
  });

/**
 * @param deps - pool the Records ops tools run through
 * @returns the six Records ops tools, for the runtime tool set
 */
export const createRecordsOpsTools = (deps: Deps): readonly Tool[] => [
  createResolveTakeTool(deps),
  createReadCatalogTool(deps),
  createRegisterTrackTool(deps),
  createWriteSplitsTool(deps),
  createAssignCodesTool(deps),
  createScheduleReleaseTool(deps),
];
