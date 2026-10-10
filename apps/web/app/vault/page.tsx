import UnifiedGraphExplorer from '../../components/UnifiedGraphExplorer';
import { loaders, runtime } from '../../lib/server';
import { ErrorBanner, first, ScrollTable, SongLinks, Tags, Time } from '../ui';

export const dynamic = 'force-dynamic';

const KINDS = ['lyrics', 'lyric_sheet', 'document', 'audio', 'image', 'other'];

export default async function Vault({ searchParams: pendingSearchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await pendingSearchParams;
  const q = first(searchParams.q);
  const filter = { kind: first(searchParams.kind), songId: first(searchParams.song), tag: first(searchParams.tag), language: first(searchParams.language) };
  const defined = Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined));
  const rt = await runtime();
  const [{ files, lineages }, songs, search] = await Promise.all([
    (await loaders()).listVault(rt.sql, defined),
    (await loaders()).songList(rt.sql),
    q ? (await rt.engine()).retrieve(q, { corpus: 'vault', limit: 12 }) : Promise.resolve(null),
  ]);
  return (
    <section>
      <h1>Creative Vault</h1>
      <div className="mt-4"><UnifiedGraphExplorer /></div>
      <ErrorBanner error={searchParams.error} />
      <form className="mt-4 flex flex-wrap items-end gap-3" method="get">
        <label className="field grow">Search (vault corpus)<input name="q" defaultValue={q ?? ''} placeholder="a lyric line, a note, a finding…" /></label>
        <label className="field">Kind<select name="kind" defaultValue={filter.kind ?? ''}><option value="">all</option>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></label>
        <label className="field">Song<select name="song" defaultValue={filter.songId ?? ''}><option value="">all</option>{songs.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
        <label className="field">Tag<input name="tag" defaultValue={filter.tag ?? ''} size={10} /></label>
        <label className="field">Lang<input name="language" defaultValue={filter.language ?? ''} size={5} /></label>
        <button type="submit">Filter</button>
      </form>

      {search && (
        <>
          <h2>Search: {search.query}</h2>
          <p className="meta">{search.model} · {search.diagnostics.knowledgeHits} knowledge + {search.diagnostics.vaultHits} vault hits · run `pnpm embed` after adding material</p>
          <ScrollTable label="Search results">
            <thead><tr><th>Sim</th><th>Kind</th><th>Item</th><th>Songs</th></tr></thead>
            <tbody>
              {search.items.map((i) => (
                <tr key={`${i.kind}:${i.id}`}>
                  <td>{i.similarity.toFixed(3)}</td>
                  <td>{i.kind}{i.lineage ? ` v${i.lineage.version}` : ''}</td>
                  <td>
                    {i.lineage ? <a href={`/vault/lineages/${i.lineage.id}`}>{i.title}</a> : i.kind === 'file' ? <a href={`/vault/files/${i.id}`}>{i.title}</a> : i.title}
                    <div className="meta">{i.snippet}</div>
                  </td>
                  <td><SongLinks songs={i.songs} /></td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        </>
      )}

      <h2>Lyrics ({lineages.length})</h2>
      <ScrollTable label="Lyrics">
        <thead><tr><th>Lineage</th><th>Latest</th><th>Approved</th><th>Lang</th><th>Songs</th><th>Created</th></tr></thead>
        <tbody>
          {lineages.map((l) => (
            <tr key={l.lineageId}>
              <td><a href={`/vault/lineages/${l.lineageId}`}>{l.title}</a></td>
              <td>v{l.latestVersion}</td>
              <td>{l.approvedVersion ? <span className="status-approved">v{l.approvedVersion}</span> : <span className="meta">none</span>}</td>
              <td>{l.language ?? '—'}</td>
              <td><SongLinks songs={l.songs} /></td>
              <td className="meta"><Time at={l.createdAt} /></td>
            </tr>
          ))}
        </tbody>
      </ScrollTable>

      <h2>Files ({files.length})</h2>
      <ScrollTable label="Files">
        <thead><tr><th>File</th><th>Class</th><th>Lang</th><th>Tags</th><th>Songs</th><th>Added</th></tr></thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.id}>
              <td><a href={`/vault/files/${f.id}`}>{f.title}</a></td>
              <td>{f.mediaClass}</td>
              <td>{f.language ?? '—'}</td>
              <td><Tags tags={f.tags} /></td>
              <td><SongLinks songs={f.songs} /></td>
              <td className="meta"><Time at={f.createdAt} /></td>
            </tr>
          ))}
        </tbody>
      </ScrollTable>
    </section>
  );
}
