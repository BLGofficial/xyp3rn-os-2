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
  readonly selection: Selection;
  readonly workflow: {
    readonly name: string;
    readonly description: string;
    readonly steps: ReadonlyArray<{ readonly id: string; readonly agent: string; readonly input: { readonly question: string } }>;
  };
};

/**
 * Turns a selection into a Workflow Engine spec: one independent step per selected specialist.
 * (Synthesis of their evidence into findings is added as a dependent step in 6C.)
 * @param question - research question
 * @param scopes - the roster
 * @returns selection evidence + workflow spec
 */
export const planResearch = (question: string, scopes: readonly AgentScope[]): ResearchPlan => {
  const selection = selectByScope(question, scopes);
  return {
    selection,
    workflow: {
      name: 'research-specialists',
      description: `Evidence gathering for: ${question}`,
      steps: selection.selected.map((s) => ({ id: s.name, agent: s.name, input: { question } })),
    },
  };
};
