import type { Sql } from '../../core/db/client.ts';
import { defineTool, type Tool } from '../../core/tool-registry/registry.ts';
import { asRole, CATALOG_ROLE, obj, text, uuid } from './tools.ts';

/**
 * Catalog metadata tools (AOS-02, B1/B3; design §4.1, 4.3–4.5), all catalog.write, all as xyp_catalog:
 * people and aliases, credits, platform links, artwork and delivery status. The DB holds the rules
 * (one name namespace, one live credit or link per key, the URL host table, artwork is a Vault
 * image, append-only); the tools check shape and surface the DB's refusal as the error.
 */

type Deps = { readonly sql: Sql };

const optText = (tool: string, field: string, v: unknown): string | null => (v === undefined || v === null ? null : text(tool, field, v));

/** Exactly one of the given keys is set (not undefined, not null); returns it. */
const one = <K extends string>(tool: string, a: Record<string, unknown>, keys: readonly K[]): K => {
  const set = keys.filter((k) => a[k] !== undefined && a[k] !== null);
  if (set.length !== 1) throw new Error(`${tool}: exactly one of ${keys.join(', ')}`);
  return set[0]!;
};

/**
 * add_person (catalog.write): a collaborator. The name must be free in the one namespace of names
 * and aliases, case-insensitively.
 * @param deps - pool; writes as xyp_catalog
 * @returns the tool definition
 */
export const createAddPersonTool = (deps: Deps): Tool =>
  defineTool({
    name: 'add_person',
    capability: 'catalog.write',
    description: 'Add a collaborator by name (names and aliases share one case-insensitive namespace).',
    handler: async (ctx, args) => {
      const name = text('add_person', 'name', obj('add_person', args).name).trim();
      const [p] = await asRole(deps.sql, CATALOG_ROLE, (tx) => tx<{ id: string }[]>`
        insert into people (name, agent_run_id) values (${name}, ${ctx.runId}) returning id`);
      ctx.log('info', `add_person: ${name} → ${p!.id}`);
      return { personId: p!.id, name };
    },
  });

/**
 * add_alias (catalog.write): another spelling or name of a person ("x3lius" for X3LIUS).
 * @param deps - pool; writes as xyp_catalog
 * @returns the tool definition
 */
export const createAddAliasTool = (deps: Deps): Tool =>
  defineTool({
    name: 'add_alias',
    capability: 'catalog.write',
    description: "Add an alias to a person (another spelling or name that resolves to them).",
    handler: async (ctx, args) => {
      const a = obj('add_alias', args);
      const personId = uuid('add_alias', 'personId', a.personId);
      const alias = text('add_alias', 'alias', a.alias).trim();
      await asRole(deps.sql, CATALOG_ROLE, (tx) => tx`insert into person_aliases (person_id, alias, agent_run_id) values (${personId}, ${alias}, ${ctx.runId})`);
      ctx.log('info', `add_alias: ${alias} → ${personId}`);
      return { personId, alias };
    },
  });

/**
 * write_credit (catalog.write): a person's role on a song or a track. The person is given by id, or
 * by any of their names or aliases (case-insensitive); an unknown name is refused, never created.
 * @param deps - pool; writes as xyp_catalog
 * @returns the tool definition
 */
export const createWriteCreditTool = (deps: Deps): Tool =>
  defineTool({
    name: 'write_credit',
    capability: 'catalog.write',
    description: "Credit a person (by id or by name/alias) with a role on a song or a track.",
    handler: async (ctx, args) => {
      const a = obj('write_credit', args);
      const who = one('write_credit', a, ['personId', 'person'] as const);
      const target = one('write_credit', a, ['songId', 'trackId'] as const);
      const role = text('write_credit', 'role', a.role);
      const targetId = uuid('write_credit', target, a[target]);
      const note = optText('write_credit', 'note', a.note);
      const out = await asRole(deps.sql, CATALOG_ROLE, async (tx) => {
        let personId: string;
        if (who === 'personId') {
          personId = uuid('write_credit', 'personId', a.personId);
        } else {
          const name = text('write_credit', 'person', a.person).trim();
          const [p] = await tx<{ id: string }[]>`
            select id from people where lower(btrim(name)) = lower(${name})
            union select person_id from person_aliases where lower(btrim(alias)) = lower(${name})`;
          if (!p) throw new Error(`write_credit: no person named "${name}"; add them (or the alias) first`);
          personId = p.id;
        }
        const [c] = await tx<{ id: string }[]>`
          insert into credits (person_id, role, song_id, track_id, note, agent_run_id)
          values (${personId}, ${role}, ${target === 'songId' ? targetId : null}, ${target === 'trackId' ? targetId : null}, ${note}, ${ctx.runId})
          returning id`;
        return { creditId: c!.id, personId, role, [target]: targetId };
      });
      ctx.log('info', `write_credit: ${out.personId} ${role} on ${target.replace('Id', '')} ${targetId}`);
      return out;
    },
  });

/**
 * retract_credit (catalog.write): withdraws a live credit, with a reason. The credit row stays.
 * @param deps - pool; writes as xyp_catalog
 * @returns the tool definition
 */
