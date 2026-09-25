import type postgres from 'postgres';
import type { Sql } from '../core/db/client.ts';
import type { AgentHandler } from '../core/orchestrator/dispatch.ts';
import { defineTool } from '../core/tool-registry/registry.ts';
import { checkLegal, type LegalInput } from './rules.ts';

export const legalAgent: AgentHandler = async (ctx, input) => ({ output: await ctx.useTool('check_legal', input), tokensUsed: 0 });
export const rightsConflictAgent: AgentHandler = async (ctx, input) => ({ output: await ctx.useTool('check_rights_conflict', input), tokensUsed: 0 });
export const createGovernanceTools = (sql: Sql) => [
  defineTool({ name: 'check_legal', capability: 'governance.flag', description: 'Check recorded source license or generated-content rights metadata under explicit rules.', handler: async (ctx, args) => {
    const value = args as { sourceId?: unknown; artifactId?: unknown } | null;
    if (!value || (typeof value.sourceId === 'string') === (typeof value.artifactId === 'string')) throw new Error('Provide exactly one sourceId or artifactId');
    return sql.begin(async tx => {
      await tx`set local role xyp_governance`;
      const [row] = typeof value.sourceId === 'string' ? await tx<{ metadata: LegalInput }[]>`select metadata from sources where id = ${value.sourceId}` : await tx<{ metadata: LegalInput }[]>`select knowledge->'rights' as metadata from creative_artifacts where id = ${value.artifactId as string}`;
      if (!row) throw new Error('Source object not found');
      const result = checkLegal(row.metadata ?? {});
      const sourceRef = typeof value.sourceId === 'string' ? `sources:${value.sourceId}` : `creative_artifacts:${value.artifactId as string}`;
      const [flag] = await tx`insert into governance_flags (source_ref, agent_run_id, kind, result) values (${sourceRef}, ${ctx.runId}, 'legal', ${tx.json(result)}) returning id`;
      return { ...result, id: flag!.id, sourceRef };
    });
  } }),
  defineTool({ name: 'check_rights_conflict', capability: 'governance.flag', description: 'Cross-check a proposed rights claim against existing allocations without altering them.', handler: async (ctx, args) => {
    const value = args as { trackId?: unknown; payee?: unknown; percentage?: unknown } | null;
    if (!value || typeof value.trackId !== 'string' || typeof value.payee !== 'string' || !value.payee.trim() || typeof value.percentage !== 'number' || !Number.isFinite(value.percentage) || value.percentage <= 0 || value.percentage > 100) throw new Error('trackId, payee and percentage in (0,100] required');
    return sql.begin(async tx => {
      await tx`set local role xyp_governance`;
      const [track] = await tx`select id from tracks where id = ${value.trackId as string}`;
      if (!track) throw new Error('Track not found');
      const splits = await tx<{ payee: string; percentage: string }[]>`select payee, percentage from rights_splits where track_id = ${value.trackId as string}`;
      const own = splits.filter(s => s.payee.toLowerCase() === (value.payee as string).trim().toLowerCase()).reduce((n,s) => n + Number(s.percentage), 0);
      const total = splits.filter(s => s.payee !== 'UNASSIGNED').reduce((n,s) => n + Number(s.percentage), 0);
      const flags = [ ...(own && own !== value.percentage ? [{ ruleId: 'rights.existing-claim', reason: 'Claim conflicts with recorded allocation' }] : []), ...(total - own + (value.percentage as number) > 100 ? [{ ruleId: 'rights.overallocation', reason: 'Claim would exceed 100 percent' }] : []) ];
      const result = { status: flags.length ? 'conflict' : 'requires-human-review', checked: ['rights.existing-claim', 'rights.overallocation'], flags, claim: value, existingAllocation: own, allocatedTotal: total, accepted: false };
      const [r] = await tx`insert into governance_flags (source_ref, agent_run_id, kind, result) values (${`tracks:${value.trackId}`}, ${ctx.runId}, 'rights', ${tx.json(result as postgres.JSONValue)}) returning id`;
      return { id: r!.id, ...result };
    });
  } }),
];
