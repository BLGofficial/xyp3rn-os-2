import type { AgentHandler } from '../../../core/orchestrator/dispatch.ts';

export const TASKS_AGENT = 'records-tasks';

/**
 * records-tasks (AOS-02, Execution, deterministic): the owner's to-dos. Exactly one of
 * - `{ create: { title, songId?, releaseId?, dueDate? } }` → `{ taskId, … }`;
 * - `{ move: { taskId, status: 'done' | 'cancelled' | 'open', note? } }`.
 * @param ctx - run context; write_task / move_task (task.write) carry the writes
 * @param input - one of the shapes above
 * @returns the tool's result as the run output
 */
export const recordsTasks: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as Record<string, unknown>;
  const ops = (['create', 'move'] as const).filter((k) => i[k] !== undefined);
  if (ops.length !== 1 || Object.keys(i).length !== 1) throw new Error('records-tasks input needs exactly one of create, move');
  return { output: await ctx.useTool(ops[0] === 'create' ? 'write_task' : 'move_task', i[ops[0]!]), tokensUsed: 0 };
};
