import { parse as parseYaml } from 'yaml';
import type { Sql } from '../../core/db/client.ts';

/**
 * The operator's splits file and the one write path for splits (Phase 13). The file is checked for
 * shape here; the always-100 rule is the DB's (a deferred trigger at commit), so a replace is one
 * transaction: delete the track's splits, insert the new set, commit.
 */

export const SPLIT_ROLES = ['writer', 'producer', 'performer', 'publisher', 'other'] as const;
export type SplitRole = (typeof SPLIT_ROLES)[number];
export type SplitRow = { readonly payee: string; readonly role: SplitRole; readonly percentage: number };

const FIELDS = new Set(['payee', 'role', 'percentage']);

/**
 * @param text - YAML: `splits: [{ payee, role, percentage }]`
 * @returns the rows
 * @throws Error naming the first invalid field
 */
export const parseSplitsFile = (text: string): SplitRow[] => {
  const y = (parseYaml(text) ?? {}) as { splits?: unknown };
  if (!Array.isArray(y.splits) || y.splits.length === 0) throw new Error('splits must be a non-empty list');
  return y.splits.map((v, i): SplitRow => {
    const at = `splits[${i}]`;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${at} must be a mapping`);
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!FIELDS.has(k)) throw new Error(`${at}: unknown field: ${k}`);
    if (typeof o.payee !== 'string' || o.payee.trim() === '') throw new Error(`${at}.payee must be a non-empty string`);
    if (!SPLIT_ROLES.includes(o.role as SplitRole)) throw new Error(`${at}.role must be one of ${SPLIT_ROLES.join(', ')}`);
    if (typeof o.percentage !== 'number' || !Number.isFinite(o.percentage)) throw new Error(`${at}.percentage must be a number`);
    if (o.percentage <= 0 || o.percentage > 100) throw new Error(`${at}.percentage must be above 0 and at most 100`);
    // 33.33 * 100 is 3332.9999999999995 in floating point: compare with a tolerance, not ===.
    if (Math.abs(Math.round(o.percentage * 100) - o.percentage * 100) > 1e-6) throw new Error(`${at}.percentage has at most 2 decimals`);
    return { payee: o.payee.trim(), role: o.role as SplitRole, percentage: o.percentage };
  });
};

/**
 * Replaces a track's splits as the operator (service_role), in one transaction.
 * @param sql - pool allowed to SET ROLE service_role
 * @param trackId - tracks.id
 * @param rows - the full new split set
 * @returns the number of rows written
 * @throws the DB's rights_splits_sum_not_100 / splits_locked_after_schedule errors, unchanged
 */
export const replaceSplits = (sql: Sql, trackId: string, rows: readonly SplitRow[]): Promise<number> =>
  sql.begin(async (tx) => {
    await tx.unsafe('set local role service_role');
    await tx`delete from rights_splits where track_id = ${trackId}`;
    for (const r of rows) {
      await tx`insert into rights_splits (track_id, payee, role, percentage) values (${trackId}, ${r.payee}, ${r.role}::split_role, ${r.percentage})`;
    }
    return rows.length;
  }) as Promise<number>;
