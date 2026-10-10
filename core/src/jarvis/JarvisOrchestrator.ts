import { runGate, type GateResult } from '../../../knowledge/promotion-gate/gate.ts';
import type { ContextEngine } from '../../context-engine/context-engine.ts';
import { askFailed, formatReply, refsOf, runPlan } from '../../orchestrator/ask.ts';
import { dispatch, type DispatchDeps } from '../../orchestrator/dispatch.ts';
import { ENTRYPOINTS, planDirect, planRequest, type RequestPlan } from '../../orchestrator/orchestrate.ts';
import type { RoutableDomain } from '../../orchestrator/router.ts';
import { loadWorkflow, runWorkflow } from '../../workflow-engine/engine.ts';
import { MONDAY_REVIEW, runMondayReview, spokenSummary } from '../playbooks/monday-review.ts';

// Jarvis is the single front door: every CLI, HTTP and voice command is handed to interceptAndExecute(), which
// wraps the existing `pnpm ask` / `dispatch` / `workflow` machinery rather than reimplementing it.

export type JarvisSource = 'cli' | 'http' | 'voice';

export type JarvisRequest =
  | { readonly type: 'ask'; readonly request: string; readonly domain?: RoutableDomain; readonly workflow?: string; readonly projectSlug?: string }
  | { readonly type: 'dispatch'; readonly agent: string; readonly input: unknown }
  | { readonly type: 'workflow'; readonly path: string; readonly input: Readonly<Record<string, unknown>> }
  /** A canonical write attempt: a knowledge candidate headed for canonical knowledge. */
  | { readonly type: 'canonical-write'; readonly candidateId: string };

export type JarvisStatus = 'OK' | 'ERROR' | 'HOLD' | 'CLARIFY' | 'BLOCKED' | 'PENDING_HUMAN_APPROVAL';

export type JarvisContext =
  | { readonly available: true; readonly knowledgeItems: number; readonly vaultItems: number }
  | { readonly available: false; readonly reason: string };

export type JarvisResult = {
  readonly status: JarvisStatus;
  /** Butler-toned, bounded, built from the real result (no LLM). */
  readonly summary: string;
  readonly source: JarvisSource;
  readonly context?: JarvisContext;
  readonly approvalIds?: readonly string[];
  readonly data?: unknown;
};

export type JarvisDeps = DispatchDeps & {
  /** Context Engine over the gte-small embedder; injected so tests need no model. */
  readonly engine: Pick<ContextEngine, 'retrieve'>;
  readonly gate?: (sql: DispatchDeps['sql'], candidateId: string) => Promise<GateResult>;
};

const BUTLER_MAX_CHARS = 600;

/** The personality layer: one concise, formal line over a result. Never adds facts. */
export const butler = (status: JarvisStatus, detail: string): string => {
  const lead: Record<JarvisStatus, string> = {
    OK: 'Done, sir.',
    ERROR: 'My apologies, sir, that did not go to plan.',
    HOLD: 'I have held that, sir.',
    CLARIFY: 'A word of clarification, if I may, sir.',
    BLOCKED: 'I am afraid that is blocked, sir.',
    PENDING_HUMAN_APPROVAL: 'This awaits your approval, sir.',
  };
  return `${lead[status]} ${detail}`.trim().slice(0, BUTLER_MAX_CHARS);
};

export class JarvisCore {
  private readonly deps: JarvisDeps;

  constructor(deps: JarvisDeps) {
    this.deps = deps;
  }

  async interceptAndExecute(source: JarvisSource, req: JarvisRequest): Promise<JarvisResult> {
    try {
      switch (req.type) {
        case 'ask': return await this.ask(source, req);
        case 'dispatch': return await this.dispatchAgent(source, req.agent, req.input);
        case 'workflow': return await this.workflow(source, req.path, req.input);
        case 'canonical-write': return await this.canonicalWrite(source, req.candidateId);
      }
    } catch (e) {
      return { status: 'ERROR', source, summary: butler('ERROR', (e as Error).message.slice(0, 300)) };
    }
  }

