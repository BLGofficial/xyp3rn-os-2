import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from '../../core/db/client.ts';
import { asRole } from '../../research-intelligence/db.ts';
import { writeEvidence } from '../../research-intelligence/evidence/engine.ts';
import { registerResearchSource } from '../../research-intelligence/sources/verify.ts';

// Phase 14 fixtures: what the Frontier Scanner would have written (it has never run live: the 20
// specialists need an Anthropic key). Every row is [FIXTURE]; written through the real Phase 6
// engines as xyp_research, so the rows are shaped exactly like a specialist's.

export const FRONTIER_SPECIALIST = 'frontier-tool-scanner-researcher';

/** One research run to hang fixture evidence on. */
export const insertResearchRun = (sql: Sql): Promise<string> =>
  asRole(sql, 'xyp_research', async (tx) => {
    const slug = `fixture-${randomUUID().slice(0, 8)}`;
    const [p] = await tx<{ id: string }[]>`insert into research_projects (slug, title) values (${slug}, '[FIXTURE] frontier scan') returning id`;
    const [q] = await tx<{ id: string }[]>`insert into research_questions (project_id, question) values (${p!.id}, '[FIXTURE] What new AI audio tools launched?') returning id`;
    const [r] = await tx<{ id: string }[]>`insert into research_runs (question_id) values (${q!.id}) returning id`;
    return r!.id;
  });

/**
 * One piece of evidence and its source, as a specialist writes them.
 * @param sql - pool allowed to SET ROLE xyp_research
 * @param runId - research run
 * @param claim - the claim text ([FIXTURE] is prefixed)
 * @param specialist - who wrote it (default the Frontier Scanner)
 * @returns the research_evidence id
 */
export const insertEvidence = async (sql: Sql, runId: string, claim: string, specialist = FRONTIER_SPECIALIST): Promise<string> => {
  const text = `[FIXTURE] ${claim}`;
  const src = await registerResearchSource(sql, {
    researchRunId: runId, kind: 'doc', uri: `https://tools.example.org/${createHash('sha1').update(text).digest('hex').slice(0, 12)}`,
    title: `[FIXTURE] ${claim.slice(0, 40)}`, contentSha256: createHash('sha256').update(`${text}\n${randomUUID()}`).digest('hex'),
  });
  return writeEvidence(sql, { researchRunId: runId, agentRunId: null, specialist }, {
    research_source_id: src.id, claim: text, model_tag: 'model-agnostic', confidence: 0.4,
    confidence_inputs: { basis: 'synthetic fixture for the Phase 14 proof: a vendor announcement, not a verified observation' },
  });
};
