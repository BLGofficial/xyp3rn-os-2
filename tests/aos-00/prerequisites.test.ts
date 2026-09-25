import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decide } from '../../knowledge/promotion-gate/decide.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

// AOS-00 prerequisites (docs/artist-os/AOS-00-baseline.md §4 P), before any AOS-01 table:
// - G20: service_role (the operator/app key) reads everything and writes nothing directly. Every
//   write goes through an xyp_* role, so every write has its agent run (SCHEMA.md: full grants were
//   "correct for Phase 1 only"). Decisions still go through xyp_decide_approval.
// - F35 D2: the Promotion Gate never auto-approves; every canonical change goes to the owner.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('aos00_prereq', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

describe('G20: service_role is read-only on every relation', () => {
  it('holds no privilege but SELECT on any table or view in public', async () => {
    const extra = await db.sql<{ rel: string; privs: string }[]>`
      select table_name as rel, string_agg(privilege_type, ',' order by privilege_type) as privs
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'service_role' and privilege_type <> 'SELECT'
      group by table_name order by table_name`;
    expect(extra).toEqual([]);
  });

  it('a table a future migration creates is read-only for service_role by default too', async () => {
    await db.sql.unsafe('create table public.aos00_probe (id int)');
    try {
      const [p] = await db.sql<{ privs: string | null }[]>`
        select string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'aos00_probe' and grantee = 'service_role'`;
      expect(p!.privs ?? '').not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE|TRIGGER|REFERENCES/);
    } finally {
      await db.sql.unsafe('drop table public.aos00_probe');
    }
  });

  it('can still read (RLS bypass) and still decide approvals through xyp_decide_approval', async () => {
    await db.sql.begin(async (tx) => {
      await tx.unsafe('set local role service_role');
      await tx`select 1 from sources limit 1`;
      await tx`select 1 from approval_queue limit 1`;
    });
    const [g] = await db.sql<{ ok: boolean }[]>`select has_function_privilege('service_role', 'public.xyp_decide_approval(uuid, text, text, text)', 'execute') as ok`;
    expect(g!.ok).toBe(true);
  });

  it('a direct write as service_role is refused (42501)', async () => {
    await expect(db.sql.begin(async (tx) => {
      await tx.unsafe('set local role service_role');
      await tx`insert into tags (slug, label) values ('aos00-probe', 'probe')`;
    })).rejects.toMatchObject({ code: '42501' });
    await expect(db.sql.begin(async (tx) => {
      await tx.unsafe('set local role service_role');
      await tx`truncate take_scores`;
    })).rejects.toMatchObject({ code: '42501' });
  });
});

describe('F35 D2: the Promotion Gate never auto-approves', () => {
  it('routes even a candidate meeting every former auto-approve condition to the owner, saying so', () => {
    const d = decide({ eligible: true, tagsConsistent: true, sourcesFresh: true, experimentValidated: true, confidence: 0.95 });
    expect(d.outcome).toBe('human');
    expect(d.reasons.join(' ')).toMatch(/every automatic condition holds.*owner decides/);
  });
});
