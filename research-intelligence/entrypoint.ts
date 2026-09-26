import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import { stringify as toYaml } from 'yaml';
import { quoteIdent, type Sql } from '../core/db/client.ts';
import { LLM_TIMEOUT_MS } from '../core/llm/runner.ts';
import { dispatch } from '../core/orchestrator/dispatch.ts';
import { compileWorkflow, runWorkflow, type EngineDeps } from '../core/workflow-engine/engine.ts';
import { decisionKeys, validateBrief, workflowFiles, type Brief } from './brief.ts';
import { asRole } from './db.ts';
import { parseScope, planResearch, type ResearchPlan } from './orchestrator/select.ts';
import { synthesizeRun } from './synthesis/synthesize.ts';

/**
 * Research Intelligence entrypoint (Phase 6A, split in AOS-04): the runtime side of the Research
 * Orchestrator. The orchestrator agent decides; these functions execute, through the Workflow Engine,
 * and keep the research tables consistent. Research-table writes run as xyp_research.
 *
 *   openResearch     brief → research_questions (+ research_links) + research_runs(running)
 *                    → dispatch research-orchestrator (roster + owner picks in, plan out)   [agent_runs, linked]
 *                    → selection and deadline recorded on the run
 *   executeResearch  runWorkflow(plan): one step per selected specialist, LLM_TIMEOUT_MS each  [agent_runs, linked]
 *                    → synthesis (evidence → findings) → research_runs sealed success | error (with the reason)
 *   sweepResearch    a running run past its deadline is sealed error ("abandoned: …")
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

/** Time a run may take beyond its specialists' timeouts before the sweep calls it abandoned. */
const DEADLINE_MARGIN_MS = 5 * 60_000;

// Every Research-class agent that declares a Scope is part of the roster.
const rosterOf = (deps: EngineDeps) =>
  deps.registry.list().filter((a) => a.class === 'Research' && a.sections.Scope).map((a) => ({ name: a.name, scope: a.sections.Scope! }));

export type OpenedResearch = { readonly researchRunId: string; readonly questionId: string; readonly selected: readonly string[] };

/**
 * Opens a research run for a brief (AOS-04 §6): validates it, writes the question with its brief fields and
 * research links and the run in one transaction, then asks the Research Orchestrator for the plan and records
 * the selection and the deadline (n specialists × LLM_TIMEOUT_MS + 5 min). A song target is linked by the
 * caller through link_song (A1), since that is a Records agent run.
 * @param deps - dispatch/engine dependencies
 * @param brief - the brief; the Phase 6A `{ question, projectSlug }` is a brief too
 * @param opts - `requireIntendedUse` for the AOS-04 ops (web form, `pnpm research ask`)
 * @returns run id, question id, selected specialists (empty when the run was sealed at open)
 * @throws Error "brief rejected: …" before any write; the DB's refusal (e.g. a non-root lineage) with nothing written
 */
export const openResearch = async (deps: EngineDeps, brief: Brief, opts: { readonly requireIntendedUse?: boolean } = {}): Promise<OpenedResearch> => {
  const roster = rosterOf(deps);
  const flows = new Map(workflowFiles().map((w) => [w.name, w.path]));
  const errors = validateBrief(brief, { specialists: new Set(roster.map((r) => r.name)), decisions: decisionKeys(), workflows: new Set(flows.keys()) }, opts);
  if (errors.length > 0) throw new Error(`brief rejected: ${errors.join('; ')}`);
  const { researchRunId, questionId } = await asResearch(deps, async (tx) => {
    await tx`insert into research_projects (slug, title) values (${brief.projectSlug}, ${brief.projectSlug}) on conflict (slug) do nothing`;
    const [p] = await tx<{ id: string }[]>`select id from research_projects where slug = ${brief.projectSlug}`;
    const [q] = await tx<{ id: string }[]>`
      insert into research_questions (project_id, question, intended_use, urls, specialists)
      values (${p!.id}, ${brief.question.trim()}, ${brief.intendedUse?.trim() || null}, ${[...(brief.urls ?? [])]},
              ${brief.specialists ? [...brief.specialists] : null})
      returning id`;
    for (const t of brief.targets ?? []) {
      const role = t.role?.trim() || null;
      if (t.kind === 'lineage') await tx`insert into research_links (question_id, artifact_lineage_id, role) values (${q!.id}, ${t.artifactLineageId}, ${role})`;
      if (t.kind === 'decision') await tx`insert into research_links (question_id, decision_key, role) values (${q!.id}, ${t.decisionKey}, ${role})`;
      if (t.kind === 'workflow') {
        // The spec's sha256 as the engine records it on workflow_runs (the raw file text).
        const sha = createHash('sha256').update(readFileSync(flows.get(t.workflowName)!, 'utf8')).digest('hex');
        await tx`insert into research_links (question_id, workflow_name, workflow_sha256, role) values (${q!.id}, ${t.workflowName}, ${sha}, ${role})`;
      }
    }
    const [r] = await tx<{ id: string }[]>`insert into research_runs (question_id) values (${q!.id}) returning id`;
    return { researchRunId: r!.id, questionId: q!.id };
  });

  const seal = (error: string) => asResearch(deps, (tx) => tx`
    update research_runs set status = 'error', error_detail = ${error}, completed_at = clock_timestamp() where id = ${researchRunId}`);
  // An empty roster is misconfiguration; reporting it as "nothing matched" would be a false success.
  if (roster.length === 0) {
    await seal('no Research specialists with a ## Scope are registered (roster is empty)');
    return { researchRunId, questionId, selected: [] };
  }
  const decided = await dispatch(deps, ORCHESTRATOR_AGENT, { question: brief.question, roster, ...(brief.specialists ? { owner: [...brief.specialists] } : {}) }, { researchRunId });
  if (decided.status === 'error') {
    await seal(`research-orchestrator failed: ${decided.error}`);
    return { researchRunId, questionId, selected: [] };
  }
  const plan = decided.output as ResearchPlan;
  const selected = plan.selection.selected.map((s) => s.name);
  const expires = new Date(Date.now() + selected.length * LLM_TIMEOUT_MS + DEADLINE_MARGIN_MS);
  await asResearch(deps, (tx) => tx`
    update research_runs set selected_specialists = ${selected}, selection = ${tx.json(plan.selection as unknown as postgres.JSONValue)}, expires_at = ${expires}
    where id = ${researchRunId}`);
  return { researchRunId, questionId, selected };
};

