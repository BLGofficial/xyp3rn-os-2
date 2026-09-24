import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAINS } from '../../core/contracts/taxonomy.ts';
import { seedFkProof } from '../../supabase/seed/fk-proof.ts';
import { asRole, createTestDb, expectPgError, REPO_ROOT, withRollback, type TestDb } from '../helpers/db.ts';

// Phase 1 proof: the canonical base schema enforces its relationships in the DB,
// not by convention. Every negative case asserts the exact SQLSTATE.

const TABLES = [
  'canonical_prompts',
  'ingestion_runs',
  'modules',
  'prompt_tags',
  'prompt_variants',
  'quality_reports',
  'relations',
  'sources',
  'tags',
] as const;

type Tx = postgres.TransactionSql;
type Stmt = (sp: Tx) => Promise<unknown>;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('phase01_schema', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

/** Each negative case runs in its own savepoint so one expected failure doesn't abort the rest. */
const expectEach = async (tx: Tx, stmts: readonly Stmt[], code: string) => {
  for (const [i, stmt] of stmts.entries()) {
    await expectPgError(() => tx.savepoint(stmt), code).catch((e: Error) => {
      throw new Error(`case #${i}: ${e.message}`);
    });
  }
};

describe('tables', () => {
  it('creates exactly the nine canonical base tables in public', async () => {
    const rows = await db.sql<{ t: string }[]>`
      select tablename as t from pg_tables where schemaname = 'public' order by 1`;
    expect(rows.map((r) => r.t)).toEqual([...TABLES]);
  });
});

describe('foreign keys (catalog)', () => {
  // [table, column, referenced table, on-delete]: r = restrict (history is permanent), c = cascade (join rows only)
  const EXPECTED = [
    ['canonical_prompts', 'module_id', 'modules', 'r'],
    ['canonical_prompts', 'source_id', 'sources', 'r'],
    ['ingestion_runs', 'source_id', 'sources', 'r'],
    ['modules', 'source_id', 'sources', 'r'],
    ['prompt_tags', 'canonical_prompt_id', 'canonical_prompts', 'c'],
    ['prompt_tags', 'tag_id', 'tags', 'c'],
    ['prompt_variants', 'canonical_prompt_id', 'canonical_prompts', 'r'],
    ['quality_reports', 'canonical_prompt_id', 'canonical_prompts', 'r'],
    ['quality_reports', 'ingestion_run_id', 'ingestion_runs', 'r'],
    ['quality_reports', 'source_id', 'sources', 'r'],
  ];

  it('declares exactly the expected FK set with the expected on-delete action', async () => {
    const rows = await db.sql<{ tbl: string; col: string; ref: string; del: string }[]>`
      select c.conrelid::regclass::text as tbl, a.attname as col,
             c.confrelid::regclass::text as ref, c.confdeltype as del
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
      order by 1, 2`;
    expect(rows.map((r) => [r.tbl, r.col, r.ref, r.del])).toEqual(EXPECTED);
  });
});

describe('foreign keys (behavior)', () => {
  it('rejects every dangling reference with 23503', async () => {
    await withRollback(db.sql, async (tx) => {
      const ids = await seedFkProof(tx, REPO_ROOT);
      const ghost = randomUUID();
      await expectEach(
        tx,
        [
          (sp) => sp`insert into modules (slug, title, domain, source_id, promoted_via)
                     values ('ghost-module', 'x', 'CORE', ${ghost}, 'bootstrap')`,
          (sp) => sp`insert into canonical_prompts (module_id, slug, title, body, source_id, promoted_via)
                     values (${ghost}, 'ghost-a', 'x', 'x', ${ids.sourceId}, 'bootstrap')`,
          (sp) => sp`insert into canonical_prompts (module_id, slug, title, body, source_id, promoted_via)
                     values (${ids.moduleId}, 'ghost-b', 'x', 'x', ${ghost}, 'bootstrap')`,
          (sp) => sp`insert into prompt_variants (canonical_prompt_id, label, body) values (${ghost}, 'x', 'x')`,
          (sp) => sp`insert into prompt_tags (canonical_prompt_id, tag_id) values (${ghost}, ${ids.tagId})`,
          (sp) => sp`insert into prompt_tags (canonical_prompt_id, tag_id)
                     values (${ids.canonicalPromptId}, ${ghost})`,
          (sp) => sp`insert into ingestion_runs (requested_uri, source_id, status, completed_at)
                     values ('x', ${ghost}, 'success', now())`,
          (sp) => sp`insert into quality_reports (source_id, ingestion_run_id, rubric_version, criteria, overall)
                     values (${ids.sourceId}, ${ghost}, 'v', '[{"name":"x"}]', 0.5)`,
          (sp) => sp`insert into quality_reports (source_id, rubric_version, criteria, overall)
                     values (${ghost}, 'v', '[{"name":"x"}]', 0.5)`,
          (sp) => sp`insert into quality_reports (canonical_prompt_id, rubric_version, criteria, overall)
                     values (${ghost}, 'v', '[{"name":"x"}]', 0.5)`,
        ],
        '23503',
      );
    });
  });

  it('refuses to delete a source that canonical knowledge still references (restrict)', async () => {
    await withRollback(db.sql, async (tx) => {
      const ids = await seedFkProof(tx, REPO_ROOT);
      await expectEach(tx, [(sp) => sp`delete from sources where id = ${ids.sourceId}`], '23503');
    });
  });
});

describe('check + unique constraints', () => {
  it('enforces row-shape rules with 23514 check_violation', async () => {
    await withRollback(db.sql, async (tx) => {
      const ids = await seedFkProof(tx, REPO_ROOT);
      await expectEach(
        tx,
        [
          // quality report must target exactly one of source / canonical prompt
          (sp) => sp`insert into quality_reports (source_id, canonical_prompt_id, rubric_version, criteria, overall)
                     values (${ids.sourceId}, ${ids.canonicalPromptId}, 'v', '[{"name":"x"}]', 0.5)`,
          (sp) => sp`insert into quality_reports (rubric_version, criteria, overall)
                     values ('v', '[{"name":"x"}]', 0.5)`,
          // score must be within [0,1] and criteria a non-empty array: no score without its inputs
          (sp) => sp`insert into quality_reports (source_id, rubric_version, criteria, overall)
                     values (${ids.sourceId}, 'v', '[{"name":"x"}]', 1.5)`,
          (sp) => sp`insert into quality_reports (source_id, rubric_version, criteria, overall)
                     values (${ids.sourceId}, 'v', '[]', 0.5)`,
          // a running ingestion has no completed_at; a finished one must
          (sp) => sp`insert into ingestion_runs (requested_uri, status, completed_at) values ('x', 'running', now())`,
          (sp) => sp`insert into ingestion_runs (requested_uri, source_id, status) values ('x', ${ids.sourceId}, 'success')`,
          // an errored run carries its reason
          (sp) => sp`insert into ingestion_runs (requested_uri, status, completed_at) values ('x', 'error', now())`,
          // bootstrap-written canonical rows must trace to an ingested source (F1)
          (sp) => sp`insert into canonical_prompts (module_id, slug, title, body, promoted_via)
                     values (${ids.moduleId}, 'no-source', 'x', 'x', 'bootstrap')`,
          (sp) => sp`insert into modules (slug, title, domain, promoted_via)
                     values ('no-source', 'x', 'CORE', 'bootstrap')`,
          // checksum is a lowercase sha-256 hex digest
          (sp) => sp`insert into sources (kind, uri, title, checksum_sha256) values ('manual', 'x', 'x', 'not-a-hash')`,
          // slugs are kebab-case
          (sp) => sp`insert into tags (slug, label) values ('Not Kebab', 'x')`,
        ],
        '23514',
      );
    });
  });

  it('makes a source content-addressed: duplicate checksum is 23505 (Phase 2 idempotency relies on this)', async () => {
    await withRollback(db.sql, async (tx) => {
      const ids = await seedFkProof(tx, REPO_ROOT);
      const [src] = await tx<{ checksum_sha256: string }[]>`
        select checksum_sha256 from sources where id = ${ids.sourceId}`;
      await expectEach(
        tx,
        [
          (sp) => sp`insert into sources (kind, uri, title, checksum_sha256)
                     values ('file', 'copy.pdf', 'copy', ${src!.checksum_sha256})`,
        ],
        '23505',
      );
    });
  });
});

describe('enums', () => {
  it('xyp_domain mirrors core/contracts/taxonomy.ts DOMAINS exactly', async () => {
    const rows = await db.sql<{ v: string }[]>`
      select unnest(enum_range(null::xyp_domain))::text as v`;
    expect(rows.map((r) => r.v)).toEqual([...DOMAINS]);
  });
});

describe('updated_at triggers', () => {
  const MUTABLE = ['canonical_prompts', 'ingestion_runs', 'modules', 'prompt_variants', 'sources', 'tags'];

  it('exist on exactly the mutable tables', async () => {
    const rows = await db.sql<{ t: string }[]>`
      select event_object_table as t from information_schema.triggers
      where trigger_schema = 'public' and trigger_name like 'trg_%_updated_at' and event_manipulation = 'UPDATE'
      order by 1`;
    expect(rows.map((r) => r.t)).toEqual(MUTABLE);
  });

  it('bumps updated_at on update', async () => {
    await withRollback(db.sql, async (tx) => {
      const ids = await seedFkProof(tx, REPO_ROOT);
      // now() is frozen per transaction; the trigger uses clock time so in-transaction updates still move it
      const [row] = await tx<{ before: Date; after: Date }[]>`
        with before as (select updated_at from tags where id = ${ids.tagId})
        update tags set label = label || '' where id = ${ids.tagId}
        returning (select updated_at from before) as before, updated_at as after`;
      expect(row!.after.getTime()).toBeGreaterThan(row!.before.getTime());
    });
  });
});

describe('relations (polymorphic graph edges)', () => {
  it('has the two endpoint lookup indexes', async () => {
    const rows = await db.sql<{ n: string; d: string }[]>`
      select indexname as n, indexdef as d from pg_indexes
      where schemaname = 'public' and tablename = 'relations' order by 1`;
    const byName = Object.fromEntries(rows.map((r) => [r.n, r.d]));
    expect(byName.relations_subject_type_subject_id_idx).toMatch(/\(subject_type, subject_id\)/);
    expect(byName.relations_object_type_object_id_idx).toMatch(/\(object_type, object_id\)/);
  });

  it('rejects endpoints that do not exist (23503) and unknown entity types (22P02)', async () => {
    await withRollback(db.sql, async (tx) => {
      const ids = await seedFkProof(tx, REPO_ROOT);
      const ghost = randomUUID();
      await expectEach(
        tx,
        [
          (sp) => sp`insert into relations (subject_type, subject_id, predicate, object_type, object_id)
                     values ('canonical_prompt', ${ids.canonicalPromptId}, 'derived_from', 'source', ${ghost})`,
          (sp) => sp`insert into relations (subject_type, subject_id, predicate, object_type, object_id)
                     values ('canonical_prompt', 'not-a-uuid', 'derived_from', 'source', ${ids.sourceId})`,
          // file-backed endpoints: DB enforces the kebab-case name shape; the Agent Registry checks existence
          (sp) => sp`insert into relations (subject_type, subject_id, predicate, object_type, object_id)
                     values ('agent', 'Not An Agent', 'consumes', 'canonical_prompt', ${ids.canonicalPromptId})`,
        ],
        '23503',
      );
      await expectEach(
        tx,
        [
          (sp) => sp`insert into relations (subject_type, subject_id, predicate, object_type, object_id)
                     values ('spaceship', ${ghost}, 'derived_from', 'source', ${ids.sourceId})`,
        ],
        '22P02',
      );
    });
  });

  it('accepts a well-formed file-backed endpoint', async () => {
    await withRollback(db.sql, async (tx) => {
      const ids = await seedFkProof(tx, REPO_ROOT);
      await tx`insert into relations (subject_type, subject_id, predicate, object_type, object_id)
               values ('agent', 'health-check', 'consumes', 'canonical_prompt', ${ids.canonicalPromptId})`;
    });
  });

  it('surfaces edges orphaned by a later delete in relations_dangling', async () => {
    await withRollback(db.sql, async (tx) => {
      const ids = await seedFkProof(tx, REPO_ROOT);
      const [src] = await tx<{ id: string }[]>`
        insert into sources (kind, uri, title, checksum_sha256)
        values ('manual', 'manual:orphan-probe', 'orphan probe', ${'0'.repeat(64)}) returning id`;
      await tx`insert into relations (subject_type, subject_id, predicate, object_type, object_id)
               values ('canonical_prompt', ${ids.canonicalPromptId}, 'cites', 'source', ${src!.id})`;
      expect(await tx`select 1 from relations_dangling`).toHaveLength(0);
      await tx`delete from sources where id = ${src!.id}`;
      const dangling = await tx<{ object_id: string; object_missing: boolean }[]>`
        select object_id, object_missing from relations_dangling`;
      expect(dangling).toEqual([{ object_id: src!.id, object_missing: true }]);
    });
  });
});

describe('RLS + grants (single-tenant: default deny, service_role bypass)', () => {
  it('enables RLS on every public table and no policy ever reaches anon/authenticated/public', async () => {
    const rls = await db.sql<{ t: string; on: boolean }[]>`
      select relname as t, relrowsecurity as on from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`;
    expect(rls.filter((r) => !r.on).map((r) => r.t)).toEqual([]);
    // Policies exist only for named xyp_* component roles (Phase 2+), never for client-facing roles.
    expect(
      await db.sql`select 1 from pg_policies where schemaname = 'public'
                   and roles && array['anon', 'authenticated', 'public']::name[]`,
    ).toHaveLength(0);
  });

  it.each(['anon', 'authenticated'])('%s holds zero privileges on every public table, view and function', async (role) => {
    const rels = await db.sql<{ n: string }[]>`
      select c.relname as n from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v')
        and (has_table_privilege(${role}, c.oid, 'SELECT') or has_table_privilege(${role}, c.oid, 'INSERT')
          or has_table_privilege(${role}, c.oid, 'UPDATE') or has_table_privilege(${role}, c.oid, 'DELETE')
          or has_table_privilege(${role}, c.oid, 'TRUNCATE') or has_table_privilege(${role}, c.oid, 'REFERENCES')
          or has_table_privilege(${role}, c.oid, 'TRIGGER'))`;
    expect(rels.map((r) => r.n)).toEqual([]);
    const fns = await db.sql<{ n: string }[]>`
      select p.proname as n from pg_proc p
      where p.pronamespace = 'public'::regnamespace and has_function_privilege(${role}, p.oid, 'EXECUTE')`;
    expect(fns.map((r) => r.n)).toEqual([]);
  });

  it('denies anon a read (42501)', async () => {
    await expectPgError(() => asRole(db.sql, 'anon', (tx) => tx`select * from sources`), '42501');
  });

  it('lets service_role read and write (RLS bypass)', async () => {
    await asRole(db.sql, 'service_role', async (tx) => {
      await tx`insert into tags (slug, label) values ('service-role-probe', 'probe')`;
      expect(await tx`select 1 from tags where slug = 'service-role-probe'`).toHaveLength(1);
    });
  });
});
