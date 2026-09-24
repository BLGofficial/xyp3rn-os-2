import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestSource } from '../../knowledge/ingestion/ingest.ts';
import { citeIngestedSource } from '../../research-intelligence/sources/verify.ts';
import { asRole as asRoleCommit } from '../../research-intelligence/db.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';

// Citing an already-ingested first-party document as research evidence (F9 link). The excerpt
// must appear verbatim in canonical text derived from that source — a citation can't invent text.

let db: TestDb;
let sourceId: string;
let researchRunId: string;

beforeAll(async () => {
  db = await createTestDb('phase06d_cite', { migrated: true });
  const r = await ingestSource(db.sql, { kind: 'file', path: join(REPO_ROOT, 'XYP3RN_Agentic_OS_Build_Sequence.pdf'), origin: 'first_party' });
  sourceId = r.sourceId!;
  researchRunId = await asRoleCommit(db.sql, 'xyp_research', async (tx) => {
    const [p] = await tx<{ id: string }[]>`insert into research_projects (slug, title) values ('x3lius-vocal-dna', 'X3LIUS vocal DNA') returning id`;
    const [q] = await tx<{ id: string }[]>`insert into research_questions (project_id, question) values (${p!.id}, 'Which voice-conversion model does the X3LIUS pipeline use?') returning id`;
    const [run] = await tx<{ id: string }[]>`insert into research_runs (question_id) values (${q!.id}) returning id`;
    return run!.id;
  });
});
afterAll(async () => {
  await db?.drop();
});

describe('citeIngestedSource', () => {
  it('registers the ingested document as a first-party research source (0.9), linked to sources', async () => {
    // Phase 10, wrapped across two PDF lines; matching ignores line breaks and spacing.
    const c = await citeIngestedSource(db.sql, {
      researchRunId, sourceId, excerpt: 'RVC/Applio voice model already exists for X3LIUS per your   audio pipeline',
    });
    expect(c).toMatchObject({ reliability: 0.9, class: 'first_party', citedIn: ['phase-10-meta-prompt'] });
    const [row] = await db.sql<{ kind: string; source_id: string; uri: string }[]>`select kind::text, source_id, uri from research_sources where id = ${c.id}`;
    expect(row).toEqual({ kind: 'ingested', source_id: sourceId, uri: 'XYP3RN_Agentic_OS_Build_Sequence.pdf' });
  });

  it('refuses an excerpt that is not in the document', async () => {
    await expect(citeIngestedSource(db.sql, { researchRunId, sourceId, excerpt: 'X3LIUS sings soft pop ballads' }))
      .rejects.toThrow(/not found verbatim/);
  });
});
