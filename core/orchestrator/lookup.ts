import type { Queryable } from '../db/client.ts';
import { createLlmClient } from '../llm/providers.ts';

/**
 * Tier 2: answers questions about data the OS already stored. Read-only: no run, no approval,
 * no write. Counts and statuses come from templates; open questions about research findings are
 * phrased by one small model call over the matched rows (when a summarizer is available).
 *
 * Topic order (first match wins) mirrors the spec, not the surface wording: a question that
 * mentions "find"/"found" is about research findings even if it also mentions releases or
 * approvals, so that check runs first. "research" + "run"/"status" (without "find") means the
 * research_runs ledger. Releases (including anything about scheduling) come next, then approvals
 * — including a bare "pending" that names none of the other topics — then workflow runs. Anything
 * left over is treated as an open research question.
 */

export type LookupAnswer = { readonly reply: string; readonly source: 'template' | 'model' | 'none' };
export type Summarize = (question: string, facts: string, signal?: AbortSignal) => Promise<string>;

const NONE: LookupAnswer = { reply: 'Nothing stored yet about that. Press Research (or say "research …") to start a run.', source: 'none' };
const NO_MATCH: LookupAnswer = { reply: 'No stored findings match that yet. Press Research (or say "research …") to start a research run.', source: 'none' };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const STOP = new Set(['what', 'which', 'about', 'latest', 'research', 'find', 'found', 'findings', 'there', 'their', 'would', 'should', 'yesterday', 'today']);

const RE_FIND = /\bfind(s|ings?)?\b|\bfound\b/;
const RE_RESEARCH = /\bresearch\b/;
const RE_RUN_OR_STATUS = /\b(runs?|status)\b/;
const RE_RELEASE = /\breleases?\b|\bschedul/;
const RE_APPROVAL = /\bapprovals?\b/;
const RE_PENDING = /\bpending\b/;
const RE_RUN_WORKFLOW = /\b(runs?|workflows?)\b/;
// Everything a bare "pending" could plausibly belong to instead of approvals.
const RE_OTHER_TOPIC = /\b(releases?|schedul|research|runs?|workflows?)\b/;

const approvalsAnswer = async (sql: Queryable): Promise<LookupAnswer> => {
  const rows = await sql<{ item_type: string }[]>`select item_type from approval_queue where status = 'pending' order by requested_at desc limit 5`;
  const countRows = await sql<{ n: number }[]>`select count(*)::int n from approval_queue where status = 'pending'`;
  const n = countRows[0]!.n;
  if (n === 0) return NONE;
  return { reply: `${plural(n, 'approval is', 'approvals are')} pending: ${rows.map(r => r.item_type).join(', ')}.`, source: 'template' };
};

const releasesAnswer = async (sql: Queryable): Promise<LookupAnswer> => {
  const rows = await sql<{ title: string; kind: string; status: string; release_date: string | null }[]>`
    select title, kind, status, to_char(release_date, 'YYYY-MM-DD') release_date from releases order by coalesce(release_date, created_at::date) desc limit 5`;
  if (rows.length === 0) return NONE;
  let reply = `Latest releases: ${rows.map(r => `${r.title} (${r.kind}, ${r.status}${r.release_date ? `, ${r.release_date}` : ''})`).join('; ')}.`;
  const pendingRows = await sql<{ n: number }[]>`select count(*)::int n from release_schedule_requests where applied_at is null`;
  const pending = pendingRows[0]!.n;
  if (pending > 0) reply += ` ${pending} schedule request(s) pending.`;
  return { reply, source: 'template' };
};

const workflowAnswer = async (sql: Queryable): Promise<LookupAnswer> => {
  const rows = await sql<{ workflow_name: string; status: string; failed_step: string | null }[]>`
    select workflow_name, status, failed_step from workflow_runs order by created_at desc limit 5`;
  if (rows.length === 0) return NONE;
  let reply = `Recent runs: ${rows.map(r => `${r.workflow_name} ${r.status}${r.failed_step ? ` at ${r.failed_step}` : ''}`).join('; ')}.`;
  const failedRows = await sql<{ n: number }[]>`select count(*)::int n from agent_runs where status = 'error' and created_at >= now() - interval '24 hours'`;
  const failed = failedRows[0]!.n;
  if (failed > 0) reply += ` ${failed} agent run(s) failed in the last 24 hours.`;
  return { reply, source: 'template' };
};

