import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../core/db/client.ts';

/** Research writes run as xyp_research; verification/experiments as xyp_verifier (6C). */
export const RESEARCH_ROLE = 'xyp_research';
export const VERIFIER_ROLE = 'xyp_verifier';

/**
 * Runs fn in a transaction under a specific component role.
 * @param sql - pool allowed to SET ROLE
 * @param role - xyp_* role
 * @param fn - work to do as that role
 * @returns fn's result
 */
export const asRole = <T>(sql: Sql, role: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(role)}`);
    return fn(tx);
  }) as Promise<T>;
