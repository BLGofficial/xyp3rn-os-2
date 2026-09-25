import { notFound } from 'next/navigation';
import { loaders, runtime } from '../../../../lib/server';
import { ErrorBanner, SongLinks, Tags, Time } from '../../../ui';

export const dynamic = 'force-dynamic';

export default async function File({ params, searchParams }: { params: { id: string }; searchParams: Record<string, string | string[] | undefined> }) {
  const f = await (await loaders()).fileDetail((await runtime()).sql, params.id);
  if (!f) notFound();
  const raw = `/vault/files/${f.id}/raw`;
  return (
    <section>
      <h1>{f.title}</h1>
      <ErrorBanner error={searchParams.error} />
      <table className="mt-4">
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
        </tbody>
      </table>
      {f.mediaClass === 'audio' && <audio className="mt-4 w-full" controls src={raw} />}
      {f.mediaClass === 'image' && <img className="mt-4 max-w-full border-2 border-paper" src={raw} alt={f.title} />}
      {f.text !== null && (
        <>
          <h2>Text ({f.extractor})</h2>
          <pre>{f.text}</pre>
        </>
      )}
    </section>
  );
}
