import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUp } from '../../core/db/migrate.ts';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { seedFkProof } from '../../supabase/seed/fk-proof.ts';
import { asRole, createTestDb, expectPgError, plan, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// Phase 6D — written BEFORE the pipeline: no role except the Promotion Gate's service account
// (xyp_promotion) may INSERT/UPDATE canonical knowledge, and even the gate cannot overwrite.

const DENIED = ['xyp_research', 'xyp_ingest_bootstrap', 'xyp_runtime', 'xyp_verifier', 'xyp_embedder', 'service_role', 'anon', 'authenticated'];

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('phase06d_grants', { migrated: true });
  const r = await ingestSource(db.sql, { kind: 'file', path: join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), origin: 'first_party' });
  expect(r.status).toBe('success');
});
afterAll(async () => {
  await db?.drop();
});

describe('unauthorized roles attempting a direct canonical write are rejected (42501)', () => {
  it.each(DENIED)('%s: INSERT canonical_prompts / modules / knowledge_versions, UPDATE canonical body', async (role) => {
    for (const stmt of [
      `insert into canonical_prompts (module_id, slug, title, body, promoted_via, source_id)
         select m.id, 'direct-write', 'x', 'x', 'bootstrap', m.source_id from modules m limit 1`,
      `insert into modules (slug, title, domain, promoted_via, source_id) select 'direct-write', 'x', 'CORE', 'bootstrap', id from sources limit 1`,
      `insert into knowledge_versions (canonical_table, canonical_id, version, promoted_via, snapshot, approval)
         values ('canonical_prompts', gen_random_uuid(), 1, 'bootstrap', '{}', '{}')`,
      `update canonical_prompts set body = 'overwritten'`,
    ]) {
      await expectPgError(() => asRole(db.sql, role, (tx) => tx.unsafe(stmt)), '42501');
    }
  });
});

describe('xyp_promotion (the gate) appends canonical rows but can never overwrite or delete them', () => {
  it('may INSERT a new canonical version', async () => {
    await asRole(db.sql, 'xyp_promotion', (tx) => tx`
      insert into canonical_prompts (module_id, slug, version, title, body, promoted_via)
      select module_id, slug, version + 1, title, body, 'gate' from canonical_prompts where slug = 'phase-0-meta-prompt'`);
  });

  it('cannot commit a canonical row without its knowledge_versions row (23000, checked at commit)', async () => {
    // Committed transactions on purpose: the check is a deferred constraint trigger.
    const commitAsGate = (stmt: string) =>
      db.sql.begin(async (tx) => {
        await tx.unsafe('set local role xyp_promotion');
        await tx.unsafe(stmt);
      });
    await expectPgError(() => commitAsGate(`insert into modules (slug, title, domain, promoted_via) values ('no-history', 'x', 'CORE', 'gate')`), '23000');
    await expectPgError(() => commitAsGate(`
      insert into canonical_prompts (module_id, slug, version, title, body, promoted_via)
      select module_id, slug, version + 1, title, body, 'gate' from canonical_prompts where slug = 'phase-0-meta-prompt'`), '23000');
    expect(await db.sql`select 1 from modules where slug = 'no-history'`).toHaveLength(0);
  });

  it.each([
    ['UPDATE canonical_prompts', `update canonical_prompts set body = 'overwritten'`],
    ['UPDATE modules', `update modules set title = 'overwritten'`],
    ['DELETE canonical_prompts', `delete from canonical_prompts`],
    ['UPDATE knowledge_versions', `update knowledge_versions set snapshot = '{}'`],
    ['DELETE knowledge_versions', `delete from knowledge_versions`],
  ])('is denied: %s (42501)', async (_l, stmt) => {
    await expectPgError(() => asRole(db.sql, 'xyp_promotion', (tx) => tx.unsafe(stmt)), '42501');
  });
});

