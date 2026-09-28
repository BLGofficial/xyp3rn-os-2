import { graphLoaders, runtime } from '../../lib/server';
import { rescanAction } from '../graph-actions';
import { ErrorBanner, first, ScrollTable, Time } from '../ui';

export const dynamic = 'force-dynamic';

type Counts = {
  eligible: number; indexed: number; failed: number; unsupportedPaths: number; missing: number; unreadableDirs: number;
  excluded: Record<string, number>; vault: { present: number; missing: number; corrupt: number };
};

// The index's scope and freshness (AOS-04 design §15.2 item 1, §13.1 "infrastructure details live under System"):
// what is indexed, what was left out and why (counted, never named), what failed, and what doesn't resolve.
export default async function System({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const sql = (await runtime()).sql;
  const gl = await graphLoaders();
  const [c, diags, unreadable] = await Promise.all([gl.coverage(sql), gl.diagnostics(sql), gl.unreadableFiles(sql)]);
  const s = c.lastScan;
  const counts = (s?.counts ?? null) as Counts | null;
  const justRan = first(searchParams.scan);
  return (
    <section>
      <h1>System</h1>
      <ErrorBanner error={searchParams.error} />
      {justRan && s?.id === justRan && <p className="status-success mt-3" role="status">Scan {justRan.slice(0, 8)}… finished: {s.status}.</p>}

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
