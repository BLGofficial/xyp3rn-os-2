import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRole, createTestDb, expectPgError, withRollback, type TestDb } from '../helpers/db.ts';

// Phase 6A proof: research agents can add evidence and findings but never rewrite or delete
// them, and can only *propose* knowledge — enforced by DB grants + RLS, not application code.

const RESEARCH = 'xyp_research';
const RESEARCH_TABLES = [
  'contradictions',
  'experiment_runs',
  'experiments',
  'knowledge_candidates',
  'knowledge_versions',
  'research_evidence',
  'research_finding_evidence',
  'research_findings',
  'research_projects',
  'research_questions',
  'research_runs',
  'research_sources',
];

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('phase06a_research', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

/** One real chain row per table, inserted as the research role inside the caller's transaction. */
const chain = async (tx: postgres.TransactionSql) => {
  const one = async (q: Promise<{ id: string }[]>) => (await q)[0]!.id;
  const project = await one(tx`insert into research_projects (slug, title) values ('suno-vocal-control', 'Suno vocal control') returning id`);
  const question = await one(tx`insert into research_questions (project_id, question)
    values (${project}, 'What is the best current method for controlling dark baritone vocals in Suno?') returning id`);
  const run = await one(tx`insert into research_runs (question_id) values (${question}) returning id`);
  const source = await one(tx`insert into research_sources (research_run_id, kind, uri, title, content_sha256)
    values (${run}, 'web', 'https://example.org/suno-v45-notes', 'Suno v4.5 notes', ${'b'.repeat(64)}) returning id`);
  const evidence = await one(tx`insert into research_evidence (research_run_id, research_source_id, specialist, claim, model_tag, confidence, confidence_inputs)
    values (${run}, ${source}, 'suno-researcher', 'Placing the vocal descriptor first in the style prompt improves timbre adherence.', 'suno-v4.5', 0.6, '{"basis":"single source"}') returning id`);
  const finding = await one(tx`insert into research_findings (research_run_id, claim, model_tag, confidence, confidence_inputs)
    values (${run}, 'Lead the style prompt with the vocal descriptor for Suno v4.5.', 'suno-v4.5', 0.6, '{"evidence_count":1}') returning id`);
  await tx`insert into research_finding_evidence (finding_id, evidence_id) values (${finding}, ${evidence})`;
  const candidate = await one(tx`insert into knowledge_candidates (finding_id, proposed_kind, target_slug, title, body, model_tag, domain)
    values (${finding}, 'canonical_prompt', 'suno-vocal-descriptor-first', 'Vocal descriptor first', 'Lead the style prompt with the vocal descriptor.', 'suno-v4.5', 'RECORDS') returning id`);
  return { project, question, run, source, evidence, finding, candidate };
};

describe('schema', () => {
  it('creates the eleven research tables plus the finding↔evidence join', async () => {
    const rows = await db.sql<{ t: string }[]>`
      select tablename as t from pg_tables where schemaname = 'public' and tablename = any(${RESEARCH_TABLES}) order by 1`;
    expect(rows.map((r) => r.t)).toEqual(RESEARCH_TABLES);
  });

  it('wires the relationship chain as FKs: source → evidence → finding → candidate', async () => {
    const fks = await db.sql<{ tbl: string; col: string; ref: string }[]>`
      select c.conrelid::regclass::text as tbl, a.attname as col, c.confrelid::regclass::text as ref
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace order by 1, 2`;
    const has = (tbl: string, col: string, ref: string) => expect(fks).toContainEqual({ tbl, col, ref });
    has('research_sources', 'source_id', 'sources');
    has('research_evidence', 'research_source_id', 'research_sources');
    has('research_finding_evidence', 'evidence_id', 'research_evidence');
    has('research_finding_evidence', 'finding_id', 'research_findings');
    has('knowledge_candidates', 'finding_id', 'research_findings');
    has('contradictions', 'finding_id', 'research_findings');
    has('experiments', 'candidate_id', 'knowledge_candidates');
    has('experiment_runs', 'experiment_id', 'experiments');
    has('knowledge_versions', 'candidate_id', 'knowledge_candidates');
    has('agent_runs', 'research_run_id', 'research_runs');
  });

  it('rejects evidence missing source, model/version tag, confidence or claim (23502)', async () => {
    await withRollback(db.sql, async (tx) => {
      const ids = await chain(tx);
      for (const stmt of [
        `insert into research_evidence (research_run_id, specialist, claim, model_tag, confidence, confidence_inputs) values ('${ids.run}', 's', 'c', 'm', 0.5, '{}')`,
        `insert into research_evidence (research_run_id, research_source_id, specialist, claim, confidence, confidence_inputs) values ('${ids.run}', '${ids.source}', 's', 'c', 0.5, '{}')`,
        `insert into research_evidence (research_run_id, research_source_id, specialist, claim, model_tag, confidence_inputs) values ('${ids.run}', '${ids.source}', 's', 'c', 'm', '{}')`,
        `insert into research_evidence (research_run_id, research_source_id, specialist, model_tag, confidence, confidence_inputs) values ('${ids.run}', '${ids.source}', 's', 'm', 0.5, '{}')`,
      ]) {
        await expectPgError(() => tx.savepoint((sp) => sp.unsafe(stmt)), '23502');
      }
    });
  });
});

describe(`${RESEARCH}: INSERT-only on evidence and findings (grant level)`, () => {
  it('can write the whole chain up to a proposed candidate', async () => {
    await asRole(db.sql, RESEARCH, chain);
  });

  it.each([
    ['UPDATE research_evidence', `update research_evidence set confidence = 1`],
    ['DELETE research_evidence', `delete from research_evidence`],
    ['UPDATE research_findings', `update research_findings set claim = 'rewritten'`],
    ['DELETE research_findings', `delete from research_findings`],
    ['UPDATE research_sources', `update research_sources set title = 'x'`],
    ['UPDATE knowledge_candidates (status moves are the gate\'s)', `update knowledge_candidates set status = 'promoted'`],
    ['INSERT canonical_prompts', `insert into canonical_prompts (module_id, slug, title, body, promoted_via) select id, 'x', 'x', 'x', 'gate' from modules limit 1`],
    ['INSERT knowledge_versions', `insert into knowledge_versions (canonical_table, canonical_id, version, promoted_via, snapshot) values ('canonical_prompts', gen_random_uuid(), 1, 'gate', '{}')`],
    ['TRUNCATE research_evidence', `truncate research_evidence`],
  ])('is denied: %s (42501)', async (_label, stmt) => {
    await expectPgError(
      () =>
        asRole(db.sql, RESEARCH, async (tx) => {
          await chain(tx);
          await tx.unsafe(stmt);
        }),
      '42501',
    );
  });

  it('cannot insert a candidate in any status but proposed (RLS 42501)', async () => {
    await expectPgError(
      () =>
        asRole(db.sql, RESEARCH, async (tx) => {
          const ids = await chain(tx);
          await tx`insert into knowledge_candidates (finding_id, proposed_kind, target_slug, title, body, model_tag, domain, status)
                   values (${ids.finding}, 'canonical_prompt', 'sneaky', 'x', 'x', 'suno-v5', 'RECORDS', 'promoted')`;
        }),
      '42501',
    );
  });

  it('research_run_id on agent_runs is identity: runtime cannot re-link a run (42501)', async () => {
    await expectPgError(
      () =>
        asRole(db.sql, 'xyp_runtime', async (tx) => {
          await tx`insert into agent_runs (agent_name, input) values ('suno-researcher', '{}')`;
          await tx`update agent_runs set research_run_id = gen_random_uuid()`;
        }),
      '42501',
    );
  });
});
