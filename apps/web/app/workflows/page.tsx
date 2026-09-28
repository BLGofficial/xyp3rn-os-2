import { runtime, workflowsLoaders } from '../../lib/server';
import { DomainChip } from '../graph-ui';
import { ScrollTable, Status, Time } from '../ui';

export const dynamic = 'force-dynamic';

const node = (id: string) => `/?node=${encodeURIComponent(id)}`;

// Workflow Builder (Jarvis Prompt 01, J1): read-only until Prompt 14. What exists: each workflow file as the index
// read it (steps, agents, dependencies) and the runs recorded against it, current revision vs earlier ones.
export default async function Workflows() {
  const o = await (await workflowsLoaders()).workflowsOverview((await runtime()).sql);
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1>Workflow Builder</h1>
        <span className="meta">as of <Time at={o.asOf} /> · source: the file index, workflow_runs</span>
      </div>
      <p className="card mt-4 p-4" data-builder-state>
        Builder: not built (Prompt 14). These are the workflows that exist, read from their files and runs. Editing, versions, approvals and
        receipts arrive with Prompt 14.
      </p>

      <h2>Workflows ({o.workflows.length})</h2>
      {o.workflows.length === 0 && <p className="meta">No workflow file is in the index. Scan on <a href="/system">System Admin</a>.</p>}
      <div className="flex flex-col gap-4">
        {o.workflows.map((w) => (
          <article key={w.id} className="card" data-workflow={w.name}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="break-all"><a href={node(w.id)}>{w.name}</a></h3>
              <DomainChip domain={w.ownerDomain} />
            </div>
            <p className="meta mt-1 break-all">
              {w.fileId ? <a href={`/index/files/${w.fileId}`}>{w.sourceRef}</a> : w.sourceRef} · revision <code>{w.revision ? `${w.revision.slice(0, 12)}…` : 'unknown'}</code>
            </p>
            <p className="mt-2 text-sm" data-workflow-runs>
              {w.runs.total === 0 ? 'No recorded run.' : (
                <>
                  {w.runs.total} {w.runs.total === 1 ? 'run' : 'runs'}: {w.runs.current} of this revision, {w.runs.earlier} of earlier revisions ·
                  last <Status status={w.runs.last!.status} /> <Time at={w.runs.last!.at} />
                </>
              )}
            </p>
            <ScrollTable label={`Steps of ${w.name}`} className="mt-3">
              <thead><tr><th>Step</th><th>Agent</th><th>Depends on</th></tr></thead>
              <tbody>
                {w.steps.map((s) => (
                  <tr key={s.id}>
                    <td><a href={node(s.id)}>{s.step}</a></td>
                    <td>{s.agent ? <a href={node(`agent:${s.agent}`)}>{s.agent}</a> : '—'}</td>
                    <td>{s.dependsOn.length ? s.dependsOn.join(', ') : '—'}</td>
                  </tr>
                ))}
                {w.steps.length === 0 && <tr><td colSpan={3} className="meta">no step declared</td></tr>}
              </tbody>
            </ScrollTable>
          </article>
        ))}
      </div>

      <h2>Runs with no definition file ({o.undefinedRuns.length})</h2>
      <p className="meta">Recorded runs whose workflow name matches no workflow file: plans generated at run time (research runs record theirs as
        research-specialists). Listed as recorded, never matched to a file by guess.</p>
      <ScrollTable label="Runs with no definition file" className="mt-2">
        <thead><tr><th>Workflow name</th><th>Runs</th><th>Last</th></tr></thead>
        <tbody>
          {o.undefinedRuns.map((r) => (
            <tr key={r.name} data-undefined-run={r.name}>
              <td className="break-all">{r.name}</td><td className="num">{r.total}</td>
              <td>{r.last ? <><Status status={r.last.status} /> <Time at={r.last.at} /></> : '—'}</td>
            </tr>
          ))}
          {o.undefinedRuns.length === 0 && <tr><td colSpan={3} className="meta">none</td></tr>}
        </tbody>
      </ScrollTable>
    </section>
  );
}
