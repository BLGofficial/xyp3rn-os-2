import type { Sql } from '../../../core/db/client.ts';
import type { DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { runGate } from '../../../knowledge/promotion-gate/gate.ts';
import { loadEmbedder } from '../../../knowledge/vector-retrieval/embedder.ts';
import { embedPending } from '../../../knowledge/vector-retrieval/pipeline.ts';
import { retractResearchLink, type Brief, type ResearchTarget } from '../../../research-intelligence/brief.ts';
import { executeResearch, openResearch, sweepResearch } from '../../../research-intelligence/entrypoint.ts';
import { decideFinding, decidePromotion, promoteFinding } from '../../../research-intelligence/library.ts';
import type { CandidateInput } from '../../../research-intelligence/synthesis/findings.ts';
import { asWeb } from './loaders.ts';
import { songLink } from './ops.ts';

/**
 * Research's writes (AOS-04 §8). A run is opened here and awaited (so a bad brief comes back as the form's
 * error); its execution is started and NOT awaited (R5 on Next 14.2: `next start` is one long-lived Node
 * process, and executeResearch seals the run on every path). A server stop mid-run is the sweep's job.
 */

type Log = (line: string) => void;
const stderr: Log = (l) => console.error(l);

/**
 * Opens a brief, links its songs (a Records agent run each, A1), and starts the run in the background.
 * @param deps - the web's dispatch deps (with the LLM runner)
 * @param b - the brief, plus the songs it informs
 * @param log - where a background failure is reported (default stderr)
 * @returns the opened run's id, as soon as it is open
 * @throws Error "brief rejected: …" before any write
 */
export const startBrief = async (deps: DispatchDeps, b: Brief & { readonly songIds?: readonly string[] }, log: Log = stderr) => {
  await sweepResearch(deps.sql);
  const { songIds, ...brief } = b;
  const opened = await openResearch(deps, brief, { requireIntendedUse: true });
  for (const songId of songIds ?? []) await songLink(deps, { songId, researchQuestionId: opened.questionId });
  void executeResearch(deps, opened.researchRunId, { log }).catch((e: unknown) => log(`research run ${opened.researchRunId}: ${e instanceof Error ? e.message : String(e)}`));
  return { researchRunId: opened.researchRunId };
};

type RerunSource = { slug: string; question: string; intended_use: string | null; urls: string[]; specialists: string[] | null };
type LiveLink = { artifact_lineage_id: string | null; workflow_name: string | null; decision_key: string | null; role: string | null };

/**
 * A new run of a brief: a brief is immutable, so this is a new brief row with the same fields, its live
 * research links copied (workflows at their current spec) and its songs linked again.
 * @param deps - the web's dispatch deps
 * @param runId - any run of the brief
 * @param log - where a background failure is reported
 * @returns the new run's id
 */
export const rerun = async (deps: DispatchDeps, runId: string, log: Log = stderr) => {
  const { q, links, songs } = await asWeb(deps.sql, async (tx) => {
    const [src] = await tx<RerunSource[]>`
      select p.slug, q.question, q.intended_use, q.urls, q.specialists
      from research_runs r join research_questions q on q.id = r.question_id join research_projects p on p.id = q.project_id where r.id = ${runId}`;
    if (!src) throw new Error(`no research run ${runId}`);
    const l = await tx<LiveLink[]>`
      select l.artifact_lineage_id, l.workflow_name, l.decision_key, l.role
      from research_links l join research_runs r on r.question_id = l.question_id
      where r.id = ${runId} and not exists (select from research_link_retractions x where x.research_link_id = l.id)
      order by l.created_at, l.id`;
    const s = await tx<{ song_id: string }[]>`
      select distinct l.song_id from current_song_links l join research_runs r on r.question_id = l.research_question_id where r.id = ${runId}`;
    return { q: src, links: l, songs: s };
  });
  const role = (l: LiveLink) => (l.role ? { role: l.role } : {});
  const targets = links.map((l): ResearchTarget => (l.artifact_lineage_id ? { kind: 'lineage', artifactLineageId: l.artifact_lineage_id, ...role(l) }
    : l.workflow_name ? { kind: 'workflow', workflowName: l.workflow_name, ...role(l) }
      : { kind: 'decision', decisionKey: l.decision_key!, ...role(l) }));
  return startBrief(deps, {
    projectSlug: q.slug, question: q.question, intendedUse: q.intended_use ?? '', urls: q.urls, ...(q.specialists ? { specialists: q.specialists } : {}),
    targets, songIds: songs.map((s) => s.song_id),
  }, log);
};

/** The owner's accept/reject of a finding (the Findings Library; never canonical). */
export const decideFindingOp = (sql: Sql, findingId: string, decision: 'accept' | 'reject', reason: string, owner: string) =>
  decideFinding(sql, findingId, { decision, approver: owner, reason });

/** An accepted finding proposed for canonical: a candidate through the gate (pending the owner's approval, D2). */
export const promoteOp = (sql: Sql, input: CandidateInput) => promoteFinding(sql, input);

// As `pnpm gate decide`: re-run the gate, and embed a promotion so retrieval sees it straight away.
const propagate = async (sql: Sql, candidateId: string) => {
  const r = await runGate(sql, candidateId);
  if (r.outcome === 'promoted') await embedPending(sql, await loadEmbedder());
  return r;
};

/** The owner's decision on a pending canonical approval. */
export const decidePromotionOp = (sql: Sql, approvalId: string, decision: 'approve' | 'reject', reason: string, owner: string) =>
  decidePromotion(sql, approvalId, { decision, approver: owner, reason }, (id) => propagate(sql, id));

/** Unlinks a brief's research link (a retraction row; nothing is deleted). */
export const retractLinkOp = (sql: Sql, linkId: string, reason: string) => retractResearchLink(sql, linkId, reason);

/** At server boot (instrumentation.ts): seal runs a stopped server left running past their deadline. */
export const sweepOnBoot = (sql: Sql) => sweepResearch(sql);
