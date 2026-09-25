import { stringify as toYaml } from 'yaml';
import { LLM_TIMEOUT_MS } from '../core/llm/runner.ts';
import type { Selection } from '../core/orchestrator/scope-select.ts';
import { compileWorkflow, runWorkflow, type EngineDeps } from '../core/workflow-engine/engine.ts';
import { AUDIO_TOOLS_AGENT, TRACE_SERVICE_USAGE } from './trace/intake.ts';
import { loadTechSystem, selectComponents } from './tech-system.ts';

/**
 * TECH entrypoint (Phase 14, `pnpm ask`): route a request to XYP3RN Tech's components by their scope
 * keywords, and run the ones that take text (the stubs and R&D) through the Workflow Engine. Audio
 * Tools takes measurements, not text: a request only it matches is answered with the TRACE service to
 * call. No match → clarify, never a default.
 */

export const TECH_SYSTEM_SERVICE = 'tech-system';

export type TechSystemResult = {
  readonly status: 'success' | 'error' | 'clarify';
  readonly selected: readonly string[];
  readonly selection: Selection;
  readonly workflowRunId: string | null;
  /** Each component run's output, keyed by component slug. */
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly reason?: string;
};

/**
 * @param deps - dispatcher/engine dependencies
 * @param input - the raw request the router sent to TECH
 * @param options - `log` for the workflow failure line
 * @returns selection evidence, the workflow run, and each component's output
 */
export const runTechSystem = async (
  deps: EngineDeps,
  input: { readonly request: string },
  options: { readonly log?: (line: string) => void } = {},
): Promise<TechSystemResult> => {
  const selection = selectComponents(input.request, deps.registry);
  const selected = selection.selected.map((s) => s.name);
  const runnable = selected.filter((n) => n !== AUDIO_TOOLS_AGENT);
  if (selected.length === 0) {
    const names = loadTechSystem().components.map((c) => c.title).join(', ');
    return { status: 'clarify', selected, selection, workflowRunId: null, outputs: {}, reason: `no TECH component matched; name one (${names})` };
  }
  if (runnable.length === 0) return { status: 'clarify', selected, selection, workflowRunId: null, outputs: {}, reason: TRACE_SERVICE_USAGE };
  const spec = {
    name: TECH_SYSTEM_SERVICE,
    description: `TECH components for: ${input.request}`,
    input: { required: ['request'] },
    steps: runnable.map((name) => ({ id: name, agent: name, input: { request: { $from: 'input.request' } } })),
    output: Object.fromEntries(runnable.map((name) => [name, { $from: `steps.${name}.output` }])),
  };
  const wf = compileWorkflow(toYaml(spec), deps.registry, `generated:${TECH_SYSTEM_SERVICE}`);
  // R&D is an LLM step; the stubs finish well inside it.
  const r = await runWorkflow(deps, wf, { request: input.request }, { timeoutMs: LLM_TIMEOUT_MS, ...(options.log ? { log: options.log } : {}) });
  const note = selected.includes(AUDIO_TOOLS_AGENT) ? { reason: TRACE_SERVICE_USAGE } : {};
  return r.status === 'error'
    ? { status: 'error', selected, selection, workflowRunId: r.workflowRunId, outputs: {}, reason: `component step ${r.failedStep} failed: ${r.error}` }
    : { status: 'success', selected, selection, workflowRunId: r.workflowRunId, outputs: r.output as Record<string, unknown>, ...note };
};
