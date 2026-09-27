import { notFound } from 'next/navigation';
import { catalogLoaders, loaders, researchLoaders, runtime, studioLoaders } from '../../../lib/server';
import { linkSong, reviseSong, unlinkSong } from '../../actions';
import { registerTrackAction } from '../../catalog-actions';
import { buildPackageAction } from '../../studio-actions';
import { Checks, CreditForm, Credits, TaskForm, Tasks } from '../../catalog-ui';
import { ResearchSection } from '../../research/research-ui';
import { ErrorBanner, ScrollTable, Status, Time } from '../../ui';

export const dynamic = 'force-dynamic';

const STATUSES = ['idea', 'writing', 'producing', 'releasing', 'released', 'archived'];

const Unlink = ({ songId, linkId }: { songId: string; linkId: string }) => (
  <form action={unlinkSong} className="flex gap-1">
    <input type="hidden" name="songId" value={songId} />
    <input type="hidden" name="linkId" value={linkId} />
    <input name="reason" placeholder="why" required size={10} aria-label="unlink reason" />
    <button className="btn-quiet">Unlink</button>
  </form>
);

export default async function Song({ params, searchParams }: { params: { id: string }; searchParams: Record<string, string | string[] | undefined> }) {
  const rt = await runtime();
  const [d, w] = await Promise.all([(await loaders()).songDetail(rt.sql, params.id), (await catalogLoaders()).songWorkspace(rt.sql, params.id)]);
  if (!d || !w) notFound();
  const { song } = d;
  // After the existence check: the id is cast to uuid there, so a malformed one must 404 first.
  const [options, studio, research] = await Promise.all([
    (await catalogLoaders()).recordingOptions(rt.sql, song.id), (await studioLoaders()).songStudio(rt.sql, song.id), (await researchLoaders()).researchFor(rt.sql, { songId: song.id }),
  ]);
  const optionLabel = (o: { name: string; version: number; status: string }) => `${o.name} v${o.version} (${o.status})`;
  const back = `/songs/${song.id}`;
  return (
    <section>
      <h1>{song.title}</h1>
      <p className="meta mt-1">
        {song.artist} · {song.status} · release stage <Status status={w.releaseStage} /> · revision {song.revision} · {song.language ?? 'no language'} · {song.genre ?? 'no genre'}
      </p>
      <ErrorBanner error={searchParams.error} />

      <h2>Checks</h2>
      <Checks checks={w.checks} />

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h2>Credits</h2>
          <Credits credits={w.credits} back={back} />
          <CreditForm target={{ songId: song.id }} back={back} />
        </div>
        <div>
          <h2>Releases</h2>
          <ul className="text-sm">
            {w.releases.map((r) => <li key={r.id}><a href={`/releases/${r.id}`}>{r.title}</a> <Status status={r.status} /> <span className="meta">{r.releaseDate ?? 'no date'}</span></li>)}
            {w.releases.length === 0 && <li className="meta">on no release</li>}
          </ul>
          {options.files.length > 0 ? (
            <form action={registerTrackAction} className="mt-2 flex flex-wrap items-end gap-2">
              <input type="hidden" name="songId" value={song.id} />
              <input type="hidden" name="position" value="1" />
              <label className="field">Recording
                <select name="recording" required defaultValue="">
                  <option value="" disabled>choose…</option>
                  {options.files.map((f) => <option key={f.id} value={`vault:${f.id}`}>{f.title}</option>)}
                </select>
              </label>
              <label className="field">New release<input name="releaseTitle" required defaultValue={song.title} /></label>
              <label className="field">Kind<select name="releaseKind" defaultValue="single"><option>single</option><option>ep</option><option>album</option></select></label>
              <input type="hidden" name="releaseArtist" value={song.artist} />
              <button type="submit">Register on a new release</button>
            </form>
          ) : <p className="meta">link an audio file to this song to register it on a release</p>}
        </div>
      </div>

      <h2>Studio</h2>
      {studio.lyrics.length === 0 || studio.recipes.length === 0 || studio.tagSets.length === 0 ? (
        <p className="meta">
          A Suno package needs a lyric version linked to this song, a style recipe and a meta-tag set
          ({[studio.lyrics.length === 0 && 'no lyrics', studio.recipes.length === 0 && 'no recipe', studio.tagSets.length === 0 && 'no tag set'].filter(Boolean).join(', ')}): see <a href="/studio">Studio</a>.
        </p>
      ) : (
        <form action={buildPackageAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="songId" value={song.id} />
          <label className="field">Lyrics<select name="lyricsArtifactId" required>{studio.lyrics.map((o) => <option key={o.id} value={o.id}>{optionLabel(o)}</option>)}</select></label>
          <label className="field">Style recipe<select name="styleRecipeArtifactId" required>{studio.recipes.map((o) => <option key={o.id} value={o.id}>{optionLabel(o)}</option>)}</select></label>
          <label className="field">Tag set<select name="tagSetArtifactId" required>{studio.tagSets.map((o) => <option key={o.id} value={o.id}>{optionLabel(o)}</option>)}</select></label>
          <label className="field">Title<input name="title" required defaultValue={song.title} /></label>
          <label className="field">Suno model<input name="sunoModel" required defaultValue="v5" size={6} /></label>
          <button type="submit">Build Suno package</button>
        </form>
      )}
      <ScrollTable label="Suno packages built for this song" className="mt-2">
        <thead><tr><th>Package</th><th>Built</th><th>Handoff</th><th>Attempts</th></tr></thead>
        <tbody>
          {studio.packages.map((p) => (
            <tr key={p.packageId}>
              <td><a href={`/studio/packages/${p.packageId}`}>{p.title}</a></td><td className="meta"><Time at={p.createdAt} /></td>
              <td>{p.ready ? <span className="status-approved">ready</span> : <span className="meta">{p.blockers} blocking</span>}</td><td>{p.attempts}</td>
            </tr>
          ))}
          {studio.packages.length === 0 && <tr><td colSpan={4} className="meta">no package yet</td></tr>}
        </tbody>
      </ScrollTable>

      <h2>Tasks</h2>
      <Tasks tasks={w.tasks} back={back} showTarget={false} />
      <TaskForm target={{ songId: song.id }} back={back} />

      <h2>Lyrics</h2>
      <ScrollTable label="Lyrics">
        <thead><tr><th>Lineage</th><th>Role</th><th>Latest</th><th>Approved</th><th /></tr></thead>
        <tbody>{d.lyrics.map((l) => (
          <tr key={l.linkId}>
            <td><a href={`/vault/lineages/${l.lineageId}`}>{l.title}</a></td><td>{l.role ?? '—'}</td><td>v{l.latestVersion}</td>
            <td>{l.approvedVersion ? <span className="status-approved">v{l.approvedVersion}</span> : <span className="meta">none</span>}</td>
            <td><Unlink songId={song.id} linkId={l.linkId} /></td>
          </tr>
        ))}</tbody>
      </ScrollTable>

      <h2>Files</h2>
      <ScrollTable label="Files">
        <tbody>{d.files.map((f) => (
          <tr key={f.linkId}><td><a href={`/vault/files/${f.id}`}>{f.title}</a></td><td>{f.mediaClass ?? 'knowledge source'}</td><td>{f.role ?? '—'}</td><td><Unlink songId={song.id} linkId={f.linkId} /></td></tr>
        ))}</tbody>
      </ScrollTable>

      <h2>Takes, tracks, research</h2>
      <ScrollTable label="Takes, tracks, research">
        <tbody>
          {d.takes.map((t) => <tr key={t.linkId}><td>take</td><td>{t.title ?? t.id}</td><td className="break-all meta">{t.audioUrl ?? 'a Vault audio file'}</td><td><Unlink songId={song.id} linkId={t.linkId} /></td></tr>)}
          {d.tracks.map((t) => <tr key={t.linkId}><td>track</td><td>{t.title}</td><td className="meta">{t.releaseTitle} ({t.releaseStatus})</td><td><Unlink songId={song.id} linkId={t.linkId} /></td></tr>)}
          {d.research.map((r) => <tr key={r.linkId}><td>research</td><td>{r.question}</td><td /><td><Unlink songId={song.id} linkId={r.linkId} /></td></tr>)}
        </tbody>
      </ScrollTable>

      <ResearchSection research={research} />

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
      <ScrollTable label="Revisions">
        <thead><tr><th>Rev</th><th>Title</th><th>Status</th><th>Genre</th><th>Lang</th><th>At</th><th>Run</th></tr></thead>
        <tbody>{d.revisions.map((r) => (
          <tr key={r.revision}><td>{r.revision}</td><td>{r.title}</td><td>{r.status}</td><td>{r.genre ?? '—'}</td><td>{r.language ?? '—'}</td><td className="meta"><Time at={r.createdAt} /></td><td className="meta"><code>{r.runId}</code></td></tr>
        ))}</tbody>
      </ScrollTable>
    </section>
  );
}