type OpenRun = {
  status: string; error_detail: string | null; selected: string[]; selection: Partial<ResearchPlan['selection']>;
  question: string; intended_use: string | null; urls: string[];
};

/**
 * Executes an opened run: one workflow step per selected specialist (timeout LLM_TIMEOUT_MS each), then
 * synthesis, then the seal. Seals the run itself on every path, so a caller may start it without awaiting it.
 * A run already sealed (at open, by the sweep, or by an earlier execute) is reported, not run again.
 * @param deps - dispatch/engine dependencies (with the LLM runner)
 * @param researchRunId - an open run
 * @param options - `log` for the workflow failure line
 * @returns the result as runResearch returned it
 * @throws Error only for an unknown run id
 */
export const executeResearch = async (deps: EngineDeps, researchRunId: string, options: { readonly log?: (line: string) => void } = {}): Promise<ResearchResult> => {
  const [run] = await asResearch(deps, (tx) => tx<OpenRun[]>`
    select r.status::text, r.error_detail, r.selected_specialists as selected, r.selection, q.question, q.intended_use, q.urls
    from research_runs r join research_questions q on q.id = r.question_id where r.id = ${researchRunId}`);
  if (!run) throw new Error(`no research run ${researchRunId}`);
  if (run.status !== 'running') {
    return { researchRunId, status: run.status === 'success' ? 'success' : 'error', selected: run.selected, workflowRunId: null, ...(run.error_detail ? { error: run.error_detail } : {}) };
  }
  const close = (status: 'success' | 'error', fields: { error?: string; workflowRunId?: string | null }) => asResearch(deps, (tx) => tx`
    update research_runs set status = ${status}, error_detail = ${fields.error ?? null}, workflow_run_id = ${fields.workflowRunId ?? null},
                             completed_at = clock_timestamp()
    where id = ${researchRunId} and status = 'running'`);
  try {
    if (run.selected.length === 0) {
      await close('success', {});
      return { researchRunId, status: 'success', selected: [], workflowRunId: null };
    }
    const plan = planResearch(run.question, rosterOf(deps).map((r) => parseScope(r.name, r.scope)), run.selection.owner ? run.selected : undefined);
    const wf = compileWorkflow(toYaml(plan.workflow), deps.registry, `generated:${ORCHESTRATOR_AGENT}:${researchRunId}`);
    const result = await runWorkflow(deps, wf, { question: run.question, intendedUse: run.intended_use, urls: run.urls },
      { researchRunId, timeoutMs: LLM_TIMEOUT_MS, ...(options.log ? { log: options.log } : {}) });
    // Evidence the steps wrote before a failure still becomes findings; the run's error labels them partial.
    await synthesizeRun(deps.sql, researchRunId);
    if (result.status === 'error') {
      const error = `specialist step ${result.failedStep} failed: ${result.error}`;
      await close('error', { error, workflowRunId: result.workflowRunId });
      return { researchRunId, status: 'error', selected: run.selected, workflowRunId: result.workflowRunId, error };
    }
    await close('success', { workflowRunId: result.workflowRunId });
    return { researchRunId, status: 'success', selected: run.selected, workflowRunId: result.workflowRunId };
  } catch (e) {
    const error = `research run failed: ${e instanceof Error ? e.message : String(e)}`;
    await close('error', { error });
    return { researchRunId, status: 'error', selected: run.selected, workflowRunId: null, error };
  }
};

/**
 * Seals every running run past its deadline as abandoned (the server stopped, or a step hung past its
 * timeouts). Called at web server boot and before a run starts.
 * @param sql - pool allowed to SET ROLE xyp_research
 * @param now - the clock (tests)
 * @returns the run ids sealed
 */
export const sweepResearch = async (sql: Sql, now: Date = new Date()): Promise<string[]> =>
  (await asRole(sql, RESEARCH_ROLE, (tx) => tx<{ id: string }[]>`
    update research_runs
    set status = 'error', error_detail = 'abandoned: no result by ' || to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        completed_at = clock_timestamp()
    where status = 'running' and expires_at < ${now}
    returning id`)).map((r) => r.id);

/**
 * Opens and executes a brief (CLI, tests). The Phase 6A call `{ question, projectSlug }` still works.
 * @param deps - dispatch/engine dependencies
 * @param brief - the brief
 * @param options - `log` for the workflow failure line
 * @returns research run id, status, selected specialists, workflow run id
 */
export const runResearch = async (deps: EngineDeps, brief: Brief, options: { readonly log?: (line: string) => void } = {}): Promise<ResearchResult> => {
  const opened = await openResearch(deps, brief);
  return executeResearch(deps, opened.researchRunId, options);
};
