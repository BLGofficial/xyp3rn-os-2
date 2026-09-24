import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRole, createTestDb, expectPgError, type TestDb } from '../helpers/db.ts';

// Phase 2 proof: the bootstrap ingest role can append knowledge but can't rewrite or delete it.
// 6D revokes its canonical INSERT entirely (F1); until then this is the only non-gate writer.

const ROLE = 'xyp_ingest_bootstrap';
const HASH = 'a'.repeat(64);

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('phase02_grants', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

describe(`${ROLE}`, () => {
  it('exists with no superuser, no BYPASSRLS, no login', async () => {
    const [r] = await db.sql<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]>`
      select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = ${ROLE}`;
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
  });

  it('can register a source and open/close an ingestion run', async () => {
    await asRole(db.sql, ROLE, async (tx) => {
      const [s] = await tx<{ id: string }[]>`
        insert into sources (kind, uri, title, checksum_sha256) values ('manual', 'manual:grant-probe', 'probe', ${HASH})
        returning id`;
      const [run] = await tx<{ id: string }[]>`
        insert into ingestion_runs (requested_uri) values ('manual:grant-probe') returning id`;
      await tx`update ingestion_runs set status = 'success', completed_at = now(), source_id = ${s!.id}
               where id = ${run!.id}`;
    });
  });

  it.each([
    ['update canonical_prompts', `update canonical_prompts set body = 'x'`],
    ['update modules', `update modules set title = 'x'`],
    ['update sources', `update sources set title = 'x'`],
    ['delete sources', `delete from sources`],
    ['delete canonical_prompts', `delete from canonical_prompts`],
    ['delete relations', `delete from relations`],
    ['delete quality_reports', `delete from quality_reports`],
    ['truncate tags', `truncate tags`],
    ['rewrite an ingestion run request', `update ingestion_runs set requested_uri = 'x'`],
  ])('is denied: %s (42501)', async (_label, stmt) => {
    await expectPgError(() => asRole(db.sql, ROLE, (tx) => tx.unsafe(stmt)), '42501');
  });

  it('has row visibility only through explicit per-role policies, never anon/authenticated/public ones', async () => {
    const leaky = await db.sql`
      select tablename, policyname from pg_policies
      where schemaname = 'public' and roles && array['anon', 'authenticated', 'public']::name[]`;
    expect(leaky).toHaveLength(0);
    const mine = await db.sql<{ t: string }[]>`
      select distinct tablename as t from pg_policies where schemaname = 'public' and ${ROLE} = any (roles)
      order by 1`;
    expect(mine.map((r) => r.t)).toEqual([
      'canonical_prompts',
      'ingestion_runs',
      'modules',
      'prompt_tags',
      'quality_reports',
      'relations',
      'sources',
      'tags',
    ]);
  });
});
