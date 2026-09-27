import type postgres from 'postgres';
import type { AgentRegistry } from '../../../core/agent-registry/registry.ts';
import type { Sql } from '../../../core/db/client.ts';
import { PROVIDERS, type Provider } from '../../../core/llm/providers.ts';
import { asWeb } from './loaders.ts';

/**
 * What the Mercury shell reads (AOS-04 Plan B, design §13.1 and §20), as xyp_web in read-only transactions:
 * the metric strip (four cards, each with its exact definition, source and one shared as-of time), the
 * system pulse (what was actually checked, and nothing more), and recent activity across the record.
 */

type CardRead = { readonly value: number; readonly secondary?: { readonly label: string; readonly value: number } };
export type MetricDef = {
  readonly key: string; readonly label: string; readonly definition: string; readonly source: string; readonly href: string;
  readonly read: (tx: postgres.TransactionSql) => Promise<CardRead>;
};
export type MetricCard = Omit<MetricDef, 'read'> & { readonly value: number | null; readonly secondary?: CardRead['secondary']; readonly error?: string };

const count = async (q: Promise<{ n: number }[]>): Promise<number> => (await q)[0]!.n;

/** The four cards (§13.1). A definition is data shown on its card; change it here and the card says so. */
export const METRIC_CARDS: readonly MetricDef[] = [
  {
    key: 'activeSongs', label: 'Active songs', href: '/songs', source: 'current_songs',
    definition: 'Songs whose current status is idea, writing, producing or releasing (released and archived songs are not counted).',
    read: async (tx) => ({ value: await count(tx<{ n: number }[]>`select count(*)::int as n from current_songs where status::text in ('idea', 'writing', 'producing', 'releasing')`) }),
  },
  {
    key: 'runningWorkflows', label: 'Running workflows', href: '/research', source: 'workflow_runs, research_runs',
    definition: 'Workflow runs with status running; research runs still running are shown beside them (finished and failed runs are not counted).',
    read: async (tx) => ({
      value: await count(tx<{ n: number }[]>`select count(*)::int as n from workflow_runs where status = 'running'`),
      secondary: { label: 'research runs', value: await count(tx<{ n: number }[]>`select count(*)::int as n from research_runs where status = 'running'`) },
    }),
  },
  {
    key: 'vault', label: 'Vault', href: '/vault', source: 'sources, creative_artifacts',
    definition: 'Files stored in the Vault (sources with stored bytes); artifact lineages beside them, counted once however many versions they have.',
    read: async (tx) => ({
      value: await count(tx<{ n: number }[]>`select count(*)::int as n from sources where storage is not null`),
      secondary: { label: 'artifact lineages', value: await count(tx<{ n: number }[]>`select count(distinct lineage_id)::int as n from creative_artifacts`) },
    }),
  },
  {
    key: 'openBriefs', label: 'Open research briefs', href: '/research', source: 'research_questions',
    definition: 'Research briefs whose question status is open (answered and abandoned briefs are not counted).',
    read: async (tx) => ({ value: await count(tx<{ n: number }[]>`select count(*)::int as n from research_questions where status = 'open'`) }),
  },
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The metric strip from a given card list (the seam the test uses to break one card).
 * @param sql - the app's pool
 * @param cards - the card definitions
 * @returns every card with its value, or null with the error when its query failed; one as-of time
 */
export const metricsWith = (sql: Sql, cards: readonly MetricDef[]) =>
  asWeb(sql, async (tx) => {
    const [t] = await tx<{ now: Date }[]>`select now()`;
    const out: MetricCard[] = [];
    for (const { read, ...def } of cards) {
      try {
        // A savepoint per card: a failing query rolls back only itself, and the others still read.
        const r = (await tx.savepoint((sp) => read(sp))) as CardRead;
        out.push({ ...def, value: r.value, ...(r.secondary ? { secondary: r.secondary } : {}) });
      } catch (e) {
        out.push({ ...def, value: null, error: message(e) });
      }
    }
    return { asOf: t!.now.toISOString(), cards: out };
  });

/**
 * `/`'s metric strip (§13.1).
 * @param sql - the app's pool
 * @returns the four cards and the time they were read
 */
export const metrics = (sql: Sql) => metricsWith(sql, METRIC_CARDS);

export type PulseRow = {
  readonly label: string; readonly state: 'ok' | 'failed' | 'configured' | 'not-configured' | 'unavailable'; readonly detail: string; readonly asOf: string;
};
const PROVIDER_LABEL: Readonly<Record<Provider, string>> = { anthropic: 'Anthropic', groq: 'Groq', openrouter: 'OpenRouter' };

/**
 * The system pulse (§20): only what was actually checked. A provider key's presence is "Configured", never
 * reachability; the key's value is never read into the result.
 * @param sql - the app's pool
 * @param env - where provider keys would be (process.env in the app)
 * @param registry - the agent registry
 * @returns one row per check
 */
export const pulse = async (sql: Sql, env: Readonly<Record<string, string | undefined>>, registry: AgentRegistry): Promise<PulseRow[]> => {
  const now = () => new Date().toISOString();
  const rows: PulseRow[] = [];
  try {
    const [t] = await asWeb(sql, (tx) => tx<{ now: Date }[]>`select now()`);
    rows.push({ label: 'Database', state: 'ok', detail: 'answered a query', asOf: t!.now.toISOString() });
  } catch (e) {
    rows.push({ label: 'Database', state: 'unavailable', detail: message(e), asOf: now() });
  }
  try {
    // The migration tracker, read (not ensured) through the app's pool: xyp_web holds no grant on xyp_meta.
    const [h] = await sql.begin('read only', (tx) => tx<{ head: string | null }[]>`select max(version) as head from xyp_meta.applied_migrations`) as { head: string | null }[];
    rows.push(h?.head ? { label: 'Migration head', state: 'ok', detail: h.head, asOf: now() } : { label: 'Migration head', state: 'unavailable', detail: 'no migration recorded', asOf: now() });
  } catch (e) {
    rows.push({ label: 'Migration head', state: 'unavailable', detail: message(e), asOf: now() });
  }
  rows.push({ label: 'Agents', state: 'ok', detail: `${registry.list().length} registered`, asOf: now() });
  for (const [p, { keyEnv }] of Object.entries(PROVIDERS) as [Provider, { keyEnv: string }][]) {
    const set = typeof env[keyEnv] === 'string' && env[keyEnv] !== '';
    rows.push({ label: PROVIDER_LABEL[p], state: set ? 'configured' : 'not-configured', detail: set ? `${keyEnv} is set (not checked for reachability)` : `${keyEnv} is not set`, asOf: now() });
  }
  try {
    const [r] = await asWeb(sql, (tx) => tx<{ status: string; requested_uri: string; started_at: Date }[]>`
      select status::text, requested_uri, started_at from ingestion_runs order by started_at desc, id limit 1`);
    rows.push(!r ? { label: 'Last ingestion', state: 'unavailable', detail: 'no ingestion run recorded', asOf: now() }
      : { label: 'Last ingestion', state: r.status === 'error' ? 'failed' : 'ok', detail: `${r.status}: ${r.requested_uri}`, asOf: r.started_at.toISOString() });
  } catch (e) {
    rows.push({ label: 'Last ingestion', state: 'unavailable', detail: message(e), asOf: now() });
  }
  return rows;
};

export type ActivityRow = { readonly at: string; readonly kind: 'song' | 'agent' | 'workflow' | 'research' | 'decision'; readonly title: string; readonly status: string; readonly href: string | null };

/**
 * Recent activity: the newest song revisions, agent runs, workflow runs, research runs and owner decisions.
 * @param sql - the app's pool
 * @param limit - how many rows
 * @returns newest first; `href` is the row's page, or null when it has none
 */
export const activity = (sql: Sql, limit = 12): Promise<ActivityRow[]> =>
  asWeb(sql, async (tx) => (await tx<{ at: Date; kind: ActivityRow['kind']; title: string; status: string; href: string | null }[]>`
    select * from (
      select r.created_at as at, 'song' as kind, r.title || ' (revision ' || r.revision || ')' as title, r.status::text as status, '/songs/' || r.song_id as href
      from song_revisions r
      union all
      select a.created_at, 'agent', a.agent_name, a.status::text, null from agent_runs a
      union all
      select w.created_at, 'workflow', w.workflow_name, w.status::text, null from workflow_runs w
      union all
      select rr.created_at, 'research', q.question, rr.status::text, '/research/runs/' || rr.id
      from research_runs rr join research_questions q on q.id = rr.question_id
      union all
      select d.decided_at, 'decision', replace(d.item_type::text, '_', ' ') || ' ' || d.status::text || ' by ' || coalesce(d.decided_by, 'unknown'), d.status::text,
             case d.item_type::text
               when 'artifact_version' then (select '/vault/lineages/' || c.lineage_id from creative_artifacts c where c.id = d.item_id)
               when 'research_finding' then (select '/research/runs/' || f.research_run_id from research_findings f where f.id = d.item_id)
               when 'knowledge_candidate' then (select '/research/runs/' || f.research_run_id from knowledge_candidates k join research_findings f on f.id = k.finding_id where k.id = d.item_id)
             end
      from approval_queue d where d.decided_at is not null
    ) x
    order by at desc, kind, title
    limit ${limit}`).map((r) => ({ at: r.at.toISOString(), kind: r.kind, title: r.title, status: r.status, href: r.href })));
