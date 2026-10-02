import { notFound } from 'next/navigation';
import { loaders, runtime } from '../../../../lib/server';
import { indexFileAction } from '../../../actions';
import { ErrorBanner, ScrollTable, SongLinks, Tags, Time } from '../../../ui';

export const dynamic = 'force-dynamic';

export default async function File({ params: pendingParams, searchParams: pendingSearchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await pendingParams;
  const searchParams = await pendingSearchParams;
  const f = await (await loaders()).fileDetail((await runtime()).sql, params.id);
  if (!f) notFound();
  const raw = `/vault/files/${f.id}/raw`;
  return (
    <section>
      <h1>{f.title}</h1>
      <ErrorBanner error={searchParams.error} />
      <ScrollTable label="File details" className="mt-4">
        <tbody>
          <tr><th>Class</th><td>{f.mediaClass}</td></tr>
          <tr><th>Language</th><td>{f.language ?? '—'}</td></tr>
          <tr><th>Original name</th><td>{f.filename ?? '—'}</td></tr>
          <tr><th>sha256</th><td className="break-all">{f.sha256}</td></tr>
          <tr><th>Size / type</th><td>{f.byteSize ?? '—'} bytes · {f.mimeType ?? '—'}</td></tr>
          <tr><th>Added by</th><td>{f.run ? <>{f.run.agentName} run <code>{f.run.id}</code> ({f.run.status}) at <Time at={f.run.createdAt} /></> : '—'}</td></tr>
          <tr><th>Tags</th><td><Tags tags={f.tags} /></td></tr>
          <tr><th>Songs</th><td><SongLinks songs={f.songs} /></td></tr>
          <tr><th>Bytes</th><td><a href={raw}>open from the store</a></td></tr>
          <tr><th>Saved</th><td><span className="status-success">Saved</span> <Time at={f.createdAt} /> <span className="meta">· in the graph and name search from now on</span></td></tr>
          <tr>
            <th>Indexed for Vault search</th>
            <td>
              {f.indexed
                ? <><span className="status-success" data-indexed="yes">Indexed</span> <Time at={f.indexed.at} /> <span className="meta">· {f.indexed.model}</span></>
                : <span className="status-pending_approval" data-indexed="no">Not indexed yet</span>}
              {!f.indexed && (
                <form action={indexFileAction} className="mt-2">
                  <input type="hidden" name="fileId" value={f.id} />
                  <button type="submit">{searchParams.error ? 'Retry indexing' : 'Index now'}</button>
                  <span className="meta ml-2">indexes every pending Vault entity, as <code>pnpm embed</code> does</span>
                </form>
              )}
            </td>
          </tr>
        </tbody>
      </ScrollTable>
      {f.mediaClass === 'audio' && <audio className="mt-4 w-full" controls src={raw} />}
      {f.mediaClass === 'image' && <img className="mt-4 max-w-full rounded-control border border-line" src={raw} alt={f.title} />}
      {f.text !== null && (
        <>
          <h2>Text ({f.extractor})</h2>
          <pre>{f.text}</pre>
        </>
      )}
    </section>
  );
}
