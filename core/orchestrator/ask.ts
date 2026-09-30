import { runResearch, type ResearchResult } from '../../research-intelligence/entrypoint.ts';
import { runMusicSystem, type MusicSystemResult } from '../../records/x3lius/entrypoint.ts';
import { runTechSystem, type TechSystemResult } from '../../tech/entrypoint.ts';
import { hasLlmSteps, loadWorkflow, runWorkflow, type EngineDeps, type WorkflowResult } from '../workflow-engine/engine.ts';
import { LLM_TIMEOUT_MS } from '../llm/runner.ts';
import type { RequestPlan } from './orchestrate.ts';

/**
 * The OS front door after planning, shared by `ask-cli.ts` and Mercury's Ask (apps/web/server/ask-ops.ts).
 * Callers plan first (`planRequest`) and only build deps for a runnable plan.
 */

export type RunnablePlan = Extract<RequestPlan, { action: 'run-workflow' | 'run-service' }>;
export type AskResult =
  | { readonly kind: 'research'; readonly result: ResearchResult }
  | { readonly kind: 'music'; readonly result: MusicSystemResult }
  | { readonly kind: 'tech'; readonly result: TechSystemResult }
  | { readonly kind: 'workflow'; readonly result: WorkflowResult };

/**
 * Runs a routed plan through its domain entrypoint.
 * @param deps - live dispatch deps
 * @param plan - a run-workflow / run-service plan
 * @param options - `projectSlug` for research (default `ad-hoc`); `log` for workflow failure lines
 * @throws Error for an unknown entrypoint service
 */
export const runPlan = async (
  deps: EngineDeps,
  plan: RunnablePlan,
  options: { readonly projectSlug?: string; readonly log?: (line: string) => void } = {},
): Promise<AskResult> => {
  const log = options.log ? { log: options.log } : {};
  const request = plan.input.request;
  if (plan.action === 'run-workflow') {
    const wf = loadWorkflow(plan.workflow, deps.registry);
    // Mirrors `pnpm workflow`'s cli.ts: a workflow with any LLM-backed step gets the LLM per-step
    // timeout (dispatch's 30s default is for deterministic steps).
    return { kind: 'workflow', result: await runWorkflow(deps, wf, plan.input, { ...log, ...(hasLlmSteps(wf, deps.registry) ? { timeoutMs: LLM_TIMEOUT_MS } : {}) }) };
  }
  if (plan.service === 'run-research') {
    return { kind: 'research', result: await runResearch(deps, { question: request, projectSlug: options.projectSlug ?? 'ad-hoc' }, log) };
  }
  if (plan.service === 'x3lius-music-system') return { kind: 'music', result: await runMusicSystem(deps, { request }, log) };
  if (plan.service === 'tech-system') return { kind: 'tech', result: await runTechSystem(deps, { request }, log) };
  throw new Error(`unknown entrypoint service: ${plan.service}`);
};

/** True when the outcome should make a CLI exit non-zero. */
export const askFailed = (r: AskResult): boolean => (r.kind === 'music' || r.kind === 'tech' ? r.result.status !== 'success' : r.result.status === 'error');

export type AskRefs = {
  readonly workflowRunId?: string;
  readonly researchRunId?: string;
  readonly agentRunIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly approvalIds: readonly string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REFS = 20;

/**
 * Run, artifact and approval ids found in the real result. Only ids are lifted out of step outputs;
 * the outputs themselves (model text, tool payloads) are never returned.
 */
export const refsOf = (outcome: AskResult): AskRefs => {
  const artifacts = new Set<string>(); const approvals = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && UUID.test(x)) {
        if (k === 'approvalId' || k === 'approval_id') approvals.add(x);
        if (k === 'artifactId' || k === 'artifact_id') artifacts.add(x);
      }
      if (k === 'artifact' && x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' && UUID.test((x as { id: string }).id)) artifacts.add((x as { id: string }).id);
      walk(x, depth + 1);
    }
  };
  const r = outcome.result;
  if (outcome.kind === 'music' || outcome.kind === 'tech') walk(outcome.result.outputs, 0);
  if (outcome.kind === 'workflow') walk(outcome.result.output, 0);
  return {
    ...(r.workflowRunId ? { workflowRunId: r.workflowRunId } : {}),
    ...(outcome.kind === 'research' ? { researchRunId: outcome.result.researchRunId } : {}),
    agentRunIds: outcome.kind === 'workflow' ? outcome.result.steps.map((s) => s.agentRunId).slice(0, MAX_REFS) : [],
    artifactIds: [...artifacts].slice(0, MAX_REFS),
    approvalIds: [...approvals].slice(0, MAX_REFS),
  };
};

export const MAX_REPLY_CHARS = 600;
const stepOf = (error: string | undefined) => /^(?:specialist|sub-domain|component) step (\S+) failed/.exec(error ?? '')?.[1];

/**
 * Bounded plain-text reply for display and speech, built only from the real plan/result (no LLM).
 * Raw error text is left out: it can carry model output or provider detail; run ids point to it.
 * @param plan - the plan from `planRequest`
 * @param outcome - the entrypoint result (absent for hold / clarify)
 */
export const formatReply = (plan: RequestPlan, outcome?: AskResult): string => {
  const reply = (() => {
    if (plan.action === 'hold') return `On hold: ${plan.reason}.`;
    if (plan.action === 'clarify') return `Needs clarification: ${plan.reason}.`;
    if (!outcome) return 'No result.';
    const approvals = refsOf(outcome).approvalIds.length;
    const pending = approvals ? ` Approval required: ${approvals} item(s) pending in Governance.` : '';
    if (outcome.kind === 'research') {
      const r = outcome.result;
      if (r.status === 'success') return `Research run finished. Specialists: ${r.selected.join(', ') || 'none selected'}.${pending}`;
      const step = stepOf(r.error);
      return `Research run failed${step ? ` at specialist ${step}` : ''}. Details are on research run ${r.researchRunId}.`;
    }
    if (outcome.kind === 'music') {
      const r = outcome.result;
      if (r.status === 'success') return `X3LIUS music system finished. Sub-domains: ${r.selected.join(', ')}.${pending}`;
      if (r.status === 'clarify') return `Needs clarification: ${r.reason}.`;
      const step = stepOf(r.reason);
      return `X3LIUS music system failed${step ? ` at ${step}` : ''}.${r.workflowRunId ? ` Details are on workflow run ${r.workflowRunId}.` : ''}`;
    }
    if (outcome.kind === 'tech') {
      const r = outcome.result;
      if (r.status === 'success') return `Tech system finished. Components: ${r.selected.join(', ')}.${pending}`;
      if (r.status === 'clarify') return `Needs clarification: ${r.reason}.`;
      const step = stepOf(r.reason);
      return `Tech system failed${step ? ` at ${step}` : ''}.${r.workflowRunId ? ` Details are on workflow run ${r.workflowRunId}.` : ''}`;
    }
    const r = outcome.result;
    return r.status === 'success' ? `Workflow finished.${pending}` : `Workflow failed at ${r.failedStep ?? 'unknown step'}. Details are on workflow run ${r.workflowRunId}.`;
  })();
  return reply.length > MAX_REPLY_CHARS ? `${reply.slice(0, MAX_REPLY_CHARS - 1)}…` : reply;
};
