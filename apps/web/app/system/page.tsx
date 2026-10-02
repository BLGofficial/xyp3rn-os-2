import { adminLoaders, graphLoaders, runtime, shellLoaders } from '../../lib/server';
import { rescanAction } from '../graph-actions';
import { ErrorBanner, first, ScrollTable, Time } from '../ui';

export const dynamic = 'force-dynamic';

type Counts = {
  eligible: number; indexed: number; failed: number; unsupportedPaths: number; missing: number; unreadableDirs: number;
  excluded: Record<string, number>; vault: { present: number; missing: number; corrupt: number };
};

// System Admin (Jarvis Prompt 01, J1): the pulse, migrations, registries, roles and secrets (configured or not, never
// a value), then the index's scope and freshness (AOS-04 design §15.2 item 1, §13.1 "infrastructure details live
// under System"): what is indexed, what was left out and why (counted, never named), what failed, what doesn't resolve.
export default async function System({ searchParams: pendingSearchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await pendingSearchParams;
  const rt = await runtime();
  const sql = rt.sql;
  const gl = await graphLoaders();
  const [c, diags, unreadable, admin, pulse] = await Promise.all([
    gl.coverage(sql), gl.diagnostics(sql), gl.unreadableFiles(sql),
    (await adminLoaders()).adminOverview(sql, { env: process.env, registry: rt.deps.registry, tools: rt.deps.tools }),
    (await shellLoaders()).pulse(sql, process.env, rt.deps.registry),
  ]);
  const s = c.lastScan;
  const counts = (s?.counts ?? null) as Counts | null;
  const justRan = first(searchParams.scan);
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1>System Admin</h1>
        <span className="meta">as of <Time at={admin.asOf} /></span>
      </div>
      <ErrorBanner error={searchParams.error} />
      {justRan && s?.id === justRan && <p className="status-success mt-3" role="status">Scan {justRan.slice(0, 8)}… finished: {s.status}.</p>}

      <h2>System pulse</h2>
      <ScrollTable label="System pulse" className="mt-2">
        <tbody>
          {pulse.map((p) => (
            <tr key={p.label}><td>{p.label}</td><td><span className={`status-${p.state}`}>{p.state === 'not-configured' ? 'Not configured' : p.state === 'configured' ? 'Configured' : p.state}</span></td><td className="meta break-words">{p.detail}</td><td className="meta"><Time at={p.asOf} /></td></tr>
          ))}
        </tbody>
      </ScrollTable>
      <p className="meta mt-1">Only what was checked: a configured key is not a reachable provider.</p>

      <h2>Migrations</h2>
      <p className="text-sm" data-migrations>Head <code>{admin.migrations.head ?? 'none'}</code> · {admin.migrations.applied} applied <span className="meta">(xyp_meta.applied_migrations)</span></p>

      <h2>Registries</h2>
      <ScrollTable label="Registries" className="mt-2">
        <thead><tr><th>Registry</th><th>Count</th><th>Read from</th></tr></thead>
        <tbody>
          {admin.registries.map((r) => <tr key={r.name} data-registry={r.name}><td>{r.name}</td><td className="num">{r.count}</td><td className="meta">{r.source}</td></tr>)}
        </tbody>
      </ScrollTable>

      <h2>Database roles</h2>
      <p className="meta">One role per component, least privilege (names from pg_roles; grants live in the migrations).</p>
      <ul className="mt-2 flex flex-wrap gap-1" data-roles>{admin.roles.map((r) => <li key={r}><code className="tag">{r}</code></li>)}</ul>

      <h2>Secrets</h2>
      <p className="meta">Whether each provider key is set in the server's environment. Values are never read into a page.</p>
      <ul className="mt-2 flex flex-col gap-1 text-sm" data-secrets>
        {admin.secrets.map((x) => <li key={x.name}><code>{x.name}</code> <span className={x.configured ? 'status-configured' : 'status-not-configured'}>{x.configured ? 'Configured' : 'Not configured'}</span></li>)}
      </ul>

      <h2>File index</h2>
      <p className="meta">{c.nodes} entities in the graph as of <Time at={c.asOf} />. The index covers only the roots below; nothing outside them is read.</p>
      <ScrollTable label="Index roots" className="mt-2">
        <thead><tr><th>Root</th><th>Directory</th></tr></thead>
        <tbody>
          {c.roots.map((r) => <tr key={r.id}><td><code>{r.id}</code></td><td className="break-all"><code>{r.dir}</code></td></tr>)}
          {c.roots.length === 0 && <tr><td colSpan={2} className="meta">no scan has run yet</td></tr>}
        </tbody>
      </ScrollTable>

      <h2>Last scan</h2>
      {s ? (
        <ScrollTable label="Last scan" className="mt-2">
          <tbody>
            <tr><th>Scan</th><td><code>{s.id}</code> ({s.trigger})</td></tr>
            <tr><th>Status</th><td><span className={`status-${s.status === 'success' ? 'success' : s.status === 'error' ? 'failed' : 'running'}`}>{s.status}</span>{s.error ? <span className="meta"> · {s.error}</span> : null}</td></tr>
            <tr><th>Started / finished</th><td><Time at={s.startedAt} /> / <Time at={s.finishedAt} /></td></tr>
            {counts && (
              <>
                <tr><th>Files</th><td data-scan-counts>eligible {counts.eligible} · indexed {counts.indexed} · failed {counts.failed} (unsupported paths {counts.unsupportedPaths}) · missing {counts.missing}</td></tr>
                <tr><th>Excluded (counted, not named)</th><td>{Object.entries(counts.excluded).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}</td></tr>
                <tr><th>Vault bytes</th><td>present {counts.vault.present} · missing {counts.vault.missing} · corrupt {counts.vault.corrupt}</td></tr>
              </>
            )}
          </tbody>
        </ScrollTable>
      ) : <p className="meta">No scan yet.</p>}
      <p className="meta mt-2">Files now: present {c.files.present} · missing {c.files.missing} · unreadable {c.files.unreadable}.</p>

      <form action={rescanAction} className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="full" /> Full: rehash every file and re-read every Vault file</label>
        <button type="submit">Rescan now</button>
      </form>

      <h2>Could not be read ({unreadable.length})</h2>
      <ScrollTable label="Unreadable files">
        <tbody>
          {unreadable.map((f) => <tr key={f.id}><td className="break-all"><code>{f.path}</code></td><td className="meta">{f.error}</td><td><Time at={f.indexedAt} /></td></tr>)}
          {unreadable.length === 0 && <tr><td className="meta">none</td></tr>}
        </tbody>
      </ScrollTable>

      <h2>Diagnostics ({c.diagnostics.unresolved + c.diagnostics.dangling})</h2>
      <p className="meta">A reference to no file is unresolved; one naming an entity the graph doesn&apos;t hold is dangling. Neither is drawn as a connection.</p>
      <ScrollTable label="Diagnostics" className="mt-2">
        <thead><tr><th>Problem</th><th>Relation</th><th>Reference</th><th>Where</th></tr></thead>
        <tbody>
          {diags.map((d) => (
            <tr key={d.id}>
              <td><span className="status-warning">{d.problem}</span></td>
              <td>{d.relation}</td>
              <td className="break-all"><code>{d.detail ?? d.toId ?? '—'}</code></td>
              <td className="break-all">{d.fromId ? <a href={`/?node=${encodeURIComponent(d.fromId)}#inspector-h`}>{d.sourceRef}</a> : d.sourceRef}</td>
            </tr>
          ))}
          {diags.length === 0 && <tr><td colSpan={4} className="meta">none: every reference resolves</td></tr>}
        </tbody>
      </ScrollTable>
    </section>
  );
}