describe('catalog proof: which roles hold canonical write privileges at all', () => {
  // Every role in the cluster except superusers, pg_* built-ins and the tables' owner (migrations).
  const others = `not r.rolsuper and r.rolname !~ '^pg_' and r.oid <> c.relowner`;
  const TABLES = ['canonical_prompts', 'modules', 'knowledge_versions'];

  it('INSERT on canonical_prompts / modules / knowledge_versions: xyp_promotion and nobody else', async () => {
    const rows = await db.sql<{ role: string; t: string }[]>`
      select r.rolname::text as role, c.relname::text as t from pg_roles r cross join pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relname = any(${TABLES}) and ${db.sql.unsafe(others)}
        and has_table_privilege(r.oid, c.oid, 'INSERT')
      order by 1, 2`;
    expect(rows).toEqual(TABLES.slice().sort().map((t) => ({ role: 'xyp_promotion', t })));
  });

  it('UPDATE on any canonical content column: nobody; DELETE/TRUNCATE: nobody', async () => {
    const upd = await db.sql<{ role: string; t: string; col: string }[]>`
      select r.rolname::text as role, c.relname::text as t, a.attname::text as col
      from pg_roles r cross join pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where c.relnamespace = 'public'::regnamespace and c.relname = any(${TABLES}) and ${db.sql.unsafe(others)}
        and has_column_privilege(r.oid, c.oid, a.attnum, 'UPDATE')
      order by 1, 2, 3`;
    // The embedder's derived index columns are the only updatable ones (Phase 3) — never content.
    expect(upd).toEqual(
      ['embedded_at', 'embedding', 'embedding_input_sha256', 'embedding_model', 'embedding_truncated']
        .map((col) => ({ role: 'xyp_embedder', t: 'canonical_prompts', col })),
    );
    const del = await db.sql`
      select 1 from pg_roles r cross join pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relname = any(${TABLES}) and ${db.sql.unsafe(others)}
        and (has_table_privilege(r.oid, c.oid, 'DELETE') or has_table_privilege(r.oid, c.oid, 'TRUNCATE'))`;
    expect(del).toHaveLength(0);
  });

  it('the gate opens approvals but cannot insert a pre-decided one (42501)', async () => {
    await expectPgError(() => asRole(db.sql, 'xyp_promotion', (tx) => tx`
      insert into approval_queue (item_type, item_id, request, status, decided_at, decided_by, decision_reason)
      values ('knowledge_candidate', gen_random_uuid(), '{}', 'approved', now(), 'xyp_promotion', 'self-approval')`), '42501');
  });
});

describe('F1 closed: bootstrap rows get their history, and ingestion now goes through the gate', () => {
  it('backfills a knowledge_versions row for every canonical row written before the gate existed', async () => {
    const pre = await createTestDb('phase06d_backfill');
    try {
      const migrations = plan();
      const gateAt = migrations.findIndex((m) => m.name === 'promotion_gate');
      await migrateUp(pre.sql, migrations.slice(0, gateAt));
      // Pre-6D state: real bootstrap-written canonical rows (the Phase 1 seed, committed this time).
      await pre.sql.begin((tx) => seedFkProof(tx, REPO_ROOT));
      await migrateUp(pre.sql, migrations);
      const [c] = await pre.sql<{ rows: number; versions: number }[]>`
        select (select count(*)::int from canonical_prompts where promoted_via = 'bootstrap')
             + (select count(*)::int from modules where promoted_via = 'bootstrap') as rows,
               (select count(*)::int from knowledge_versions where promoted_via = 'bootstrap' and approval->>'mode' = 'bootstrap') as versions`;
      expect(c).toEqual({ rows: 2, versions: 2 });
    } finally {
      await pre.drop();
    }
  });

  it('post-6D ingestion writes canonical only through the gate (first-party admission), each row versioned', async () => {
    const [c] = await db.sql<{ gate_rows: number; bootstrap_rows: number; versions: number; runs: number }[]>`
      select (select count(*)::int from canonical_prompts where promoted_via = 'gate') + (select count(*)::int from modules where promoted_via = 'gate') as gate_rows,
             (select count(*)::int from canonical_prompts where promoted_via = 'bootstrap') as bootstrap_rows,
             (select count(*)::int from knowledge_versions where approval->>'mode' = 'first-party-ingest') as versions,
             (select count(*)::int from promotion_runs where mode = 'first_party_ingest' and outcome = 'promoted') as runs`;
    expect(c).toEqual({ gate_rows: 50, bootstrap_rows: 0, versions: 50, runs: 1 });
  });

  it('refuses a third-party document at the first-party admission step', async () => {
    const r = await ingestSource(db.sql, { kind: 'file', path: join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), origin: 'third_party' });
    expect(r.status).toBe('error');
    expect(r.error).toBe('first-party admission requires origin first_party; third-party material goes through Research Intelligence');
  });
});