  // knowledge + vault retrieval before any subagent runs. A model/DB hiccup degrades to "unavailable"; it never
  // blocks the command, because the downstream entrypoints retrieve for themselves.
  private async contextualize(query: string): Promise<JarvisContext> {
    try {
      const [knowledge, vault] = await Promise.all([this.deps.engine.retrieve(query), this.deps.engine.retrieve(query, { corpus: 'vault' })]);
      return { available: true, knowledgeItems: knowledge.items.length, vaultItems: vault.items.length };
    } catch (e) {
      return { available: false, reason: (e as Error).message.slice(0, 200) };
    }
  }

  private async ask(source: JarvisSource, req: Extract<JarvisRequest, { type: 'ask' }>): Promise<JarvisResult> {
    if (MONDAY_REVIEW.test(req.request)) {
      const review = await runMondayReview(this.deps.sql);
      return { status: 'OK', source, data: review, summary: butler('OK', spokenSummary(review)) };
    }
    const context = await this.contextualize(req.request);
    const plan: RequestPlan = req.domain ? planDirect(req.request, { domain: req.domain })
      : req.workflow ? planDirect(req.request, { workflow: req.workflow })
      : planRequest(req.request, ENTRYPOINTS);
    if (plan.action === 'hold' || plan.action === 'clarify') {
      const status = plan.action === 'hold' ? 'HOLD' : 'CLARIFY';
      return { status, source, context, summary: butler(status, plan.reason) };
    }
    const outcome = await runPlan(this.deps, plan, { projectSlug: req.projectSlug ?? 'ad-hoc' });
    const approvalIds = refsOf(outcome).approvalIds;
    if (approvalIds.length) {
      return { status: 'PENDING_HUMAN_APPROVAL', source, context, approvalIds, data: outcome.result, summary: butler('PENDING_HUMAN_APPROVAL', formatReply(plan, outcome)) };
    }
    const status = askFailed(outcome) ? 'ERROR' : 'OK';
    return { status, source, context, data: outcome.result, summary: butler(status, formatReply(plan, outcome)) };
  }

  private async dispatchAgent(source: JarvisSource, agent: string, input: unknown): Promise<JarvisResult> {
    const r = await dispatch(this.deps, agent, input);
    const status = r.status === 'success' ? 'OK' : 'ERROR';
    return { status, source, data: r, summary: butler(status, status === 'OK' ? `${agent} finished (run ${r.runId}).` : `${agent} failed; details are on run ${r.runId}.`) };
  }

  private async workflow(source: JarvisSource, path: string, input: Readonly<Record<string, unknown>>): Promise<JarvisResult> {
    const wf = loadWorkflow(path, this.deps.registry);
    const r = await runWorkflow(this.deps, wf, input);
    const status = r.status === 'success' ? 'OK' : 'ERROR';
    return { status, source, data: r, summary: butler(status, status === 'OK' ? `${wf.name} finished (run ${r.workflowRunId}).` : `${wf.name} failed${r.failedStep ? ` at ${r.failedStep}` : ''}; details are on run ${r.workflowRunId}.`) };
  }

  // The human-approval invariant (F35 D2). Jarvis never writes canonical knowledge or inserts into approval_queue
  // itself (only the gate's own role may, and each row must point at a real item). It sends the candidate to the
  // Promotion Gate, which queues it for the owner, and it refuses to report a promotion the owner did not approve.
  private async canonicalWrite(source: JarvisSource, candidateId: string): Promise<JarvisResult> {
    const r = await (this.deps.gate ?? runGate)(this.deps.sql, candidateId);
    const why = r.reasons.join('; ').slice(0, 300);
    switch (r.outcome) {
      case 'pending_approval':
        return { status: 'PENDING_HUMAN_APPROVAL', source, approvalIds: r.approvalId ? [r.approvalId] : [], data: r, summary: butler('PENDING_HUMAN_APPROVAL', `Candidate ${candidateId} is queued as approval ${r.approvalId}.`) };
      case 'blocked':
      case 'rejected':
        return { status: 'BLOCKED', source, data: r, summary: butler('BLOCKED', `Candidate ${candidateId} was ${r.outcome} by the gate: ${why}`) };
      default:
        return { status: 'ERROR', source, data: r, summary: butler('ERROR', `The gate reported a promotion for ${candidateId} without a human decision. I will not relay it; please inspect run ${r.promotionRunId}.`) };
    }
  }
}
