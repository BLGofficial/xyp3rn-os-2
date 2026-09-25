import type { Sql } from '../core/db/client.ts';
import type { AgentHandler } from '../core/orchestrator/dispatch.ts';
import { defineTool } from '../core/tool-registry/registry.ts';

export const backlogAgent: AgentHandler = async (ctx, input) => ({ output: await ctx.useTool('propose_rd_backlog', input), tokensUsed: 0 });
export const createBacklogTool = (sql: Sql) => defineTool({ name: 'propose_rd_backlog', capability: 'plan.write', description: 'Propose features from real frontier/emerging research sources; never implements them.', handler: async (ctx, args) => {
  const value = args as { sourceId?: unknown; title?: unknown; rationale?: unknown } | null;
  if (!value || typeof value.sourceId !== 'string' || typeof value.title !== 'string' || !value.title.trim() || typeof value.rationale !== 'string' || !value.rationale.trim()) throw new Error('sourceId, title and rationale are required');
  return sql.begin(async tx => {
    await tx`set local role xyp_planning`;
    const [source] = await tx<{ id: string }[]>`select id from research_sources where id = ${value.sourceId as string} and tags && array['frontier','emerging']`;
    if (!source) throw new Error('Source must exist and be tagged frontier or emerging');
    const [row] = await tx`insert into rd_backlog (source_id, title, rationale, agent_run_id) values (${source.id}, ${value.title as string}, ${value.rationale as string}, ${ctx.runId}) returning id, source_id, title, rationale, status, created_at`;
    return row;
  });
} });
