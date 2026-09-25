import { arr, obj, str, type JsonSchema } from '../../core/llm/json-schema.ts';
import type { LlmProgram } from '../../core/llm/runner.ts';
import { RD_COMPONENTS, type BacklogItem, type FrontierEvidence, type RdComponent } from './tools.ts';

/**
 * tech-r-and-d (Phase 14, Planning, LLM): the R&D backlog. It reads the Frontier Scanner's evidence
 * not yet cited by the backlog, asks the model for candidate features, verifies every proposal in
 * code (the Critic's pattern, ARCHITECTURE F25), and writes the verified ones to rd_backlog, where
 * the DB queues each for a human. It never implements, schedules or approves anything: a human
 * decides what ships (approval_queue, `pnpm gate decide`).
 */

export const RD_AGENT = 'tech-r-and-d';
export const RD_BACKLOG_LLM_SCHEMA_ID = 'tech.rd-proposals-llm/v1';
/** Proposals past this many in one reply are dropped as unverified: a backlog, not a flood. */
export const MAX_PROPOSALS = 10;
const MAX_TITLE = 120;

export const RD_BACKLOG_LLM_SCHEMA: JsonSchema = obj({
  proposals: arr(obj({
    title: str(`A short feature name, at most ${MAX_TITLE} characters`),
    component: { type: 'string', enum: [...RD_COMPONENTS], description: 'The TECH component that would own it' },
    proposal: str('What to build: the feature, concretely'),
    rationale: str('Why, from the cited evidence; a vendor claim is a claim, not a verified fact'),
    evidenceIds: arr(str('An evidence id from the list, exactly as given')),
  })),
});

type Proposed = { title: string; component: string; proposal: string; rationale: string; evidenceIds: string[] };
export type Unverified = { readonly title: string; readonly reason: string };

const SYSTEM = `You are XYP3RN Tech's R&D planner (Planning class). From the Frontier Scanner's evidence below, propose candidate features for XYP3RN's own products and tools.
Rules:
- Cite only evidence ids from the list, written exactly as given; every proposal cites at least one.
- One feature per proposal. Propose; never commit: a human decides what ships.
- A tool's own announcement is a claim, not a verified fact: say "claims" when a rationale rests on one.
- component is one of: products (what XYP3RN ships to users), audio-tools (TRACE and other audio plugins), ai-systems (models, providers, agents), r-and-d (experiments to run first).
- Titles are short (at most ${MAX_TITLE} characters) and distinct. At most 5 proposals. No proposal that only restates a claim.`;

const line = (e: FrontierEvidence): string =>
  `[evidence:${e.id}] ${e.claim} — source: ${e.source.title} (${e.source.kind}, reliability ${e.source.reliability ?? 'unknown'}), tag ${e.modelTag}, confidence ${e.confidence}`;

/**
 * Verifies the model's proposals in code. Kept: well-formed, citing only evidence it was given, a
 * title no earlier proposal in the reply has. Everything else is dropped with its reason.
 * @param proposals - the model's reply
 * @param given - the evidence ids the prompt listed
 * @returns items to write, and the unverified with reasons, in reply order
 */
export const verifyProposals = (proposals: readonly Proposed[], given: ReadonlySet<string>): { items: BacklogItem[]; unverified: Unverified[] } => {
  const items: BacklogItem[] = [];
  const unverified: Unverified[] = [];
  const titles = new Set<string>();
  proposals.forEach((p, i) => {
    const title = p.title.trim();
    const key = title.toLowerCase();
    const bad = p.evidenceIds.filter((id) => !given.has(id));
    const reason =
      i >= MAX_PROPOSALS ? `over the ${MAX_PROPOSALS}-proposal cap`
        : title === '' || title.length > MAX_TITLE ? `title is blank or over ${MAX_TITLE} characters`
          : p.proposal.trim() === '' ? 'proposal is blank'
            : p.rationale.trim() === '' ? 'rationale is blank'
              : !(RD_COMPONENTS as readonly string[]).includes(p.component) ? `component ${p.component} is not a TECH component`
                : p.evidenceIds.length === 0 ? 'cites no evidence'
                  : bad.length > 0 ? `cites ${bad.join(', ')}, not among the evidence given`
                    : titles.has(key) ? 'repeats the title of another proposal in this reply'
                      : null;
    if (reason) {
      unverified.push({ title: p.title, reason });
      return;
    }
    titles.add(key);
    items.push({ title, component: p.component as RdComponent, proposal: p.proposal.trim(), rationale: p.rationale.trim(), evidenceIds: [...new Set(p.evidenceIds)] });
  });
  return { items, unverified };
};

/**
 * @param ctx - run context: read_frontier_evidence, write_rd_backlog, log_message
 * @param input - `{ request?: string, limit?: int }`; request steers the focus (what `pnpm ask` sends)
 * @param llm - the model client for this agent's frontmatter model
 * @returns `{ status, considered, written, duplicates, unverified }`
 */
export const rdBacklogProgram: LlmProgram = async (ctx, input, llm) => {
  const i = (input ?? {}) as { request?: unknown; limit?: unknown };
  if (i.request !== undefined && typeof i.request !== 'string') throw new Error(`${RD_AGENT}: request must be a string`);
  const read = (await ctx.useTool('read_frontier_evidence', i.limit === undefined ? {} : { limit: i.limit })) as { evidence: FrontierEvidence[]; alreadyCited: number };
  if (read.evidence.length === 0) {
    await ctx.useTool('log_message', { message: `${RD_AGENT}: no uncited Frontier Scanner evidence (${read.alreadyCited} already cited); no model call` });
    return { output: { status: 'no-frontier-evidence', considered: 0, written: [], duplicates: [], unverified: [] }, tokensUsed: 0 };
  }

  const focus = typeof i.request === 'string' && i.request.trim() !== '' ? i.request.trim() : 'none: propose from the evidence alone';
  const res = await llm.complete({
    system: SYSTEM,
    user: `FOCUS: ${focus}\nEVIDENCE (${read.evidence.length}):\n${read.evidence.map(line).join('\n')}`,
    schema: { name: RD_BACKLOG_LLM_SCHEMA_ID, schema: RD_BACKLOG_LLM_SCHEMA },
    signal: ctx.signal,
  });
  const { items, unverified } = verifyProposals((res.json as { proposals: Proposed[] }).proposals, new Set(read.evidence.map((e) => e.id)));
  for (const u of unverified) {
    await ctx.useTool('log_message', { level: 'warn', message: `${RD_AGENT}: dropped "${u.title}": ${u.reason}` });
  }
  const { written, duplicates } = items.length === 0
    ? { written: [], duplicates: [] }
    : ((await ctx.useTool('write_rd_backlog', { items, model: ctx.agent.model })) as { written: { id: string; title: string }[]; duplicates: string[] });
  await ctx.useTool('log_message', {
    message: `${RD_AGENT}: ${read.evidence.length} evidence considered; ${written.length} proposed (queued for a human), ${duplicates.length} duplicate(s), ${unverified.length} unverified`,
  });
  return {
    output: { status: 'proposed', considered: read.evidence.length, written, duplicates, unverified },
    tokensUsed: res.usage.inputTokens + res.usage.outputTokens,
  };
};
