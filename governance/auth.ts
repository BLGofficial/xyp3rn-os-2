import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from '../core/db/client.ts';

export type Identity = { id: string; name: string; role: string; permissions: string[] };
export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
export const authenticate = async (sql: Sql, token: string): Promise<Identity | null> => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return sql.begin('read only', async tx => {
    await tx`set local role xyp_web`;
    const [user] = await tx<Identity[]>`select * from xyp_session_identity(${tokenHash(token)})`;
    return user ?? null;
  }) as Promise<Identity | null>;
};
export const requirePermission = (identity: Identity, permission: string): void => {
  if (!identity.permissions.includes(permission)) throw new Error('Forbidden');
};

/** Operator-only provisioning, never exposed over HTTP. Tokens are random; only hashes enter the DB. */
export const provisionUser = async (sql: Sql, name: string, role: string) => {
  if (!name.trim() || name.length > 120) throw new Error('Valid display name required');
  const token = randomBytes(32).toString('base64url');
  const user = await sql.begin(async tx => {
    const [existing] = await tx<{ id: string; role_id: string }[]>`select id, role_id from governance_users where name = ${name}`;
    if (existing && existing.role_id !== role) throw new Error('Existing user role differs; change it explicitly in the role table');
    const [u] = existing ? [existing] : await tx<{ id: string }[]>`insert into governance_users (name, role_id) values (${name}, ${role}) returning id`;
    await tx`insert into governance_sessions (token_hash, user_id, expires_at) values (${tokenHash(token)}, ${u!.id}, now() + interval '8 hours')`;
    return u!;
  });
  return { id: user.id, token };
};

export const decideAuthenticated = (sql: Sql, token: string, approvalId: string, decision: string, reason: string) => sql.begin(async tx => {
  await tx`set local role xyp_web`;
  const [row] = await tx`select xyp_decide_authenticated_approval(${tokenHash(token)}, ${approvalId}, ${decision}, ${reason}) as result`;
  return row!.result;
});
