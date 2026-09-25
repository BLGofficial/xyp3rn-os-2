import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../core/db/client.ts';
import { defineTool, type Tool } from '../../core/tool-registry/registry.ts';
import type { ReleaseView, ScheduleReport } from './schedulable.ts';

/**
 * Records ops tools (Phase 13). Each runs as its own DB role (migration 20260925110000), so a
 * class boundary is also a grant boundary: the DB refuses what the tool would not do.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const uuid = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw new Error(`${what} must be a uuid`);
  return v;
};
const as = <T>(sql: Sql, role: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(role)}`);
    return fn(tx);
  }) as Promise<T>;

type TrackInput = {
  title?: unknown; position?: unknown; durationSeconds?: unknown; artifactIds?: unknown; mixReportId?: unknown;
  source?: { sunoTakeId?: unknown; masterUri?: unknown; masterSha256?: unknown };
};

/**
 * register_track (capability catalog.write, as xyp_catalog): creates the release when asked, then the
 * track. ISRC/UPC stay null. The DB enforces one audio source, real links and draft-only additions.
 * @param deps - pool the write runs through
 * @returns the tool definition
 */
export const createRegisterTrackTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'register_track',
    capability: 'catalog.write',
    description: 'Register a finished track (a Suno take or a studio master) in the catalog, creating its release if asked. ISRC/UPC stay null until assigned.',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { releaseId?: unknown; release?: { title?: unknown; kind?: unknown }; track?: TrackInput };
      if ((a.releaseId === undefined) === (a.release === undefined)) throw new Error('register_track: give exactly one of releaseId or release');
      const t = a.track ?? {};
      const src = t.source ?? {};
      const take = src.sunoTakeId === undefined ? null : uuid(src.sunoTakeId, 'track.source.sunoTakeId');
      if (t.artifactIds !== undefined && !Array.isArray(t.artifactIds)) throw new Error('track.artifactIds must be a list of uuids');
      const artifactIds = ((t.artifactIds ?? []) as unknown[]).map((x, i) => uuid(x, `track.artifactIds[${i}]`));
      const out = await as(deps.sql, 'xyp_catalog', async (tx) => {
        const [r] = a.releaseId !== undefined
          ? await tx<{ id: string; status: string }[]>`select id, status::text from releases where id = ${uuid(a.releaseId, 'releaseId')}`
          : await tx<{ id: string; status: string }[]>`
              insert into releases (title, kind) values (${String(a.release!.title ?? '')}, ${String(a.release!.kind ?? '')}::release_kind)
              returning id, status::text`;
        if (!r) throw new Error(`register_track: no release ${String(a.releaseId)}`);
        const [tr] = await tx<{ id: string; position: number }[]>`
          insert into tracks (release_id, position, title, duration_seconds, suno_take_id, master_uri, master_sha256, artifact_ids, mix_report_id)
          values (${r.id}, ${Number(t.position)}, ${String(t.title ?? '')}, ${t.durationSeconds === undefined ? null : Number(t.durationSeconds)},
                  ${take}, ${src.masterUri === undefined ? null : String(src.masterUri)}, ${src.masterSha256 === undefined ? null : String(src.masterSha256)},
                  ${artifactIds}::uuid[], ${t.mixReportId === undefined ? null : uuid(t.mixReportId, 'track.mixReportId')})
          returning id, position`;
        return { release: r, track: tr! };
      });
      ctx.log('info', `register_track → release ${out.release.id} (${out.release.status}), track ${out.track.id} #${out.track.position}`);
      return out;
    },
  });

/**
 * One release with its tracks and splits, as the Rights and Calendar agents see it.
 * @param tx - any query runner allowed to SELECT the Records tables
 * @param releaseId - releases.id
 * @throws Error when the release does not exist
 */
