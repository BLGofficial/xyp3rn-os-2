import type { AgentHandler } from '../orchestrator/dispatch.ts';

/**
 * Handler for agents/health-check.agent.md: echo the input with a timestamp, log one line.
 * @param ctx - run context (tools reachable only through ctx.useTool)
 * @param input - any JSON value, echoed verbatim
 * @returns `{ echo, timestamp }`; 0 tokens (no model)
 */
export const healthCheck: AgentHandler = async (ctx, input) => {
  await ctx.useTool('log_message', { message: 'health-check: echoing input' });
  return { output: { echo: input, timestamp: new Date().toISOString() }, tokensUsed: 0 };
};
