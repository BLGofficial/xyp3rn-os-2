import { catalogLoaders, runtime } from '../../lib/server';
import { registerTrackAction } from '../catalog-actions';
import { AreaTabs, SONGS_RELEASES } from '../shell/tabs';
import { ErrorBanner, ScrollTable, Status, Time } from '../ui';

export const dynamic = 'force-dynamic';

export default async function Releases({ searchParams: pendingSearchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await pendingSearchParams;
  const rt = await runtime();
  const [releases, options] = await Promise.all([(await catalogLoaders()).releaseList(rt.sql), (await catalogLoaders()).recordingOptions(rt.sql)]);
  return (
    <section>
      <AreaTabs label="Songs & Releases" tabs={SONGS_RELEASES} current="/releases" />
      <h1>Releases</h1>
      <ErrorBanner error={searchParams.error} />
      <ScrollTable label="Releases" className="mt-4">
        <thead><tr><th>Release</th><th>Kind</th><th>Status</th><th>Date</th><th>UPC</th><th>Tracks</th><th>Blockers</th><th>Warnings</th><th>Created</th></tr></thead>
        <tbody>
          {releases.map((r) => (
            <tr key={r.id}>
              <td><a href={`/releases/${r.id}`}>{r.title}</a> <span className="meta">{r.artist}</span></td>
              <td>{r.kind}</td><td><Status status={r.status} /></td><td>{r.releaseDate ?? '—'}</td><td>{r.upc ?? '—'}</td>
              <td>{r.tracks}</td><td className={r.blockers ? 'text-fail' : ''}>{r.blockers}</td><td>{r.warnings}</td>
              <td className="meta"><Time at={r.createdAt} /></td>
            </tr>
          ))}
        </tbody>
      </ScrollTable>

      <h2>New release from a recording</h2>
      <form action={registerTrackAction} className="flex flex-wrap items-end gap-3">
        <label className="field">Recording
          <select name="recording" required defaultValue="">
            <option value="" disabled>choose…</option>
            {options.files.map((f) => <option key={f.id} value={`vault:${f.id}`}>Vault · {f.title}</option>)}
            {options.takes.map((t) => <option key={t.id} value={`take:${t.id}`}>Suno · {t.title}</option>)}
          </select>
        </label>
        <label className="field">Release title<input name="releaseTitle" required /></label>
        <label className="field">Artist<input name="releaseArtist" defaultValue="X3LIUS" required /></label>
        <label className="field">Kind<select name="releaseKind" defaultValue="single"><option>single</option><option>ep</option><option>album</option></select></label>
        <label className="field">Track title<input name="title" placeholder="default: the song's / formula's title" /></label>
        <input type="hidden" name="position" value="1" />
        <button type="submit">Register</button>
      </form>
    </section>
  );
}
