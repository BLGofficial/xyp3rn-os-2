import type postgres from 'postgres';
import { stringify as toYaml } from 'yaml';
import { quoteIdent } from '../core/db/client.ts';
import { dispatch } from '../core/orchestrator/dispatch.ts';
import { LLM_TIMEOUT_MS } from '../core/llm/runner.ts';
import { compileWorkflow, runWorkflow, type EngineDeps } from '../core/workflow-engine/engine.ts';
import type { ResearchPlan } from './orchestrator/select.ts';

/**
 * Research Intelligence entrypoint (Phase 6A): the runtime side of the Research Orchestrator.
 * The orchestrator agent decides; this function executes, through the Workflow Engine, and
 * keeps the research tables consistent. Research-table writes run as xyp_research.
 *
 *   question → research_questions + research_runs(running)
 *   → dispatch research-orchestrator (roster in, plan out)          [agent_runs, linked]
 *   → runWorkflow(plan) — one step per selected specialist          [agent_runs, linked]
 *   → research_runs sealed as success | error (with the reason)
 */

export const RESEARCH_ROLE = 'xyp_research';
export const ORCHESTRATOR_AGENT = 'research-orchestrator';

export type ResearchResult = {
  readonly researchRunId: string;
  readonly status: 'success' | 'error';
  readonly selected: readonly string[];
  readonly workflowRunId: string | null;
  readonly error?: string;
};

const asResearch = <T>(deps: EngineDeps, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  deps.sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(RESEARCH_ROLE)}`);
    return fn(tx);
  }) as Promise<T>;

/**
 * Runs one research question end to end (as far as the built phases reach).
 * @param deps - dispatcher/engine dependencies; the registry supplies the specialist roster
 * @param request - question + project slug (created if new)
 * @param options - `log` for the loud workflow failure line
 * @returns research run id, status, selected specialists, workflow run id
 */
export const runResearch = async (
  deps: EngineDeps,
  request: { readonly question: string; readonly projectSlug: string },
  options: { readonly log?: (line: string) => void } = {},
): Promise<ResearchResult> => {
  const researchRunId = await asResearch(deps, async (tx) => {
    await tx`insert into research_projects (slug, title) values (${request.projectSlug}, ${request.projectSlug})
             on conflict (slug) do nothing`;
    const [p] = await tx<{ id: string }[]>`select id from research_projects where slug = ${request.projectSlug}`;
    const [q] = await tx<{ id: string }[]>`
      insert into research_questions (project_id, question) values (${p!.id}, ${request.question}) returning id`;
    const [r] = await tx<{ id: string }[]>`insert into research_runs (question_id) values (${q!.id}) returning id`;
    return r!.id;
  });

  const close = async (status: 'success' | 'error', fields: { error?: string; workflowRunId?: string | null; plan?: ResearchPlan }) => {
    await asResearch(deps, (tx) => tx`
      update research_runs
      set status = ${status}, error_detail = ${fields.error ?? null},
          selected_specialists = ${fields.plan ? fields.plan.selection.selected.map((s) => s.name) : []},
          selection = ${tx.json((fields.plan?.selection ?? {}) as postgres.JSONValue)},
          workflow_run_id = ${fields.workflowRunId ?? null}, completed_at = clock_timestamp()
      where id = ${researchRunId}`);
  };

  // Every Research-class agent that declares a Scope is part of the roster.
  const roster = deps.registry
    .list()
    .filter((a) => a.class === 'Research' && a.sections.Scope)
    .map((a) => ({ name: a.name, scope: a.sections.Scope! }));

  // An empty roster is misconfiguration; reporting it as "nothing matched" would be a false success.
  if (roster.length === 0) {
    const error = 'no Research specialists with a ## Scope are registered (roster is empty)';
    await close('error', { error });
    return { researchRunId, status: 'error', selected: [], workflowRunId: null, error };
  }

  const decided = await dispatch(deps, ORCHESTRATOR_AGENT, { question: request.question, roster }, { researchRunId });
  if (decided.status === 'error') {
    await close('error', { error: `research-orchestrator failed: ${decided.error}` });
    return { researchRunId, status: 'error', selected: [], workflowRunId: null, error: decided.error! };
  }
  const plan = decided.output as ResearchPlan;
  const selected = plan.selection.selected.map((s) => s.name);
  if (selected.length === 0) {
    await close('success', { plan });
    return { researchRunId, status: 'success', selected, workflowRunId: null };
  }

  const wf = compileWorkflow(toYaml(plan.workflow), deps.registry, `generated:${ORCHESTRATOR_AGENT}:${researchRunId}`);
  const result = await runWorkflow(deps, wf, {}, { researchRunId, timeoutMs: LLM_TIMEOUT_MS, ...(options.log ? { log: options.log } : {}) });
  if (result.status === 'error') {
    const error = `specialist step ${result.failedStep} failed: ${result.error}`;
    await close('error', { error, workflowRunId: result.workflowRunId, plan });
    return { researchRunId, status: 'error', selected, workflowRunId: result.workflowRunId, error };
  }
  await close('success', { workflowRunId: result.workflowRunId, plan });
  return { researchRunId, status: 'success', selected, workflowRunId: result.workflowRunId };
};
