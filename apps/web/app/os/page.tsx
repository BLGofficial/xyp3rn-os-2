import { graphLoaders, osLoaders, runtime } from '../../lib/server';
import { upload } from '../actions';
import { Sphere } from '../graph/sphere';
import { first, Time } from '../ui';
import { applyObsidianSync } from './os-actions';
import './os.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'XYP3RN OS · Dashboard' };

// The unified OS dashboard (F54): Research, Knowledge with the two-way Obsidian sync, Records' audio library,
// import, the knowledge graph and the context view, on one page in Brand Kit 2026. Every panel reads on its own;
// a failed read shows its error in that panel and never a zero. Writes go through the existing actions.

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
const settle = async <T,>(p: Promise<T>): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    console.error('/os panel failed:', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

const Unavailable = ({ error }: { error: string }) => (
  <p className="os-status" data-tone="danger" role="alert">x UNAVAILABLE <span className="os-muted normal-case tracking-normal">{error}</span></p>
);
const Stat = ({ label, value }: { label: string; value: Settled<number> }) => (
  <div className="os-stat">
    <div className="os-label">{label}</div>
    {value.ok ? <div className="os-stat-n">{value.value}</div> : <div className="os-stat-n" data-unavailable>UNAVAILABLE</div>}
  </div>
);
const Head = ({ id, shape, domain, title, children }: { id: string; shape: string; domain: string; title: string; children?: React.ReactNode }) => (
  <div className="os-panel-head">
    <div>
      <div className="os-label"><span className="os-shape" data-shape={shape} aria-hidden="true" />{domain}</div>
      <h2 id={id}>{title}</h2>
    </div>
    {children}
  </div>
);
const bytes = (n: number | null) => (n === null ? 'size unknown' : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export default async function OsDashboard({ searchParams: pendingSearchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await pendingSearchParams;
  const rt = await runtime();
  const ol = await osLoaders();
  const gl = await graphLoaders();
  const q = (first(searchParams.q) ?? '').trim();
  const [research, knowledge, audio, obsidian, cov, context] = await Promise.all([
    settle(ol.researchSummary(rt.sql)),
    settle(ol.knowledgeSummary(rt.sql)),
    settle(ol.audioLibrary(rt.sql, 30)),
    ol.obsidianPanel(rt.sql, process.env),
    settle(gl.coverage(rt.sql)),
    q ? settle(rt.engine().then((e) => e.retrieve(q, { corpus: 'vault', limit: 10 }))) : Promise.resolve(null),
  ]);
  const map = <T, U>(s: Settled<T>, f: (v: T) => U): Settled<U> => (s.ok ? { ok: true, value: f(s.value) } : s);
  const error = first(searchParams.error);
  const synced = first(searchParams.synced) === '1';

  return (
    <div className="os">
      <header>
        <div className="os-label">XYP3RN Agentic OS</div>
        <h1 className="os-title">Command dashboard</h1>
        <p className="os-muted mt-1">Research, knowledge, records and the graph on one page. Every number is read from the database or your vault now.</p>
      </header>

      <section aria-label="Totals" className="os-stats">
        <Stat label="Vault files" value={map(knowledge, (k) => k.vaultFiles.reduce((n, f) => n + f.count, 0))} />
        <Stat label="Audio files" value={map(audio, (a) => a.total)} />
        <Stat label="Open briefs" value={map(research, (r) => r.openBriefs)} />
        <Stat label="Accepted findings" value={map(research, (r) => r.acceptedFindings)} />
        <Stat label="Obsidian notes in Vault" value={map(knowledge, (k) => k.obsidianImports)} />
        <Stat label="Canonical prompts" value={map(knowledge, (k) => k.canonicalPrompts)} />
      </section>

      {error && <p className="os-notice" data-tone="danger" role="alert"><span className="os-status" data-tone="danger">x ERROR</span> {error}</p>}
      {synced && (
        <p className="os-notice" data-tone="ok" role="status">
          <span className="os-status" data-tone="ok">✓ SYNCED</span> {first(searchParams.imported) ?? '0'} imported, {first(searchParams.exported) ?? '0'} exported, {first(searchParams.failed) ?? '0'} failed.{' '}
          Each step is an agent run on <a href="/system">System</a>.
        </p>
      )}

      <div className="os-grid">
        {/* ─── Knowledge / Obsidian (the featured slab) ─── */}
        <section id="obsidian" className="os-panel os-featured os-wide" aria-labelledby="obsidian-h">
          <Head id="obsidian-h" shape="square" domain="Knowledge" title="Obsidian vault · two-way sync">
            {obsidian.state === 'ready' && <span className="os-chip">Last sync {obsidian.lastSync ? <Time at={obsidian.lastSync} /> : 'never'}</span>}
          </Head>
          {obsidian.state === 'not-configured' && (
            <p className="os-status" data-tone="info">• NOT CONFIGURED <span className="os-muted normal-case tracking-normal">Set <code>{obsidian.envVar}</code> to your vault folder and restart the web server.</span></p>
          )}
          {obsidian.state === 'error' && <Unavailable error={obsidian.error} />}
          {obsidian.state === 'ready' && (
            <>
              <p className="os-mono os-muted">{obsidian.root}{obsidian.adjusted ? '  (the configured path was the .obsidian settings folder; this is its vault)' : ''}</p>
              <div className="os-stats" style={{ marginBottom: 12 }}>
                <Stat label="Notes" value={{ ok: true, value: obsidian.graph.notes }} />
                <Stat label="Note links" value={{ ok: true, value: obsidian.graph.links }} />
                <Stat label="Unresolved links" value={{ ok: true, value: obsidian.graph.unresolved.length }} />
                <Stat label="To import" value={{ ok: true, value: obsidian.counts.import }} />
                <Stat label="To export" value={{ ok: true, value: obsidian.counts.export }} />
                <Stat label="Conflicts" value={{ ok: true, value: obsidian.counts.conflicts }} />
              </div>
              <p className="os-muted">
                Notes you add or change come into the Creative Vault as your documents. Songs and accepted findings are written to <code>XYP3RN OS/</code> in the vault.
                A note there that you edited is never overwritten: it is a conflict, and your edit is imported instead. Nothing is deleted on either side.
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h3>Plan · {obsidian.counts.unchanged} unchanged{obsidian.counts.skipped ? ` · ${obsidian.counts.skipped} over 2 MB skipped` : ''}{obsidian.counts.gone ? ` · ${obsidian.counts.gone} gone since last sync` : ''}</h3>
                  {obsidian.actions.length === 0 ? <p className="os-status" data-tone="ok">✓ IN SYNC</p> : (
                    <ul className="os-list">
                      {obsidian.actions.map((a) => (
                        <li key={`${a.kind}:${a.rel}`} className="os-row">
                          <span className="os-status" data-tone="info">{a.kind === 'import' ? '↓ IMPORT' : a.update ? '↑ UPDATE' : '↑ CREATE'}</span> <code>{a.rel}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                  {obsidian.counts.import + obsidian.counts.export > obsidian.actions.length && <p className="os-muted">and {obsidian.counts.import + obsidian.counts.export - obsidian.actions.length} more</p>}
                  {obsidian.conflicts.length > 0 && (
                    <>
                      <h3>Conflicts (not written)</h3>
                      <ul className="os-list">
                        {obsidian.conflicts.map((c) => <li key={c.rel} className="os-row"><span className="os-status" data-tone="warn">! WARN</span> <code>{c.rel}</code><div className="os-muted">{c.reason}</div></li>)}
                      </ul>
                    </>
                  )}
                  {obsidian.actions.length > 0 && (
                    <form action={applyObsidianSync} className="os-inline mt-4">
                      <input type="hidden" name="planHash" value={obsidian.planHash} />
                      <button type="submit" className="os-primary">Apply this plan</button>
                      <span className="os-mono os-muted" title={obsidian.planHash}>plan {obsidian.planHash.slice(0, 12)}</span>
                    </form>
                  )}
                </div>
                <div>
                  <h3>Most linked notes</h3>
                  {obsidian.graph.top.length === 0 ? <p className="os-muted">No note links to another yet.</p> : (
                    <ul className="os-list">
                      {obsidian.graph.top.map((t) => <li key={t.rel} className="os-row"><code>{t.rel}</code> <span className="os-chip">{t.backlinks} backlinks</span></li>)}
                    </ul>
                  )}
                  {obsidian.graph.unresolved.length > 0 && (
                    <>
                      <h3>Links to nothing</h3>
                      <ul className="os-list">
                        {obsidian.graph.unresolved.slice(0, 8).map((u) => <li key={`${u.from}:${u.target}`} className="os-row"><code>{u.from}</code> → <code>[[{u.target}]]</code></li>)}
                      </ul>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </section>

        {/* ─── Research ─── */}
        <section className="os-panel" aria-labelledby="research-h">
          <Head id="research-h" shape="circle" domain="Research intelligence" title="Research"><a href="/research" className="os-button">Open research</a></Head>
          {!research.ok ? <Unavailable error={research.error} /> : (
            <>
              <p>
                <span className="os-chip">{research.value.openBriefs} open briefs</span>{' '}
                <span className="os-chip">{research.value.undecidedFindings} findings awaiting you</span>{' '}
                <a href="/research/library" className="os-chip no-underline">{research.value.acceptedFindings} in the library</a>
              </p>
              <h3>Latest runs</h3>
              {research.value.runs.length === 0 ? <p className="os-muted">No research run yet. Start one from a brief on <a href="/research">Research</a>.</p> : (
                <ul className="os-list">
                  {research.value.runs.map((r) => (
                    <li key={r.id} className="os-row">
                      <span className="os-status" data-tone={r.status === 'success' ? 'ok' : r.status === 'error' ? 'danger' : 'info'}>
                        {r.status === 'success' ? '✓ DONE' : r.status === 'error' ? 'x ERROR' : '▲ RUNNING'}
                      </span>{' '}
                      <a href={`/research/runs/${r.id}`}>{r.question}</a> <span className="os-muted"><Time at={r.createdAt} /></span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        {/* ─── Import ─── */}
        <section className="os-panel" aria-labelledby="import-h">
          <Head id="import-h" shape="square" domain="Knowledge" title="Import"><a href="/ingest" className="os-button">Ingest page</a></Head>
          <p className="os-muted">Files go into the Creative Vault as your material, one agent run each. They become canonical knowledge only through the Promotion Gate.</p>
          <form action={upload} className="os-inline">
            <label className="os-field os-label">Files<input type="file" name="files" multiple required /></label>
            <label className="os-field os-label">As
              <select name="as" defaultValue=""><option value="">from the extension</option><option value="lyric_sheet">lyric sheet</option><option value="document">document</option><option value="audio">audio</option><option value="image">image</option><option value="other">other</option></select>
            </label>
            <label className="os-field os-label">Language<input name="language" placeholder="en, bg, mixed" size={8} /></label>
            <label className="os-field os-label">Tags<input name="tags" placeholder="new-era, demo" /></label>
            <button type="submit">Add to Vault</button>
          </form>
          {knowledge.ok && knowledge.value.vaultFiles.length > 0 && (
            <>
              <h3>In the Vault</h3>
              <p>{knowledge.value.vaultFiles.map((f) => <a key={f.mediaClass} href={`/vault?kind=${f.mediaClass}`} className="os-chip no-underline mr-2">{f.count} {f.mediaClass.replace('_', ' ')}</a>)}</p>
            </>
          )}
        </section>

        {/* ─── Records / Audio library ─── */}
        <section className="os-panel os-wide" aria-labelledby="audio-h">
          <Head id="audio-h" shape="diamond" domain="Records" title="Audio library"><a href="/vault?kind=audio" className="os-button">All audio</a></Head>
          {!audio.ok ? <Unavailable error={audio.error} /> : audio.value.items.length === 0 ? (
            <p className="os-muted">No audio in the Vault yet. Add a bounce, a demo or a Suno take with Import.</p>
          ) : (
            <>
              <p className="os-muted">Showing {audio.value.items.length} of {audio.value.total}, newest first. Playback streams the stored bytes; nothing is transcoded.</p>
              <ul className="os-list md:grid md:grid-cols-2 md:gap-4">
                {audio.value.items.map((a) => (
                  <li key={a.id} className="os-row">
                    <a href={`/vault/files/${a.id}`}>{a.title}</a>{' '}
                    <span className="os-mono os-muted">{a.mimeType ?? 'type unknown'} · {bytes(a.byteSize)}{a.language ? ` · ${a.language}` : ''}</span>
                    <div className="os-muted">
                      {a.songs.length > 0 ? a.songs.map((s) => <a key={s.id} href={`/songs/${s.id}`} className="mr-2">{s.title}</a>) : 'No song linked'}
                      {a.tracks.map((t) => <span key={t.id} className="os-chip mr-2">Track · {t.releaseTitle}</span>)}
                      {a.takes.map((t) => <span key={t.id} className="os-chip mr-2">Suno take · {t.rating === null ? 'not rated' : `rated ${t.rating}/5`}</span>)}
                    </div>
                    <audio controls preload="none" src={`/vault/files/${a.id}/raw`} aria-label={`Play ${a.title}`} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {/* ─── Graph ─── */}
        <section className="os-panel" aria-labelledby="graph-h">
          <Head id="graph-h" shape="circle" domain="Core" title="Knowledge graph"><a href="/hud" className="os-button">HUD</a></Head>
          {!cov.ok ? <Unavailable error={cov.error} /> : (
            <>
              <p className="os-muted">The indexed graph: {cov.value.nodes} entities, last scanned {cov.value.lastScan ? <Time at={cov.value.lastScan.finishedAt ?? cov.value.lastScan.startedAt} /> : 'never'}.</p>
              <div className="os-graph"><Sphere selected={null} scanKey={`${cov.value.lastScan?.id ?? 'none'}:${cov.value.nodes}`} /></div>
            </>
          )}
        </section>

        {/* ─── Context view ─── */}
        <section id="context" className="os-panel" aria-labelledby="context-h">
          <Head id="context-h" shape="circle" domain="Core" title="Context view" />
          <p className="os-muted">What the Context Engine retrieves for a question, ranked, from knowledge and the Vault. Bars are cosine similarity.</p>
          <form action="/os#context" method="get" role="search" className="os-inline">
            <label className="os-field os-label grow">Question<input name="q" type="search" defaultValue={q} placeholder="a lyric line, a technique, a song" className="w-full" /></label>
            <button type="submit">Retrieve</button>
          </form>
          {context && !context.ok && <Unavailable error={context.error} />}
          {context?.ok && (context.value.items.length === 0 ? <p className="os-muted mt-3">Nothing retrieved for “{q}”. New material is searchable after <code>pnpm embed</code>.</p> : (
            <>
              <svg className="os-bars mt-3" viewBox={`0 0 600 ${context.value.items.length * 28}`} role="img" aria-label={`Retrieved items for ${q}, by similarity`}>
                {context.value.items.map((it, i) => (
                  <g key={`${it.kind}:${it.id}`} transform={`translate(0 ${i * 28})`}>
                    <rect x="0" y="4" width="600" height="18" style={{ fill: 'var(--surface-slab)' }} />
                    <rect x="0" y="4" width={Math.max(2, Math.min(1, Math.max(0, it.similarity)) * 600)} height="18" style={{ fill: i === 0 ? 'var(--logo-gold)' : 'var(--accent-warm)' }} />
                    <text x="6" y="17" style={{ fill: 'var(--on-accent-fill)' }}>{it.similarity.toFixed(3)}</text>
                  </g>
                ))}
              </svg>
              <ol className="os-list mt-2">
                {context.value.items.map((it) => (
                  <li key={`${it.kind}:${it.id}`} className="os-row">
                    <span className="os-chip mr-2">{it.kind}</span>
                    {it.lineage ? <a href={`/vault/lineages/${it.lineage.id}`}>{it.title}</a> : it.kind === 'file' ? <a href={`/vault/files/${it.id}`}>{it.title}</a> : it.title}
                    <span className="os-mono os-muted"> · {it.similarity.toFixed(3)}</span>
                    <div className="os-muted">{it.snippet}</div>
                  </li>
                ))}
              </ol>
            </>
          ))}
        </section>
      </div>
    </div>
  );
}
