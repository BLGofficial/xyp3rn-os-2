import type { AgentRegistry } from '../../../core/agent-registry/registry.ts';
import type { Sql } from '../../../core/db/client.ts';
import { PROVIDERS } from '../../../core/llm/providers.ts';
import { CAPABILITIES } from '../../../core/tool-registry/capabilities.ts';
import type { ToolRegistry } from '../../../core/tool-registry/registry.ts';
import { asWeb } from './loaders.ts';

/**
 * System Admin (Jarvis Prompt 01, J1): what the OS is made of, each figure read from where it lives. Registries from
 * the live registries and the database, migrations from the tracker, roles by name from pg_roles. Secrets are
 * reported as configured or not: only a key's name leaves this module, never its value.
 */

/**
 * @param sql - the app's pool
 * @param o - the environment (for which keys are set), the agent registry and the tool registry the server runs
 */
export const adminOverview = async (sql: Sql, o: { env: Readonly<Record<string, string | undefined>>; registry: AgentRegistry; tools: ToolRegistry }) => {
  // The tracker through the app's pool, read only (as the pulse reads it): xyp_web holds no grant on xyp_meta.
  const [t] = (await sql.begin('read only', (tx) => tx<{ head: string | null; n: number }[]>`
    select max(version) as head, count(*)::int as n from xyp_meta.applied_migrations`)) as { head: string | null; n: number }[];
  const db = await asWeb(sql, async (tx) => {
    const [c] = await tx<{ modules: number; workflows: number }[]>`
      select (select count(distinct slug)::int from modules) as modules, (select count(*)::int from graph_nodes where kind = 'workflow') as workflows`;
    const roles = await tx<{ rolname: string }[]>`select rolname from pg_roles where rolname like 'xyp\\_%' order by rolname`;
    const [now] = await tx<{ now: Date }[]>`select now()`;
    return { ...c!, roles: roles.map((r) => r.rolname), asOf: now!.now.toISOString() };
  });
  return {
    migrations: { head: t?.head ?? null, applied: t?.n ?? 0 },
    registries: [
      { name: 'Agents', count: o.registry.list().length, source: 'agents/*.agent.md, as the agent registry loaded them' },
      { name: 'Tools', count: o.tools.list().length, source: 'the tool registry the server runs (core/runtime/tools.ts)' },
      { name: 'Capabilities', count: CAPABILITIES.length, source: 'core/tool-registry/capabilities.ts' },
      { name: 'Workflow files', count: db.workflows, source: 'workflow files in the index' },
      { name: 'Modules', count: db.modules, source: 'modules (one per slug, latest version)' },
    ],
    roles: db.roles,
    secrets: Object.values(PROVIDERS).map((p) => ({ name: p.keyEnv, configured: typeof o.env[p.keyEnv] === 'string' && o.env[p.keyEnv] !== '' })),
    asOf: db.asOf,
  };
};
