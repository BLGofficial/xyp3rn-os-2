import { defineTool } from '../registry.ts';

const LEVELS = ['info', 'warn', 'error'] as const;

/**
 * log_message (capability log.write): appends a message to the current run's log, which the
 * Orchestrator persists in agent_runs.output.logs. The first real tool (Phase 4C).
 */
export const logMessageTool = defineTool({
  name: 'log_message',
  capability: 'log.write',
  description: 'Append a message to the current run log (persisted with the agent_runs row).',
  handler: async (ctx, args) => {
    const a = (args ?? {}) as { message?: unknown; level?: unknown };
    if (typeof a.message !== 'string' || a.message.trim() === '') throw new Error('log_message: message must be a non-empty string');
    const level = a.level ?? 'info';
    if (!(LEVELS as readonly unknown[]).includes(level)) throw new Error(`log_message: level must be one of ${LEVELS.join(', ')}`);
    ctx.log(level as (typeof LEVELS)[number], a.message);
    return { logged: true };
  },
});