export const readReleaseView = async (tx: postgres.TransactionSql | Sql, releaseId: string): Promise<ReleaseView> => {
  const [r] = await tx<{ id: string; title: string; status: string; release_date: string | null }[]>`
    select id, title, status::text, release_date::text from releases where id = ${releaseId}`;
  if (!r) throw new Error(`no release ${releaseId}`);
  const rows = await tx<{ id: string; position: number; title: string; payee: string | null; role: string | null; percentage: string | null }[]>`
    select t.id, t.position, t.title, s.payee, s.role::text, s.percentage::text
    from tracks t left join rights_splits s on s.track_id = t.id where t.release_id = ${releaseId} order by t.position, s.payee, s.role`;
  const tracks = new Map<string, { id: string; position: number; title: string; splits: { payee: string; role: string; percentage: number }[] }>();
  for (const x of rows) {
    const tr = tracks.get(x.id) ?? { id: x.id, position: x.position, title: x.title, splits: [] };
    if (x.payee !== null) tr.splits.push({ payee: x.payee, role: x.role!, percentage: Number(x.percentage) });
    tracks.set(x.id, tr);
  }
  return { id: r.id, title: r.title, status: r.status, releaseDate: r.release_date, tracks: [...tracks.values()] };
};

/**
 * read_release (capability records.read, read-only as xyp_runtime).
 * @param deps - pool the read runs through
 * @returns the tool definition
 */
export const createReadReleaseTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'read_release',
    capability: 'records.read',
    description: 'One release with its tracks and rights splits (read-only).',
    handler: async (_ctx, args) => {
      const id = uuid((args as { releaseId?: unknown } | null)?.releaseId, 'releaseId');
      return deps.sql.begin('read only', async (tx) => {
        await tx.unsafe(`set local role ${quoteIdent('xyp_runtime')}`);
        return readReleaseView(tx, id);
      });
    },
  });

/**
 * flag_release (capability governance.flag, as xyp_rights): appends a Records flag carrying the report.
 * @param deps - pool the write runs through
 * @returns the tool definition
 */
export const createFlagReleaseTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'flag_release',
    capability: 'governance.flag',
    description: 'Append a Records flag: why a release cannot be scheduled (append-only).',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { releaseId?: unknown; report?: ScheduleReport };
      const id = uuid(a.releaseId, 'releaseId');
      if (a.report === null || typeof a.report !== 'object' || Array.isArray(a.report)) throw new Error('flag_release: report must be an object');
      const [f] = await as(deps.sql, 'xyp_rights', (tx) => tx<{ id: string }[]>`
        insert into records_flags (release_id, agent_run_id, report) values (${id}, ${ctx.runId}, ${tx.json(a.report as unknown as postgres.JSONValue)}) returning id`);
      ctx.log('warn', `flag_release → ${f!.id} on release ${id}`);
      return { flag_id: f!.id };
    },
  });

/**
 * propose_schedule (capability schedule.propose, as xyp_calendar): sets the date and requests
 * scheduling; the operator's decision on approval_queue moves the release to scheduled.
 * @param deps - pool the write runs through
 * @returns the tool definition
 */
export const createProposeScheduleTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'propose_schedule',
    capability: 'schedule.propose',
    description: 'Set a draft release date and request scheduling; the operator approves or rejects it on the approval queue.',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { releaseId?: unknown; releaseDate?: unknown };
      const id = uuid(a.releaseId, 'releaseId');
      if (typeof a.releaseDate !== 'string' || !DATE.test(a.releaseDate)) throw new Error('propose_schedule: releaseDate must be YYYY-MM-DD');
      const approvalId = await as(deps.sql, 'xyp_calendar', async (tx) => {
        await tx`update releases set release_date = ${a.releaseDate as string} where id = ${id}`;
        return (await tx<{ id: string }[]>`select public.xyp_request_release_schedule(${id}) as id`)[0]!.id;
      });
      ctx.log('info', `propose_schedule → release ${id} on ${a.releaseDate}, approval ${approvalId}`);
      return { approvalId };
    },
  });
