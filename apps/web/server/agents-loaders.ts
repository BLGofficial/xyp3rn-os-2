import type { Sql } from '../../../core/db/client.ts';
import { asWeb } from './loaders.ts';

/** What the agent ring (/agents) reads beyond the registry: each agent's newest run, as xyp_web, read only. */

export type LastRun = { readonly agent: string; readonly status: string; readonly at: string; readonly latencyMs: number | null };

/** The newest agent_runs row per agent. An agent that never ran has no row. */
export const lastRuns = (sql: Sql) =>
  asWeb(sql, async (tx): Promise<LastRun[]> => {
    const rows = await tx<{ agent_name: string; status: string; at: string; latency_ms: number | null }[]>`
      select distinct on (agent_name) agent_name, status::text as status, coalesce(completed_at, created_at)::text as at, latency_ms
      from agent_runs order by agent_name, created_at desc`;
    return rows.map((r) => ({ agent: r.agent_name, status: r.status, at: r.at, latencyMs: r.latency_ms }));
  });
