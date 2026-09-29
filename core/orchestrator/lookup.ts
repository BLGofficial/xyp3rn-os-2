import type { Queryable } from '../db/client.ts';
import { createLlmClient } from '../llm/providers.ts';

/**
 * Tier 2: answers questions about data the OS already stored. Read-only: no run, no approval,
 * no write. Counts and statuses come from templates; open questions about research findings are
 * phrased by one small model call over the matched rows (when a summarizer is available).
 */

export type LookupAnswer = { readonly reply: string; readonly source: 'template' | 'model' | 'none' };
export type Summarize = (question: string, facts: string) => Promise<string>;

const NONE: LookupAnswer = { reply: 'Nothing stored yet about that. Send it as a normal request to start a run.', source: 'none' };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const STOP = new Set(['what', 'which', 'about', 'latest', 'research', 'find', 'found', 'findings', 'there', 'their', 'would', 'should', 'yesterday', 'today']);

export const answerLookup = async (sql: Queryable, question: string, summarize?: Summarize): Promise<LookupAnswer> => {
  const q = question.toLowerCase();
  if (/\b(approvals?|pending)\b/.test(q)) {
    const rows = await sql<{ item_type: string }[]>`select item_type from approval_queue where status = 'pending' order by requested_at desc limit 5`;
    const countRows = await sql<{ n: number }[]>`select count(*)::int n from approval_queue where status = 'pending'`;
    const n = countRows[0]!.n;
    if (n === 0) return NONE;
    return { reply: `${plural(n, 'approval is', 'approvals are')} pending: ${rows.map(r => r.item_type).join(', ')}.`, source: 'template' };
  }
  if (/\breleases?\b/.test(q)) {
    const rows = await sql<{ title: string; kind: string; status: string; release_date: string | null }[]>`
      select title, kind, status, to_char(release_date, 'YYYY-MM-DD') release_date from releases order by coalesce(release_date, created_at::date) desc limit 5`;
    if (rows.length === 0) return NONE;
    return { reply: `Latest releases: ${rows.map(r => `${r.title} (${r.kind}, ${r.status}${r.release_date ? `, ${r.release_date}` : ''})`).join('; ')}.`, source: 'template' };
  }
  if (/\b(runs?|workflows?)\b/.test(q) && !/\bfind/.test(q)) {
    const rows = await sql<{ workflow_name: string; status: string; failed_step: string | null }[]>`
      select workflow_name, status, failed_step from workflow_runs order by created_at desc limit 5`;
    if (rows.length === 0) return NONE;
    return { reply: `Recent runs: ${rows.map(r => `${r.workflow_name} ${r.status}${r.failed_step ? ` at ${r.failed_step}` : ''}`).join('; ')}.`, source: 'template' };
  }
  const rows = await sql<{ claim: string; confidence: string }[]>`select claim, confidence::text from research_findings order by created_at desc limit 20`;
  const words = q.match(/[a-z]{5,}/g)?.filter(w => !STOP.has(w)) ?? [];
  const matched = words.length ? rows.filter(r => words.some(w => r.claim.toLowerCase().includes(w))) : rows;
  const picked = (matched.length ? matched : rows).slice(0, 8);
  if (picked.length === 0) return NONE;
  const facts = picked.map(r => `- ${r.claim} (confidence ${r.confidence})`).join('\n');
  if (summarize) return { reply: await summarize(question, facts), source: 'model' };
  return { reply: `Latest findings: ${picked.slice(0, 3).map(r => r.claim).join(' ')}`, source: 'template' };
};

/** Haiku summarizer, through the claude-code engine or the API, whichever is configured. */
export const summarizerFromEnv = (env: Readonly<Record<string, string | undefined>>): Summarize | undefined => {
  if (env.LLM_ENGINE !== 'claude-code' && !env.ANTHROPIC_API_KEY) return undefined;
  const llm = createLlmClient({ model: 'claude-haiku-4-5-20251001', agentName: 'mercury-lookup', env });
  return async (question, facts) => {
    const r = await llm.complete({
      system: 'Answer the question using only the stored findings given. Plain sentences, at most 500 characters, suitable to be read aloud. If the findings do not answer it, say so.',
      user: `Question: ${question}\n\nStored findings:\n${facts}`,
      schema: { name: 'lookup_answer', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } },
      maxTokens: 800,
    });
    return (r.json as { answer: string }).answer;
  };
};
