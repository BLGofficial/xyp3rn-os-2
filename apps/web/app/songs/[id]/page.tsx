import { notFound } from 'next/navigation';
import { loaders, runtime } from '../../../lib/server';
import { linkSong, reviseSong, unlinkSong } from '../../actions';
import { ErrorBanner, Time } from '../../ui';

export const dynamic = 'force-dynamic';

const STATUSES = ['idea', 'writing', 'producing', 'releasing', 'released', 'archived'];

const Unlink = ({ songId, linkId }: { songId: string; linkId: string }) => (
  <form action={unlinkSong} className="flex gap-1">
    <input type="hidden" name="songId" value={songId} />
    <input type="hidden" name="linkId" value={linkId} />
    <input name="reason" placeholder="why" required size={10} aria-label="unlink reason" />
    <button className="px-1 text-xs">Unlink</button>
  </form>
);

export default async function Song({ params, searchParams }: { params: { id: string }; searchParams: Record<string, string | string[] | undefined> }) {
  const d = await (await loaders()).songDetail((await runtime()).sql, params.id);
  if (!d) notFound();
  const { song } = d;
  return (
    <section>
      <h1>{song.title}</h1>
      <p className="meta mt-1">{song.artist} · {song.status} · revision {song.revision} · {song.language ?? 'no language'} · {song.genre ?? 'no genre'}</p>
      <ErrorBanner error={searchParams.error} />

      <h2>Lyrics</h2>
      <table>
        <thead><tr><th>Lineage</th><th>Role</th><th>Latest</th><th>Approved</th><th /></tr></thead>
        <tbody>{d.lyrics.map((l) => (
          <tr key={l.linkId}>
            <td><a href={`/vault/lineages/${l.lineageId}`}>{l.title}</a></td><td>{l.role ?? '—'}</td><td>v{l.latestVersion}</td>
            <td>{l.approvedVersion ? <span className="status-approved">v{l.approvedVersion}</span> : <span className="meta">none</span>}</td>
            <td><Unlink songId={song.id} linkId={l.linkId} /></td>
          </tr>
        ))}</tbody>
      </table>

      <h2>Files</h2>
      <table>
        <tbody>{d.files.map((f) => (
          <tr key={f.linkId}><td><a href={`/vault/files/${f.id}`}>{f.title}</a></td><td>{f.mediaClass ?? 'knowledge source'}</td><td>{f.role ?? '—'}</td><td><Unlink songId={song.id} linkId={f.linkId} /></td></tr>
        ))}</tbody>
      </table>

      <h2>Takes, tracks, research</h2>
      <table>
        <tbody>
          {d.takes.map((t) => <tr key={t.linkId}><td>take</td><td>{t.title ?? t.id}</td><td className="break-all meta">{t.audioUrl}</td><td><Unlink songId={song.id} linkId={t.linkId} /></td></tr>)}
          {d.tracks.map((t) => <tr key={t.linkId}><td>track</td><td>{t.title}</td><td className="meta">{t.releaseTitle} ({t.releaseStatus})</td><td><Unlink songId={song.id} linkId={t.linkId} /></td></tr>)}
          {d.research.map((r) => <tr key={r.linkId}><td>research</td><td>{r.question}</td><td /><td><Unlink songId={song.id} linkId={r.linkId} /></td></tr>)}
        </tbody>
      </table>

      <h2>Link</h2>
      <form action={linkSong} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="songId" value={song.id} />
        <label className="field">Kind<select name="kind"><option value="artifact">lyrics / artifact</option><option value="file">file</option><option value="take">take</option><option value="track">track</option><option value="question">research question</option></select></label>
        <label className="field">Id<input name="targetId" required size={38} /></label>
        <label className="field">Role<input name="role" size={12} /></label>
        <button type="submit">Link</button>
      </form>

      <h2>Revise</h2>
      <form action={reviseSong} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="songId" value={song.id} />
        <label className="field">Title<input name="title" placeholder={song.title} /></label>
        <label className="field">Status<select name="status" defaultValue=""><option value="">unchanged</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label className="field">Genre<input name="genre" placeholder={song.genre ?? ''} /></label>
        <label className="field">Language<input name="language" placeholder={song.language ?? ''} size={6} /></label>
        <label className="field grow">Notes<input name="notes" placeholder={song.notes ?? ''} /></label>
        <button type="submit">Save revision</button>
      </form>

      <h2>Revisions</h2>
      <table>
        <thead><tr><th>Rev</th><th>Title</th><th>Status</th><th>Genre</th><th>Lang</th><th>At</th><th>Run</th></tr></thead>
        <tbody>{d.revisions.map((r) => (
          <tr key={r.revision}><td>{r.revision}</td><td>{r.title}</td><td>{r.status}</td><td>{r.genre ?? '—'}</td><td>{r.language ?? '—'}</td><td className="meta"><Time at={r.createdAt} /></td><td className="meta"><code>{r.runId}</code></td></tr>
        ))}</tbody>
      </table>
    </section>
  );
}
