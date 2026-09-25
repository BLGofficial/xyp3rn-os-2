import type { Sql } from '../../core/db/client.ts';
import { defineTool, type Tool } from '../../core/tool-registry/registry.ts';
import { asRole, LANGUAGE, VAULT_ROLE } from '../../knowledge/source-registry/vault-tools.ts';

/**
 * Song tools (AOS-01, A1/A2): a song's revisions and its typed links, all vault.write, all as
 * xyp_vault. The DB enforces the rules (gap-free revisions, one target per link, a lineage root, one
 * live link per target, append-only); the tools check shape and surface the DB's refusal.
 */

type Deps = { readonly sql: Sql };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const obj = (tool: string, args: unknown): Record<string, unknown> => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${tool}: input must be an object`);
  return args as Record<string, unknown>;
};
const uuid = (tool: string, field: string, v: unknown): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw new Error(`${tool}: ${field} must be a uuid`);
  return v;
};

const SONG_FIELDS = ['title', 'artist', 'language', 'genre', 'status', 'notes'] as const;
type SongFields = { title: string; artist: string; language: string | null; genre: string | null; status: string; notes: string | null };

/**
 * write_song (vault.write): creates a song (no songId: title and artist required) or appends its
 * next revision (songId). A revision copies every field it is not given from the current one;
 * `null` clears a nullable field (language, genre, notes).
 * @param deps - pool; writes as xyp_vault
 * @returns the tool definition
 */
export const createWriteSongTool = (deps: Deps): Tool =>
  defineTool({
    name: 'write_song',
    capability: 'vault.write',
    description: 'Create a song or append its next revision (unspecified fields carried over).',
    handler: async (ctx, args) => {
      const a = obj('write_song', args);
      const unknown = Object.keys(a).filter((k) => k !== 'songId' && !(SONG_FIELDS as readonly string[]).includes(k));
      const errors = [
        ...(unknown.length > 0 ? [`unknown field ${unknown.join(', ')}`] : []),
        ...(['title', 'artist', 'status'] as const).filter((k) => a[k] !== undefined && typeof a[k] !== 'string').map((k) => `${k} must be a string`),
        ...(['genre', 'notes'] as const).filter((k) => a[k] !== undefined && a[k] !== null && typeof a[k] !== 'string').map((k) => `${k} must be a string or null`),
        ...(a.language === undefined || a.language === null || (typeof a.language === 'string' && LANGUAGE.test(a.language)) ? [] : ['language must be an ISO 639-1 code, "mixed", "und" or null']),
      ];
      if (errors.length > 0) throw new Error(`write_song rejected: ${errors.join('; ')}`);
      const given = Object.fromEntries(SONG_FIELDS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) as Partial<SongFields>;

      const out = await asRole(deps.sql, VAULT_ROLE, async (tx) => {
        let songId: string;
        let fields: SongFields;
        if (a.songId === undefined) {
          if (typeof given.title !== 'string' || typeof given.artist !== 'string') throw new Error('write_song: a new song needs a title and an artist');
          fields = { language: null, genre: null, status: 'idea', notes: null, ...given } as SongFields;
          songId = (await tx<{ id: string }[]>`insert into songs (agent_run_id) values (${ctx.runId}) returning id`)[0]!.id;
        } else {
          songId = uuid('write_song', 'songId', a.songId);
          // The revision trigger's lock, taken before reading: a concurrent revision can't commit
          // between our read and our insert and have its change silently undone by our copy.
          await tx`select pg_advisory_xact_lock(hashtext(${`xyp:song_revisions:${songId}`}))`;
          const [cur] = await tx<SongFields[]>`select title, artist, language, genre, status::text, notes from current_songs where id = ${songId}`;
          if (!cur) throw new Error(`write_song: no song ${songId}`);
          fields = { ...cur, ...given };
        }
        const [r] = await tx<{ revision: number }[]>`
          insert into song_revisions (song_id, title, artist, language, genre, status, notes, agent_run_id)
          values (${songId}, ${fields.title}, ${fields.artist}, ${fields.language}, ${fields.genre}, ${fields.status}::song_status, ${fields.notes}, ${ctx.runId})
          returning revision`;
        return { songId, revision: r!.revision };
      });
      ctx.log('info', `write_song → ${out.songId} revision ${out.revision}`);
      return out;
    },
  });

// Input key → song_links column, and the kind current_song_links reports for it.
const TARGETS = {
  artifactId: { column: 'artifact_lineage_id', kind: 'artifact_lineage' },
  sourceId: { column: 'source_id', kind: 'source' },
  takeId: { column: 'take_id', kind: 'take' },
  trackId: { column: 'track_id', kind: 'track' },
  researchQuestionId: { column: 'research_question_id', kind: 'research_question' },
} as const;
type TargetKey = keyof typeof TARGETS;

/**
 * link_song (vault.write): links a song to exactly one target. An artifact id may be any version:
 * the link is to its lineage (root id), so it follows the lineage's later versions.
 * @param deps - pool; resolves the root as xyp_runtime (read only), writes as xyp_vault
 * @returns the tool definition
 */
export const createLinkSongTool = (deps: Deps): Tool =>
  defineTool({
    name: 'link_song',
    capability: 'vault.write',
    description: 'Link a song to one artifact lineage, Vault file, take, track or research question.',
    handler: async (ctx, args) => {
      const a = obj('link_song', args);
      const songId = uuid('link_song', 'songId', a.songId);
      const keys = (Object.keys(TARGETS) as TargetKey[]).filter((k) => a[k] !== undefined && a[k] !== null);
      if (keys.length !== 1) throw new Error(`link_song: exactly one target (${Object.keys(TARGETS).join(', ')}), got ${keys.length}`);
      const key = keys[0]!;
      let targetId = uuid('link_song', key, a[key]);
      if (a.role !== undefined && a.role !== null && (typeof a.role !== 'string' || a.role.trim() === '')) throw new Error('link_song: role must be a non-empty string or null');
      const role = (a.role as string | null | undefined)?.trim() ?? null;
      if (key === 'artifactId') {
        const [r] = await asRole(deps.sql, 'xyp_runtime', (tx) => tx<{ lineage_id: string }[]>`
          select lineage_id from creative_artifacts where id = ${targetId}`, 'read only');
        if (!r) throw new Error(`link_song: no artifact ${targetId}`);
        targetId = r.lineage_id;
      }
      const { column, kind } = TARGETS[key];
      const out = await asRole(deps.sql, VAULT_ROLE, async (tx) => {
        const [r] = await tx<{ id: string }[]>`
          insert into song_links ${tx({ song_id: songId, role, [column]: targetId, agent_run_id: ctx.runId })}
          returning id`;
        return { linkId: r!.id, songId, kind, targetId, role };
      });
      ctx.log('info', `link_song → ${songId} ${kind} ${targetId}${role ? ` as ${role}` : ''}`);
      return out;
    },
  });

/**
 * unlink_song (vault.write): retracts a live link, with a reason. The link row stays (history).
 * @param deps - pool; writes as xyp_vault
 * @returns the tool definition
 */
export const createUnlinkSongTool = (deps: Deps): Tool =>
  defineTool({
    name: 'unlink_song',
    capability: 'vault.write',
    description: "Retract a song link with a reason (the link's history is kept).",
    handler: async (ctx, args) => {
      const a = obj('unlink_song', args);
      const linkId = uuid('unlink_song', 'linkId', a.linkId);
      if (typeof a.reason !== 'string' || a.reason.trim() === '') throw new Error('unlink_song: a reason is required');
      await asRole(deps.sql, VAULT_ROLE, (tx) => tx`
        insert into song_link_retractions (song_link_id, reason, agent_run_id) values (${linkId}, ${(a.reason as string).trim()}, ${ctx.runId})`);
      ctx.log('info', `unlink_song → ${linkId}`);
      return { linkId, retracted: true };
    },
  });

/**
 * The song tools, in registration order.
 * @param deps - pool
 * @returns write_song, link_song, unlink_song
 */
export const createSongTools = (deps: Deps): Tool[] => [createWriteSongTool(deps), createLinkSongTool(deps), createUnlinkSongTool(deps)];
