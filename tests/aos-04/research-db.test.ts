import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRole, createTestDb, expectPgError, type TestDb } from '../helpers/db.ts';
import { insertArtifact } from '../helpers/records-fixture.ts';
import { insertCanonical, insertSong } from '../helpers/research-fixture.ts';

// AOS-04 §4: the brief, the run deadline, research_links, kept sources and quotes, and the owner's
// finding decisions. Admin connection sets up; asRole checks what each component role may do.

let db: TestDb;
let questionId: string;
let runId: string;
let webSourceId: string;
beforeAll(async () => {
  db = await createTestDb('aos04_db', { migrated: true });
  const [p] = await db.sql<{ id: string }[]>`insert into research_projects (slug, title) values ('aos04-db', '[FIXTURE] aos04') returning id`;
  const [q] = await db.sql<{ id: string }[]>`
    insert into research_questions (project_id, question, intended_use, urls)
    values (${p!.id}, '[FIXTURE] Where should the vocal descriptor go in a Suno style prompt?', '[FIXTURE] pick the recipe order', ${['https://example.org/suno']})
    returning id`;
  questionId = q!.id;
  const [r] = await db.sql<{ id: string }[]>`insert into research_runs (question_id) values (${questionId}) returning id`;
  runId = r!.id;
  const [s] = await db.sql<{ id: string }[]>`
    insert into research_sources (research_run_id, kind, uri, title, content_sha256, text)
    values (${runId}, 'web', 'https://example.org/suno', '[FIXTURE] Suno notes', ${createHash('sha256').update(randomUUID()).digest('hex')},
            '[FIXTURE] Put the vocal descriptor   first in the style prompt; Suno weighs early words more.')
    returning id`;
  webSourceId = s!.id;
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const evidence = (tx: import('postgres').TransactionSql, quote: string | null) => tx`
  insert into research_evidence (research_run_id, research_source_id, specialist, claim, model_tag, confidence, confidence_inputs, quote)
  values (${runId}, ${webSourceId}, 'suno-researcher', '[FIXTURE] descriptor first', 'suno-v5', 0.6, ${tx.json({ basis: 'fixture' })}, ${quote})`;

describe('the brief (§4)', () => {
  it('stores intended use, urls and the owner override; refuses a non-http url and an empty override', async () => {
    const [q] = await db.sql<{ intended_use: string; urls: string[]; specialists: string[] | null }[]>`
      select intended_use, urls, specialists from research_questions where id = ${questionId}`;
    expect(q).toEqual({ intended_use: '[FIXTURE] pick the recipe order', urls: ['https://example.org/suno'], specialists: null });
    const [p] = await db.sql<{ id: string }[]>`select id from research_projects where slug = 'aos04-db'`;
    await expectPgError(() => db.sql`insert into research_questions (project_id, question, urls) values (${p!.id}, '[FIXTURE] x', ${['file:///etc/passwd']})`, '23514');
    await expectPgError(() => db.sql`insert into research_questions (project_id, question, specialists) values (${p!.id}, '[FIXTURE] x', ${[] as string[]})`, '23514');
  });

  it('keeps the brief immutable for xyp_research (only status is updatable)', async () => {
    await expectPgError(() => asRole(db.sql, 'xyp_research', (tx) => tx`update research_questions set intended_use = 'changed' where id = ${questionId}`), '42501');
  });
});

describe('the run deadline (§4)', () => {
  it('defaults expires_at to about ten minutes out and lets xyp_research raise it', async () => {
    const [r] = await db.sql<{ mins: number }[]>`select extract(epoch from expires_at - created_at) / 60 as mins from research_runs where id = ${runId}`;
    expect(Number(r!.mins)).toBeGreaterThan(9);
    expect(Number(r!.mins)).toBeLessThan(11);
    await asRole(db.sql, 'xyp_research', (tx) => tx`update research_runs set expires_at = now() + interval '1 hour' where id = ${runId}`);
  });
});

describe('kept sources and quotes (§4, §5)', () => {
  it('accepts a quote found verbatim (whitespace squashed) and a null quote (the human paths)', async () => {
    await asRole(db.sql, 'xyp_research', async (tx) => {
      await evidence(tx, 'Put the vocal descriptor first in the style prompt');
      await evidence(tx, null);
    });
  });

  it('refuses a quote the source does not contain, including a typographic variant', async () => {
    await expectPgError(() => asRole(db.sql, 'xyp_research', (tx) => evidence(tx, 'Put the vocal descriptor last')), '23514');
    await expectPgError(() => asRole(db.sql, 'xyp_research', (tx) => evidence(tx, 'Suno weighs early words more…')), '23514');
  });

  it('verifies a quote of an ingested source against the canonical bodies quoting it', async () => {
    const c = await insertCanonical(db.sql, { slug: 'fixture-suno-order', body: '[FIXTURE] Lead with the vocal descriptor.' });
    const [rs] = await db.sql<{ id: string }[]>`
      insert into research_sources (research_run_id, source_id, kind, uri, title, content_sha256)
      values (${runId}, ${c.sourceId}, 'ingested', 'file:///fixture/suno.md', '[FIXTURE] suno.md', ${c.checksum}) returning id`;
    await asRole(db.sql, 'xyp_research', (tx) => tx`
      insert into research_evidence (research_run_id, research_source_id, specialist, claim, model_tag, confidence, confidence_inputs, quote)
      values (${runId}, ${rs!.id}, 'suno-researcher', '[FIXTURE] lead with it', 'model-agnostic', 0.7, ${tx.json({ basis: 'fixture' })}, 'Lead with the vocal descriptor.')`);
  });
});

describe('research_links (R2)', () => {
  it('links a lineage root, a workflow and a decision; refuses a second target, a non-root, a bad key and a duplicate live link', async () => {
    const root = await insertArtifact(db.sql, 'x3lius.style-recipe/v1', { name: '[FIXTURE] recipe', style: '[FIXTURE] dark pop', excludeStyles: [], mood: [], production: [], notes: [] });
    await asRole(db.sql, 'xyp_research', async (tx) => {
      await tx`insert into research_links (question_id, artifact_lineage_id) values (${questionId}, ${root})`;
      await tx`insert into research_links (question_id, workflow_name, workflow_sha256) values (${questionId}, 'build-suno-package', ${'a'.repeat(64)})`;
      await tx`insert into research_links (question_id, decision_key, role) values (${questionId}, 'F41', 'informs')`;
      const t = await tx<{ kind: string; target: string }[]>`select kind, target from research_targets where question_id = ${questionId} order by kind`;
      expect(t.map((x) => x.kind)).toEqual(['decision', 'lineage', 'workflow']);
    });
    await expectPgError(() => db.sql`insert into research_links (question_id, decision_key, workflow_name, workflow_sha256) values (${questionId}, 'F1', 'x', ${'a'.repeat(64)})`, '23514');
    await expectPgError(() => db.sql`insert into research_links (question_id, decision_key) values (${questionId}, 'D2')`, '23514');
    await expectPgError(() => db.sql`insert into research_links (question_id, workflow_name) values (${questionId}, 'build-suno-package')`, '23514');
    await db.sql`insert into research_links (question_id, decision_key) values (${questionId}, 'F40')`;
    await expectPgError(() => db.sql`insert into research_links (question_id, decision_key) values (${questionId}, 'F40')`, '23505');
  });

  it('refuses a lineage link to a non-root version', async () => {
    const root = await insertArtifact(db.sql, 'x3lius.style-recipe/v1', { name: '[FIXTURE] recipe', style: '[FIXTURE] dark pop', excludeStyles: [], mood: [], production: [], notes: [] });
    const [v2] = await db.sql<{ id: string }[]>`
      insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model, lineage_id, version, parent_id)
      select schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model, id, 2, id from creative_artifacts where id = ${root}
      returning id`;
    await expectPgError(() => db.sql`insert into research_links (question_id, artifact_lineage_id) values (${questionId}, ${v2!.id})`, '23514');
  });

  it('retracts without deleting: the link leaves research_targets, and a re-link is then allowed', async () => {
    const [l] = await db.sql<{ id: string }[]>`insert into research_links (question_id, decision_key) values (${questionId}, 'F39') returning id`;
    await asRole(db.sql, 'xyp_research', (tx) => tx`insert into research_link_retractions (research_link_id, reason) values (${l!.id}, '[FIXTURE] wrong decision')`);
    await db.sql`insert into research_link_retractions (research_link_id, reason) values (${l!.id}, '[FIXTURE] wrong decision')`;
    expect(await db.sql`select 1 from research_targets where link_id = ${l!.id}`).toHaveLength(0);
    await db.sql`insert into research_links (question_id, decision_key) values (${questionId}, 'F39')`;
    await expectPgError(() => db.sql`update research_links set role = 'x' where id = ${l!.id}`, '55000');
    await expectPgError(() => db.sql`delete from research_links where id = ${l!.id}`, '55000');
  });

  it('shows songs that link the brief (song_links, A1) as song targets', async () => {
    const { songId, runId: songRun } = await insertSong(db.sql);
    await db.sql`insert into song_links (song_id, research_question_id, agent_run_id) values (${songId}, ${questionId}, ${songRun})`;
    const t = await db.sql<{ kind: string; target: string }[]>`select kind, target from research_targets where question_id = ${questionId} and kind = 'song'`;
    expect(t).toEqual([{ kind: 'song', target: songId }]);
    await asRole(db.sql, 'xyp_research', async (tx) => {
      expect(await tx`select 1 from research_targets where question_id = ${questionId} and kind = 'song'`).toHaveLength(1);
    });
  });
});

describe('the owner\'s finding decisions (R3)', () => {
  let findingId: string;
  beforeAll(async () => {
    const [f] = await db.sql<{ id: string }[]>`
      insert into research_findings (research_run_id, claim, model_tag, confidence, confidence_inputs, claim_topic, claim_value)
      values (${runId}, '[FIXTURE] descriptor first', 'suno-v5', 0.6, ${db.sql.json({ basis: 'fixture' })}, 'suno.vocal-descriptor-position', ${db.sql.json('first')})
      returning id`;
    findingId = f!.id;
  });

  it('records one decision as service_role, shows it in the library, refuses a second one and every other role', async () => {
    await expectPgError(() => asRole(db.sql, 'xyp_research', (tx) => tx`select xyp_decide_finding(${findingId}, 'accept', 'owner', 'x')`), '42501');
    await expectPgError(() => db.sql`select xyp_decide_finding(${findingId}, 'maybe', 'owner', 'x')`, '22023');
    await expectPgError(() => db.sql`select xyp_decide_finding(${findingId}, 'accept', 'owner', ' ')`, '22023');
    await asRole(db.sql, 'service_role', (tx) => tx`select xyp_decide_finding(${findingId}, 'accept', 'owner', '[FIXTURE] reusable')`);
    await db.sql`select xyp_decide_finding(${findingId}, 'accept', 'owner', '[FIXTURE] reusable')`;
    await expectPgError(() => db.sql`select xyp_decide_finding(${findingId}, 'reject', 'owner', '[FIXTURE] changed my mind')`, '23505');
    const lib = await db.sql<{ finding_id: string; canonical_status: string; evidence_count: number }[]>`
      select finding_id, canonical_status, evidence_count from findings_library`;
    expect(lib).toEqual([{ finding_id: findingId, canonical_status: 'none', evidence_count: 0 }]);
    const [d] = await db.sql<{ decision: string }[]>`select decision from current_finding_decisions where finding_id = ${findingId}`;
    expect(d!.decision).toBe('accept');
  });

  it('touches no canonical table', async () => {
    expect(await db.sql`select 1 from knowledge_candidates where finding_id = ${findingId}`).toHaveLength(0);
  });

  it('lets xyp_web read the library, the targets and the research chain', async () => {
    await asRole(db.sql, 'xyp_web', async (tx) => {
      await tx`select * from findings_library`;
      await tx`select * from research_targets`;
      await tx`select * from research_finding_evidence`;
      await tx`select * from contradictions`;
      await tx`select * from knowledge_candidates`;
      await tx`select * from current_finding_decisions`;
    });
  });
});
