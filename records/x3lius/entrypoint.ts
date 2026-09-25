import { stringify as toYaml } from 'yaml';
import { LLM_TIMEOUT_MS } from '../../core/llm/runner.ts';
import { compileWorkflow, runWorkflow, type EngineDeps } from '../../core/workflow-engine/engine.ts';
import type { Selection } from '../../core/orchestrator/scope-select.ts';
import { MUSIC_SYSTEM_SERVICE, selectSubdomains } from './music-system.ts';
import { opsClarification } from '../ops/ops-hint.ts';

/**
 * RECORDS entrypoint (Phase 7): route a request inside the X3LIUS Music System. Selects the
 * sub-domain stubs by scope keywords and runs them through the Workflow Engine (one independent
 * step each, every run logged in agent_runs/workflow_runs). No match → clarify, never a default.
 */

export type MusicSystemResult = {
  readonly status: 'success' | 'error' | 'clarify';
  readonly selected: readonly string[];
  readonly selection: Selection;
  readonly workflowRunId: string | null;
  /** Each selected sub-domain's output, keyed by sub-domain slug. */
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly reason?: string;
};

/**
 * @param deps - dispatcher/engine dependencies (registry holds the stub agents)
 * @param input - the raw request the router sent to RECORDS
 * @param options - `log` for the workflow failure line
 * @returns selection evidence, the workflow run, and each sub-domain's output
 */
export const runMusicSystem = async (
  deps: EngineDeps,
  input: { readonly request: string },
  options: { readonly log?: (line: string) => void } = {},
): Promise<MusicSystemResult> => {
  const selection = selectSubdomains(input.request, deps.registry);
  const selected = selection.selected.map((s) => s.name);
  if (selected.length === 0) {
    // Phase 13 (F5): RECORDS also holds Records ops, which run on structured input only.
    const reason = opsClarification(input.request) ?? 'no X3LIUS sub-domain matched; name the sub-domain (e.g. Suno, Lyrics, Mix/Master)';
    return { status: 'clarify', selected, selection, workflowRunId: null, outputs: {}, reason };
  }
  const spec = {
    name: MUSIC_SYSTEM_SERVICE,
    description: `X3LIUS sub-domains for: ${input.request}`,
    input: { required: ['request'] },
    steps: selected.map((name) => ({ id: name, agent: name, input: { request: { $from: 'input.request' } } })),
    output: Object.fromEntries(selected.map((name) => [name, { $from: `steps.${name}.output` }])),
  };
  const wf = compileWorkflow(toYaml(spec), deps.registry, `generated:${MUSIC_SYSTEM_SERVICE}`);
  // Phase 8: Songwriting/Lyrics/Composition steps are LLM calls; the stubs finish well inside it.
  const r = await runWorkflow(deps, wf, { request: input.request }, { timeoutMs: LLM_TIMEOUT_MS, ...(options.log ? { log: options.log } : {}) });
  return r.status === 'error'
    ? { status: 'error', selected, selection, workflowRunId: r.workflowRunId, outputs: {}, reason: `sub-domain step ${r.failedStep} failed: ${r.error}` }
    : { status: 'success', selected, selection, workflowRunId: r.workflowRunId, outputs: r.output as Record<string, unknown> };
};
