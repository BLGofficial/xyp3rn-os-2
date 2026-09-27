import { selectByScope, type AgentScope, type Selection } from '../../core/orchestrator/scope-select.ts';

/**
 * Research Orchestrator selection (Phase 6A; user decision: scope keywords). The generic parser
 * and selector live in core/orchestrator/scope-select.ts (shared with the Phase 7 X3LIUS
 * sub-domains); the research names below are kept as aliases.
 */
export {
  parseScope,
  SCOPE_THRESHOLD as SELECTION_THRESHOLD,
  selectByScope as selectSpecialists,
  type AgentScope as SpecialistScope,
  type Scored,
  type Selection,
} from '../../core/orchestrator/scope-select.ts';

export type ResearchPlan = {
  readonly selection: Selection & { readonly owner?: true };
  readonly workflow: {
    readonly name: string;
    readonly description: string;
    readonly input: { readonly required: readonly string[]; readonly optional: readonly string[] };
    readonly steps: ReadonlyArray<{ readonly id: string; readonly agent: string; readonly input: Readonly<Record<string, { readonly $from: string }>> }>;
  };
};

/** Every specialist step reads the brief from the workflow input; absent optional inputs bind as null (AOS-03). */
const BRIEF_INPUT = { question: { $from: 'input.question' }, intendedUse: { $from: 'input.intendedUse' }, urls: { $from: 'input.urls' } } as const;

/**
 * Turns a selection into a Workflow Engine spec: one independent step per selected specialist, each bound to
 * the brief through the workflow input (AOS-04). Synthesis runs after the workflow (entrypoint.ts).
 * @param question - research question
 * @param scopes - the roster
 * @param owner - the owner's picks (AOS-04): used instead of the keyword threshold; the scores are kept for the record
 * @returns selection evidence + workflow spec
 * @throws Error for an owner pick not in the roster
 */
export const planResearch = (question: string, scopes: readonly AgentScope[], owner?: readonly string[]): ResearchPlan => {
  const scored = selectByScope(question, scopes);
  let selection: ResearchPlan['selection'] = scored;
  if (owner) {
    const names = new Set(scopes.map((s) => s.name));
    const unknown = owner.filter((n) => !names.has(n));
    if (unknown.length > 0) throw new Error(`unknown specialist ${unknown.join(', ')}`);
    const all = [...scored.selected, ...scored.notSelected];
    selection = { selected: all.filter((s) => owner.includes(s.name)), notSelected: all.filter((s) => !owner.includes(s.name)), threshold: scored.threshold, owner: true };
  }
  return {
    selection,
    workflow: {
      name: 'research-specialists',
      description: `Evidence gathering for: ${question}`,
      input: { required: ['question'], optional: ['intendedUse', 'urls'] },
      steps: selection.selected.map((s) => ({ id: s.name, agent: s.name, input: BRIEF_INPUT })),
    },
  };
};
