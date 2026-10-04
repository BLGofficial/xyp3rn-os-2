import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type postgres from 'postgres';
import type { AgentRegistry } from '../../../core/agent-registry/registry.ts';
import type { Domain } from '../../../core/contracts/taxonomy.ts';
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

/**
 * One recorded event for the HUD (GET /api/events/stream). `bead` is the real edge it touched, as the globe draws
 * it (a step's agent run: step_uses_agent, from the step's sub-component to the agent's); `component` is where a
 * run without such an edge pulses. Nothing is synthesised: no row, no event.
 */
export type HudEvent = {
  readonly key: string;
  readonly at: string;
  readonly kind: 'agent' | 'workflow' | 'research' | 'scan';
  readonly title: string;
  readonly status: string;
  readonly domain: string | null;
  readonly component: string | null;
  readonly bead: { readonly from: string; readonly to: string; readonly relation: string } | null;
};

type EventRow = {
  key: string; at: Date; kind: HudEvent['kind']; title: string; status: string;
  path: string | null; owner: Domain | null; from_path: string | null; from_owner: Domain | null;
};

/**
 * Events recorded after a cursor, oldest first: agent runs, workflow runs, research runs and index scans, each when
 * it starts and when it finishes (its `coalesce(completed_at, created_at)` passes the cursor again).
 * @param sql - the app's pool
 * @param since - the cursor (a database timestamp; the first call uses the database's now())
 * @param seen - keys already sent at exactly the cursor time (rows sharing a timestamp are not repeated)
 * @returns the events and the next cursor
 */
export const hudEventsSince = (sql: Sql, since: string | null, seen: ReadonlySet<string> = new Set()) =>
  asWeb(sql, async (tx) => {
    const cursor = since ?? (await tx<{ now: string }[]>`select now()::text as now`)[0]!.now;
    const rows = await tx<EventRow[]>`
      select * from (
        select 'agent:' || r.id || ':' || r.status as key, coalesce(r.completed_at, r.created_at) as at, 'agent' as kind,
               r.agent_name as title, r.status::text as status, a.path, a.owner_domain as owner, s.path as from_path, s.owner_domain as from_owner
        from agent_runs r
        left join graph_nodes a on a.id = 'agent:' || r.agent_name
        left join workflow_runs w on w.id = r.workflow_run_id
        left join graph_nodes s on r.step_id is not null and s.id = 'workflow_step:' || w.workflow_name || '#' || r.step_id
        union all
        select 'workflow:' || w.id || ':' || w.status, coalesce(w.completed_at, w.created_at), 'workflow', w.workflow_name, w.status::text,
               n.path, n.owner_domain, null, null
        from workflow_runs w left join graph_nodes n on n.id = 'workflow:' || w.workflow_name
        union all
        select 'research:' || r.id || ':' || r.status, coalesce(r.completed_at, r.created_at), 'research', 'research run', r.status::text,
               n.path, n.owner_domain, null, null
        from research_runs r left join graph_nodes n on n.id = 'agent:research-orchestrator'
        union all
        select 'scan:' || s.id || ':' || s.status, coalesce(s.finished_at, s.started_at), 'scan', 'index scan', s.status, null, null, null, null
        from index_scans s
      ) e
      where e.at >= ${cursor}::timestamptz
      order by e.at, e.key
      limit 100`;
    const events: HudEvent[] = [];
    let next = cursor; const nextSeen = new Set<string>();
    for (const r of rows) {
      const at = r.at.toISOString();
      if (seen.has(r.key)) continue;
      const to = r.path === null ? null : comp.matchComponent(r.path, r.owner);
      const from = r.from_path === null ? null : comp.matchComponent(r.from_path, r.from_owner);
      events.push({
        key: r.key, at, kind: r.kind, title: r.title, status: r.status,
        domain: to === null ? null : to === comp.SHARED ? 'shared' : to.split(':')[0]!,
        component: to,
        bead: from !== null && to !== null && from !== to ? { from, to, relation: 'step_uses_agent' } : null,
      });
    }
    // The cursor advances to the newest timestamp sent; keys at exactly that time are remembered, not re-sent.
    if (rows.length > 0) {
      const last = rows[rows.length - 1]!.at;
      next = (await tx<{ t: string }[]>`select ${last}::timestamptz::text as t`)[0]!.t;
      for (const r of rows) if (r.at.getTime() === last.getTime()) nextSeen.add(r.key);
    } else for (const k of seen) nextSeen.add(k);
    return { events, cursor: next, seen: nextSeen as ReadonlySet<string> };
  });
