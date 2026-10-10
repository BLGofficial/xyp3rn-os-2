import { basename } from 'node:path';
import type { Sql } from '../../../core/db/client.ts';
import { OPERATOR_ROLE } from '../../../knowledge/promotion-gate/gate.ts';
import { asRole } from '../../../knowledge/source-registry/vault-tools.ts';

/**
 * The Obsidian drafts the watcher staged (obsidian_findings), for the /vault explorer. Reads run as xyp_web; the one
 * write, "send to the Promotion Gate", is xyp_queue_obsidian_note as service_role and only queues a request: the
 * operator decides it, and only the gate writes canonical knowledge.
 */

export const DRAFT_GROUP = 'OBSIDIAN DRAFTS';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DraftRow = { id: string; source_path: string; domain: string; status: string; updated_at: Date; extracted_links: { target?: unknown }[] };
export type DraftNode = {
  readonly id: string; readonly label: string; readonly group: typeof DRAFT_GROUP; readonly dbPrimaryKey: string; readonly path: string;
  readonly metadata: { readonly kind: 'obsidian_draft'; readonly domain: string; readonly status: string; readonly draftId: string };
};

export const draftNode = (r: DraftRow): DraftNode => ({
  id: `obsidian:${r.id}`, label: basename(r.source_path, '.md'), group: DRAFT_GROUP, dbPrimaryKey: r.id, path: r.source_path,
  metadata: { kind: 'obsidian_draft', domain: r.domain, status: r.status, draftId: r.id },
});

/** Nodes for the drafts, and a `wikilink` edge wherever one draft links to another by note name. */
export const draftGraph = (rows: readonly DraftRow[]) => {
  const nodes = rows.map(draftNode);
  const byName = new Map(nodes.map((n) => [n.label.toLowerCase(), n.id]));
  const links = rows.flatMap((r) => (Array.isArray(r.extracted_links) ? r.extracted_links : []).flatMap((l) => {
    const to = typeof l.target === 'string' ? byName.get(basename(l.target).toLowerCase()) : undefined;
    return to && to !== `obsidian:${r.id}` ? [{ source: `obsidian:${r.id}`, target: to, relation: 'wikilink' }] : [];
  }));
  return { nodes, links };
};

export const listDrafts = (sql: Sql): Promise<DraftRow[]> =>
  asRole(sql, 'xyp_web', (tx) => tx<DraftRow[]>`
    select id, source_path, domain, status, updated_at, extracted_links from obsidian_findings order by updated_at desc limit 500`, 'read only');

/** Drafts staged or changed after `since`, oldest first (the live feed's poll). */
export const draftsSince = (sql: Sql, since: Date): Promise<DraftRow[]> =>
  asRole(sql, 'xyp_web', (tx) => tx<DraftRow[]>`
    select id, source_path, domain, status, updated_at, extracted_links from obsidian_findings where updated_at > ${since} order by updated_at limit 100`, 'read only');

export type DraftDetail = { readonly id: string; readonly sourcePath: string; readonly domain: string; readonly status: string; readonly rawContent: string; readonly contentHash: string; readonly updatedAt: string };

export const getDraft = async (sql: Sql, id: string): Promise<DraftDetail | null> => {
  if (!UUID.test(id)) return null;
  const [r] = await asRole(sql, 'xyp_web', (tx) => tx<{ id: string; source_path: string; domain: string; status: string; raw_content: string; content_hash: string; updated_at: Date }[]>`
    select id, source_path, domain, status, raw_content, content_hash, updated_at from obsidian_findings where id = ${id}`, 'read only');
  return r ? { id: r.id, sourcePath: r.source_path, domain: r.domain, status: r.status, rawContent: r.raw_content, contentHash: r.content_hash, updatedAt: r.updated_at.toISOString() } : null;
};

/**
 * The owner sends one staged note to the Promotion Gate's approval queue.
 * @throws with `code` 23505 when it was already queued, 55000 when it is no longer pending_approval, 23503 when it is unknown
 * @returns the approval_queue id
 */
export const queueDraft = (sql: Sql, id: string, approver: string, reason: string): Promise<string> =>
  asRole(sql, OPERATOR_ROLE, async (tx) => {
    const [q] = await tx<{ id: string }[]>`select xyp_queue_obsidian_note(${id}, ${approver}, ${reason})::text as id`;
    return q!.id;
  });
