import type { AgentHandler } from '../../core/orchestrator/dispatch.ts';
import { parseScope, planResearch } from '../orchestrator/select.ts';

/**
 * Handler for agents/research-orchestrator.agent.md. Decides only: scores the question against
 * the roster it was given and returns the plan. The roster arrives as input so the exact scopes
 * it decided from are preserved on its agent_runs row.
 * @param ctx - run context
 * @param input - `{ question, roster: [{ name, scope }] }`
 * @returns `{ selection, workflow }`
 */
export const researchOrchestrator: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as { question?: unknown; roster?: unknown };
  if (typeof i.question !== 'string' || i.question.trim() === '') throw new Error('question must be a non-empty string');
  if (!Array.isArray(i.roster)) throw new Error('roster must be a list of { name, scope }');
  const scopes = (i.roster as { name: string; scope: string }[]).map((r) => parseScope(r.name, r.scope));
  const plan = planResearch(i.question, scopes);
  await ctx.useTool('log_message', {
    message: `selected ${plan.selection.selected.length}/${scopes.length}: ${plan.selection.selected.map((s) => `${s.name}(${s.score})`).join(', ') || 'none'}`,
  });
  return { output: plan, tokensUsed: 0 };
};
