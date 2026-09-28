import { loaders, runtime } from '../../lib/server';
import { createSong } from '../actions';
import { AreaTabs, SONGS_RELEASES } from '../shell/tabs';
import { ErrorBanner, ScrollTable, Time } from '../ui';

export const dynamic = 'force-dynamic';

export default async function Songs({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const songs = await (await loaders()).songList((await runtime()).sql);
  return (
    <section>
      <AreaTabs label="Songs & Releases" tabs={SONGS_RELEASES} current="/songs" />
      <h1>Songs</h1>
      <ErrorBanner error={searchParams.error} />
      <ScrollTable label="Songs" className="mt-4">
        <thead><tr><th>Title</th><th>Artist</th><th>Status</th><th>Lang</th><th>Genre</th><th>Rev</th><th>Links</th><th>Created</th></tr></thead>
        <tbody>
          {songs.map((s) => (
            <tr key={s.id}>
              <td><a href={`/songs/${s.id}`}>{s.title}</a></td><td>{s.artist}</td><td>{s.status}</td><td>{s.language ?? '—'}</td>
              <td>{s.genre ?? '—'}</td><td>{s.revision}</td><td>{s.links}</td><td className="meta"><Time at={s.createdAt} /></td>
            </tr>
          ))}
        </tbody>
      </ScrollTable>
      <h2>New song</h2>
      <form action={createSong} className="flex flex-wrap items-end gap-3">
        <label className="field">Title<input name="title" required /></label>
        <label className="field">Artist<input name="artist" required defaultValue="X3LIUS" /></label>
        <label className="field">Language<input name="language" size={6} /></label>
        <label className="field">Genre<input name="genre" /></label>
        <button type="submit">Create</button>
      </form>
    </section>
  );
}