export const createRetractCreditTool = (deps: Deps): Tool =>
  defineTool({
    name: 'retract_credit',
    capability: 'catalog.write',
    description: 'Retract a credit with a reason (its history is kept).',
    handler: async (ctx, args) => {
      const a = obj('retract_credit', args);
      const creditId = uuid('retract_credit', 'creditId', a.creditId);
      const reason = text('retract_credit', 'reason', a.reason).trim();
      if (reason === '') throw new Error('retract_credit: a reason is required');
      await asRole(deps.sql, CATALOG_ROLE, (tx) => tx`insert into credit_retractions (credit_id, reason, agent_run_id) values (${creditId}, ${reason}, ${ctx.runId})`);
      return { creditId, retracted: true };
    },
  });

/**
 * write_platform_link (catalog.write): where a release or a track lives on a platform. The DB checks
 * the platform list and that the URL is https on that platform's host.
 * @param deps - pool; writes as xyp_catalog
 * @returns the tool definition
 */
export const createWritePlatformLinkTool = (deps: Deps): Tool =>
  defineTool({
    name: 'write_platform_link',
    capability: 'catalog.write',
    description: "Record a release's or track's URL on a platform (Spotify, Apple Music, YouTube…); the host must match.",
    handler: async (ctx, args) => {
      const a = obj('write_platform_link', args);
      const target = one('write_platform_link', a, ['releaseId', 'trackId'] as const);
      const targetId = uuid('write_platform_link', target, a[target]);
      const platform = text('write_platform_link', 'platform', a.platform);
      const url = text('write_platform_link', 'url', a.url).trim();
      const [l] = await asRole(deps.sql, CATALOG_ROLE, (tx) => tx<{ id: string }[]>`
        insert into platform_links (platform, url, release_id, track_id, agent_run_id)
        values (${platform}, ${url}, ${target === 'releaseId' ? targetId : null}, ${target === 'trackId' ? targetId : null}, ${ctx.runId})
        returning id`);
      ctx.log('info', `write_platform_link: ${platform} ${url} on ${target.replace('Id', '')} ${targetId}`);
      return { linkId: l!.id, platform, url, [target]: targetId };
    },
  });

/**
 * retract_platform_link (catalog.write): withdraws a live link, with a reason. The row stays.
 * @param deps - pool; writes as xyp_catalog
 * @returns the tool definition
 */
export const createRetractPlatformLinkTool = (deps: Deps): Tool =>
  defineTool({
    name: 'retract_platform_link',
    capability: 'catalog.write',
    description: 'Retract a platform link with a reason (its history is kept).',
    handler: async (ctx, args) => {
      const a = obj('retract_platform_link', args);
      const linkId = uuid('retract_platform_link', 'linkId', a.linkId);
      const reason = text('retract_platform_link', 'reason', a.reason).trim();
      if (reason === '') throw new Error('retract_platform_link: a reason is required');
      await asRole(deps.sql, CATALOG_ROLE, (tx) => tx`
        insert into platform_link_retractions (platform_link_id, reason, agent_run_id) values (${linkId}, ${reason}, ${ctx.runId})`);
      return { linkId, retracted: true };
    },
  });

/**
 * set_artwork (catalog.write): a release's artwork, a Vault image. The newest row is current; earlier
 * covers stay as history.
 * @param deps - pool; writes as xyp_catalog
 * @returns the tool definition
 */
export const createSetArtworkTool = (deps: Deps): Tool =>
  defineTool({
    name: 'set_artwork',
    capability: 'catalog.write',
    description: "Set a release's artwork to a Vault image (the previous one stays as history).",
    handler: async (ctx, args) => {
      const a = obj('set_artwork', args);
      const releaseId = uuid('set_artwork', 'releaseId', a.releaseId);
      const sourceId = uuid('set_artwork', 'sourceId', a.sourceId);
      await asRole(deps.sql, CATALOG_ROLE, (tx) => tx`insert into release_artwork (release_id, source_id, agent_run_id) values (${releaseId}, ${sourceId}, ${ctx.runId})`);
      ctx.log('info', `set_artwork: release ${releaseId} ← Vault image ${sourceId}`);
      return { releaseId, sourceId };
    },
  });

/**
 * record_delivery (catalog.write): a distributor's status for a release, as the owner reports it
 * (no distributor is connected; AOS-06).
 * @param deps - pool; writes as xyp_catalog
 * @returns the tool definition
 */
export const createRecordDeliveryTool = (deps: Deps): Tool =>
  defineTool({
    name: 'record_delivery',
    capability: 'catalog.write',
    description: "Record a distributor's delivery status for a release (submitted, in_review, approved, live, rejected, takedown…).",
    handler: async (ctx, args) => {
      const a = obj('record_delivery', args);
      const releaseId = uuid('record_delivery', 'releaseId', a.releaseId);
      const distributor = text('record_delivery', 'distributor', a.distributor).trim();
      const status = text('record_delivery', 'status', a.status);
      const note = optText('record_delivery', 'note', a.note);
      await asRole(deps.sql, CATALOG_ROLE, (tx) => tx`
        insert into release_deliveries (release_id, distributor, status, note, agent_run_id) values (${releaseId}, ${distributor}, ${status}, ${note}, ${ctx.runId})`);
      ctx.log('info', `record_delivery: release ${releaseId} ${distributor} → ${status}`);
      return { releaseId, distributor, status };
    },
  });

/**
 * @param deps - pool
 * @returns the eight catalog metadata tools
 */
export const createCatalogMetadataTools = (deps: Deps): readonly Tool[] => [
  createAddPersonTool(deps), createAddAliasTool(deps), createWriteCreditTool(deps), createRetractCreditTool(deps),
  createWritePlatformLinkTool(deps), createRetractPlatformLinkTool(deps), createSetArtworkTool(deps), createRecordDeliveryTool(deps),
];
