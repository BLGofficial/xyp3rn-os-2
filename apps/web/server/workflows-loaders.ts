import type { Sql } from '../../../core/db/client.ts';
import type { Domain } from '../../../core/contracts/taxonomy.ts';
import { asWeb } from './loaders.ts';

/**
 * The Workflow Builder's read (Jarvis Prompt 01, J1): no builder yet (Prompt 14), only what exists. Workflows come
 * from the index (a workflow file's declared nodes and edges), runs from workflow_runs, compared by spec sha256
 * with the revision the index holds. Runs naming a workflow with no definition file are listed apart, never
 * matched to a file by guess.
 */

type RunSummary = { readonly status: string; readonly at: string };
export type WorkflowRow = {
  readonly id: string; readonly name: string; readonly ownerDomain: Domain | null; readonly path: string | null; readonly fileId: string | null;
  readonly sourceRef: string; readonly revision: string | null;
  readonly steps: readonly { readonly id: string; readonly step: string; readonly agent: string | null; readonly dependsOn: readonly string[] }[];
  /** current: runs of the revision the index holds; earlier: runs of any other revision. */
  readonly runs: { readonly total: number; readonly current: number; readonly earlier: number; readonly last: RunSummary | null };
};

type RunRow = { workflow_name: string; spec_sha256: string; status: string; at: Date };
const lineOf = (ref: string) => Number(/:(\d+)$/.exec(ref)?.[1] ?? 0);

/**
 * @param sql - the app's pool
 * @returns workflows by name, each with its steps in file order and its runs; runs of undefined workflows by name
 */
export const workflowsOverview = (sql: Sql) =>
  asWeb(sql, async (tx) => {
    const nodes = await tx<{ id: string; kind: string; title: string; owner_domain: Domain | null; source_ref: string; revision: string | null; path: string | null; file_id: string | null }[]>`
      select n.id, n.kind, n.title, n.owner_domain::text, n.source_ref, n.revision, n.path, f.id as file_id
      from graph_nodes n left join indexed_files f on f.root = 'repo' and f.path = n.path
      where n.kind in ('workflow', 'workflow_step') order by n.id`;
    const edges = await tx<{ relation: string; from_id: string; to_id: string; detail: string | null }[]>`
      select relation, from_id, to_id, detail from graph_edges where relation in ('part_of', 'step_uses_agent', 'depends_on') and from_id like 'workflow_step:%'
      order by from_id, relation, to_id`;
    // Declared edges whose target is missing (an agent not registered) are diagnostics, not edges; the step still
    // names its agent there.
    const unresolved = await tx<{ from_id: string; relation: string; detail: string | null }[]>`
      select from_id, relation, detail from graph_diagnostics where relation in ('step_uses_agent', 'depends_on') and from_id like 'workflow_step:%'`;
    const runs: RunRow[] = await tx<RunRow[]>`
      select workflow_name, spec_sha256, status::text, coalesce(completed_at, created_at) as at from workflow_runs order by workflow_name, created_at desc, id`;
    const [now] = await tx<{ now: Date }[]>`select now()`;

    const stepsOf = new Map<string, WorkflowRow['steps'][number][]>();
    for (const s of nodes.filter((n) => n.kind === 'workflow_step').sort((a, b) => lineOf(a.source_ref) - lineOf(b.source_ref))) {
      const out = edges.filter((e) => e.from_id === s.id);
      const miss = unresolved.filter((d) => d.from_id === s.id);
      const wf = out.find((e) => e.relation === 'part_of')?.to_id;
      if (!wf) continue;
      const agent = out.find((e) => e.relation === 'step_uses_agent')?.detail ?? miss.find((d) => d.relation === 'step_uses_agent')?.detail ?? null;
      const dependsOn = [...out.filter((e) => e.relation === 'depends_on'), ...miss.filter((d) => d.relation === 'depends_on')].map((e) => e.detail ?? '').filter(Boolean);
      stepsOf.set(wf, [...(stepsOf.get(wf) ?? []), { id: s.id, step: s.id.slice(s.id.indexOf('#') + 1), agent, dependsOn }]);
    }

    const runsOf = new Map<string, RunRow[]>();
    for (const r of runs) runsOf.set(r.workflow_name, [...(runsOf.get(r.workflow_name) ?? []), r]);
    const last = (rs: readonly RunRow[]): RunSummary | null => (rs[0] ? { status: rs[0].status, at: rs[0].at.toISOString() } : null);

    const workflows: WorkflowRow[] = nodes.filter((n) => n.kind === 'workflow').map((w) => {
      const rs = runsOf.get(w.title) ?? [];
      const current = rs.filter((r) => r.spec_sha256 === w.revision).length;
      return {
        id: w.id, name: w.title, ownerDomain: w.owner_domain, path: w.path, fileId: w.file_id, sourceRef: w.source_ref, revision: w.revision,
        steps: stepsOf.get(w.id) ?? [], runs: { total: rs.length, current, earlier: rs.length - current, last: last(rs) },
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const defined = new Set(workflows.map((w) => w.name));
    const undefinedRuns = [...runsOf.entries()].filter(([name]) => !defined.has(name)).map(([name, rs]) => ({ name, total: rs.length, last: last(rs) }));
    return { workflows, undefinedRuns, asOf: now!.now.toISOString() };
  });