const researchRunsAnswer = async (sql: Queryable): Promise<LookupAnswer> => {
  const rows = await sql<{ status: string; selected_specialists: string[] }[]>`
    select status, selected_specialists from research_runs order by created_at desc limit 3`;
  if (rows.length === 0) return NONE;
  return { reply: `Latest research runs: ${rows.map(r => `${r.status} (${r.selected_specialists.length} specialists)`).join('; ')}.`, source: 'template' };
};

const findingsAnswer = async (sql: Queryable, question: string, summarize?: Summarize): Promise<LookupAnswer> => {
  const rows = await sql<{ claim: string; confidence: string }[]>`select claim, confidence::text from research_findings order by created_at desc limit 20`;
  if (rows.length === 0) return NONE;
  const words = question.toLowerCase().match(/[a-z]{5,}/g)?.filter(w => !STOP.has(w)) ?? [];
  let picked = rows.slice(0, 8);
  if (words.length > 0) {
    const matched = rows.filter(r => words.some(w => r.claim.toLowerCase().includes(w)));
    // Keywords were given but nothing stored answers them: say so plainly, never substitute
    // unrelated rows as if they did.
    if (matched.length === 0) return NO_MATCH;
    picked = matched.slice(0, 8);
  }
  const facts = picked.map(r => `- ${r.claim} (confidence ${r.confidence})`).join('\n');
  // Bounded so a stuck model call can't hang the request forever; a timeout rejects like any other
  // summarizer failure and lands in the caller's lookup-error catch (a fixed, safe reply).
  if (summarize) return { reply: await summarize(question, facts, AbortSignal.timeout(60_000)), source: 'model' };
  return { reply: `Latest findings: ${picked.slice(0, 3).map(r => r.claim).join(' ')}`, source: 'template' };
};

export const answerLookup = async (sql: Queryable, question: string, summarize?: Summarize): Promise<LookupAnswer> => {
  const q = question.toLowerCase();
  if (RE_FIND.test(q)) return findingsAnswer(sql, question, summarize);
  if (RE_RESEARCH.test(q) && RE_RUN_OR_STATUS.test(q)) return researchRunsAnswer(sql);
  if (RE_RELEASE.test(q)) return releasesAnswer(sql);
  if (RE_APPROVAL.test(q) || (RE_PENDING.test(q) && !RE_OTHER_TOPIC.test(q))) return approvalsAnswer(sql);
  if (RE_RUN_WORKFLOW.test(q)) return workflowAnswer(sql);
  return findingsAnswer(sql, question, summarize);
};

const MAX_ANSWER_LENGTH = 500;

/** Haiku summarizer, through the claude-code engine or the API, whichever is configured. */
export const summarizerFromEnv = (env: Readonly<Record<string, string | undefined>>): Summarize | undefined => {
  if (env.LLM_ENGINE !== 'claude-code' && !env.ANTHROPIC_API_KEY) return undefined;
  const llm = createLlmClient({ model: 'claude-haiku-4-5-20251001', agentName: 'mercury-lookup', env });
  return async (question, facts, signal) => {
    const r = await llm.complete({
      system: 'Answer the question using only the stored findings given. Plain sentences, at most 500 characters, suitable to be read aloud. If the findings do not answer it, say so.',
      user: `Question: ${question}\n\nStored findings:\n${facts}`,
      schema: { name: 'lookup_answer', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } },
      maxTokens: 800,
      ...(signal ? { signal } : {}),
    });
    const answer = (r.json as { answer: string }).answer;
    // Belt and braces: the prompt asks for at most 500 characters, but nothing stops a model from
    // ignoring it, and this may be read aloud.
    return answer.length > MAX_ANSWER_LENGTH ? `${answer.slice(0, MAX_ANSWER_LENGTH - 1)}…` : answer;
  };
};
