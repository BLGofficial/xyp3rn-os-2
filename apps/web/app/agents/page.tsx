import { DOMAINS, DOMAIN_META, isDomain } from '../../../../core/contracts/taxonomy.ts';
import { firstSentence } from '../../lib/ring-layout';
import { agentsLoaders, runtime } from '../../lib/server';
import { first } from '../ui';
import { AgentsRing, type AgentRow } from './agents-ring';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'XYP3RN Agentic OS · Agent ring' };

// The agent ring: the registry (agents/*.agent.md) as a map. Domains round the Jarvis core; a domain opens into its
// agents. Colour is the agent class, the pulse is a live run from the HUD stream. A failed read of the last runs is
// said so, never shown as "never run".
export default async function Agents({ searchParams: pendingSearchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await pendingSearchParams;
  const rt = await runtime();
  let runs = new Map<string, { status: string; at: string; latencyMs: number | null }>();
  let runsFailed = false;
  try {
    runs = new Map((await (await agentsLoaders()).lastRuns(rt.sql)).map((r) => [r.agent, { status: r.status, at: r.at, latencyMs: r.latencyMs }]));
  } catch (e) {
    console.error('agent ring: last runs failed:', e);
    runsFailed = true;
  }
  const agents: AgentRow[] = rt.deps.registry.list().map((a) => ({
    name: a.name, cls: a.class, domain: a.domain, role: firstSentence(a.role), model: a.model, tools: a.tools, lastRun: runs.get(a.name) ?? null,
  }));
  const wanted = first(searchParams.domain);
  return (
    <section>
      <h1>Agent ring</h1>
      <p className="meta">{agents.length} agents from the registry (agents/*.agent.md). The centre is Jarvis; the pulse is a live agent run.</p>
      {runsFailed && <p className="error mt-3" role="alert">The server could not read the last runs: every “never run” below may be wrong.</p>}
      <div className="mt-4">
        <AgentsRing agents={agents} domains={DOMAINS.map((id) => ({ id, label: DOMAIN_META[id].label, color: DOMAIN_META[id].color }))} initialDomain={isDomain(wanted) ? wanted : null} />
      </div>
    </section>
  );
}
