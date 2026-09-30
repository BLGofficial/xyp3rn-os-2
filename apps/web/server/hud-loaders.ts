import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type postgres from 'postgres';
import type { AgentRegistry } from '../../../core/agent-registry/registry.ts';
import type { Sql } from '../../../core/db/client.ts';
import * as comp from '../../../knowledge/knowledge-graph/components.ts';
import { asWeb } from './loaders.ts';
import { activity, metrics, pulse } from './shell-loaders.ts';

/**
 * What the Mercury HUD (/hud) reads, as xyp_web, read only. It composes the shell's loaders (pulse, metrics,
 * activity) and adds only the counts the HUD shows; every number names its source. Secret values never leave
 * the server: provider keys are reported as configured or not, by the pulse.
 */

/** The application identity (package.json): configuration, not an agent or a server. Never hard-coded. */
export const hudIdentity = async () => {
  const pkg = JSON.parse(await readFile(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')) as { name: string; version: string };
  return { name: pkg.name, version: pkg.version };
};

const BOOTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

/** GET /api/graph/components: sub-components, their files and the aggregated links, from one snapshot. */
export const hudComponents = (sql: Sql) =>
  asWeb(sql, async (tx) => {
    await tx.unsafe('set transaction isolation level repeatable read');
    return comp.components(tx);
  });
export type ComponentsData = Awaited<ReturnType<typeof hudComponents>>;

const n = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;

/** Agent runs per hour for the 24 hours ending now (oldest first), from agent_runs.created_at. */
const runsPerHour = async (tx: postgres.TransactionSql): Promise<number[]> => {
  const rows = await tx<{ h: number; n: number }[]>`
    select floor(extract(epoch from (now() - created_at)) / 3600)::int as h, count(*)::int as n
    from agent_runs where created_at > now() - interval '24 hours' group by 1`;
  const out = new Array<number>(24).fill(0);
  for (const r of rows) if (r.h >= 0 && r.h < 24) out[23 - r.h] = r.n;
  return out;
};

/**
 * GET /api/system/status: the right rail and the bottom bar.
 * @param sql - the app's pool
 * @param env - process.env (provider keys: presence only)
 * @param registry - the agent registry
 */
export const hudStatus = async (sql: Sql, env: Readonly<Record<string, string | undefined>>, registry: AgentRegistry) => {
  const agents = registry.list();
  const [p, m, act, counts] = await Promise.all([
    pulse(sql, env, registry),
    metrics(sql),
    activity(sql, 12),
    asWeb(sql, async (tx) => ({
      graphEntities: await n(tx`select count(*)::int as n from graph_nodes`),
      filesIndexed: await n(tx`select count(*)::int as n from indexed_files where status = 'present'`),
      workflowsDefined: await n(tx`select count(*)::int as n from graph_nodes where kind = 'workflow'`),
      workflowsRunning: await n(tx`select count(*)::int as n from workflow_runs where status = 'running'`),
      researchRunning: await n(tx`select count(*)::int as n from research_runs where status = 'running'`),
      researchTotal: await n(tx`select count(*)::int as n from research_runs`),
      ran24h: await n(tx`select count(distinct agent_name)::int as n from agent_runs where created_at > now() - interval '24 hours'`),
      // Agents whose newest run failed.
      lastRunFailed: await n(tx`select count(*)::int as n from (select distinct on (agent_name) status from agent_runs order by agent_name, created_at desc) t where t.status = 'error'`),
      alerts: await n(tx`select count(*)::int as n from catalog_checks`),
      runsPerHour: await runsPerHour(tx),
      lastScan: (await tx<{ status: string; started_at: Date; finished_at: Date | null; counts: unknown }[]>`
        select status, started_at, finished_at, counts from index_scans order by started_at desc limit 1`)[0] ?? null,
    })),
  ]);
  const llm = agents.filter((a) => a.model !== 'none').length;
  return {
    pulse: p,
    metrics: m,
    activity: act,
    agents: { registered: agents.length, ran24h: counts.ran24h, lastRunFailed: counts.lastRunFailed, llm, deterministic: agents.length - llm },
    counts: {
      graphEntities: counts.graphEntities, filesIndexed: counts.filesIndexed,
      workflowsDefined: counts.workflowsDefined, workflowsRunning: counts.workflowsRunning,
      researchRunning: counts.researchRunning, researchTotal: counts.researchTotal, alerts: counts.alerts,
    },
    runsPerHour: counts.runsPerHour,
    lastScan: counts.lastScan && {
      status: counts.lastScan.status, startedAt: counts.lastScan.started_at.toISOString(),
      finishedAt: counts.lastScan.finished_at?.toISOString() ?? null, counts: counts.lastScan.counts,
    },
    bootedAt: BOOTED_AT,
    asOf: new Date().toISOString(),
  };
};
export type StatusData = Awaited<ReturnType<typeof hudStatus>>;
