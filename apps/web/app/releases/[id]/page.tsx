import { notFound } from 'next/navigation';
import { catalogLoaders, runtime } from '../../../lib/server';
import {
  artworkAction, codeAction, deliveryAction, linkAction, registerTrackAction, releaseAction, scheduleAction, splitsAction, unlinkAction,
} from '../../catalog-actions';
import { Checks, CreditForm, Credits, DELIVERY_STATUSES, PLATFORMS, TaskForm, Tasks } from '../../catalog-ui';
import { ErrorBanner, SongLinks, Status, Time } from '../../ui';

export const dynamic = 'force-dynamic';

type Link = { readonly id: string; readonly platform: string; readonly url: string };

const Links = ({ links, releaseId }: { links: readonly Link[]; releaseId: string }) => (
  <ul className="text-sm">
    {links.map((l) => (
      <li key={l.id} className="flex flex-wrap items-center gap-2">
        <span>{l.platform}</span><a href={l.url} className="break-all" rel="noreferrer noopener" target="_blank">{l.url}</a>
        <form action={unlinkAction} className="flex gap-1">
          <input type="hidden" name="releaseId" value={releaseId} />
          <input type="hidden" name="linkId" value={l.id} />
          <input name="reason" placeholder="why" required size={10} aria-label="unlink reason" />
          <button className="px-1 text-xs">Unlink</button>
        </form>
      </li>
    ))}
    {links.length === 0 && <li className="meta">no links</li>}
  </ul>
);

const LinkForm = ({ releaseId, trackId }: { releaseId: string; trackId?: string }) => (
  <form action={linkAction} className="flex flex-wrap items-end gap-2">
    <input type="hidden" name="releaseId" value={releaseId} />
    {trackId && <input type="hidden" name="trackId" value={trackId} />}
    <label className="field">Platform<select name="platform" defaultValue="spotify">{PLATFORMS.map((p) => <option key={p}>{p}</option>)}</select></label>
    <label className="field grow">URL<input name="url" type="url" required placeholder="https://" /></label>
    <button type="submit">Link</button>
  </form>
);

// The release workspace (AOS-02 §6): every field the checks ask for is set from here, and each write
// is an agent run (records-catalog, records-tasks) or a Records workflow (register-track, schedule-release).
export default async function Release({ params, searchParams }: { params: { id: string }; searchParams: Record<string, string | string[] | undefined> }) {
  const rt = await runtime();
  const loaders = await catalogLoaders();
  const d = await loaders.releaseDetail(rt.sql, params.id);
  if (!d) notFound();
  const { release: r } = d;
  const back = `/releases/${r.id}`;
  const options = r.status === 'draft' ? await loaders.recordingOptions(rt.sql) : null;
  const nextPosition = d.tracks.reduce((m, t) => Math.max(m, t.position), 0) + 1;
  return (
    <section>
      <h1>{r.title}</h1>
      <p className="meta mt-1">
        {r.artist} · {r.kind} · <Status status={r.status} /> · {r.releaseDate ?? 'no date'} · UPC {r.upc ?? 'none'}
        {r.rightsCheckRunId && <> · rights check run <code>{r.rightsCheckRunId}</code></>} · created <Time at={r.createdAt} />
      </p>
      <ErrorBanner error={searchParams.error} />

      <h2>Checks</h2>
      <Checks checks={d.checks} />

      <h2>Tracks</h2>
      {d.tracks.map((t) => (
        <article key={t.id} className="mb-6 border-2 border-rule p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-bold">{t.position}. {t.title}</h3>
            <span className="meta">
              {t.recording.kind === 'vault' ? <>Vault · <a href={`/vault/files/${t.recording.id}`}>{t.recording.title}</a></> : <>Suno · {t.recording.title}</>}
              {' · song '}<SongLinks songs={t.songs} />
            </span>
          </div>

          <div className="mt-2 grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="text-xs uppercase tracking-widest">ISRC</h4>
              {t.isrc ? <code>{t.isrc}</code> : (
                <form action={codeAction} className="flex gap-2">
                  <input type="hidden" name="releaseId" value={r.id} />
                  <input type="hidden" name="trackId" value={t.id} />
                  <input name="code" required size={16} placeholder="CC-XXX-YY-NNNNN" aria-label="ISRC" />
                  <button type="submit">Assign</button>
                </form>
              )}

              <h4 className="mt-3 text-xs uppercase tracking-widest">Splits {t.splits ? `v${t.splits.version}` : '(none)'}</h4>
              <form action={splitsAction} className="flex flex-col gap-2">
                <input type="hidden" name="releaseId" value={r.id} />
                <input type="hidden" name="trackId" value={t.id} />
                <textarea name="splits" rows={3} required aria-label="splits" placeholder={'X3LIUS 100\n(or: unassigned 20)'}
                  defaultValue={t.splits?.rows.map((s) => `${s.payee ?? 'unassigned'} ${s.percentage}`).join('\n') ?? ''} />
                <button type="submit" className="self-start">{t.splits ? 'Write a new version' : 'Write splits'}</button>
              </form>
            </div>
            <div>
              <h4 className="text-xs uppercase tracking-widest">Credits</h4>
              <Credits credits={t.credits} back={back} />
              <CreditForm target={{ trackId: t.id }} back={back} />
              <h4 className="mt-3 text-xs uppercase tracking-widest">Track links</h4>
              <Links links={t.links} releaseId={r.id} />
              <LinkForm releaseId={r.id} trackId={t.id} />
            </div>
          </div>
        </article>
      ))}
      {d.tracks.length === 0 && <p className="meta">no tracks</p>}

      {options && (
        <>
          <h2>Add a track</h2>
          <form action={registerTrackAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="releaseId" value={r.id} />
            <label className="field">Recording
              <select name="recording" required defaultValue="">
                <option value="" disabled>choose…</option>
                {options.files.map((f) => <option key={f.id} value={`vault:${f.id}`}>Vault · {f.title}</option>)}
                {options.takes.map((k) => <option key={k.id} value={`take:${k.id}`}>Suno · {k.title}</option>)}
              </select>
            </label>
            <label className="field">Position<input name="position" type="number" min={1} defaultValue={nextPosition} size={3} /></label>
            <label className="field">Title<input name="title" placeholder="default: the song's / formula's title" /></label>
            <button type="submit">Register</button>
          </form>
        </>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h2>UPC</h2>
          {r.upc ? <code>{r.upc}</code> : (
            <form action={codeAction} className="flex gap-2">
              <input type="hidden" name="releaseId" value={r.id} />
              <input name="code" required size={14} inputMode="numeric" placeholder="12 digits" aria-label="UPC" />
              <button type="submit">Assign</button>
            </form>
          )}

          <h2>Artwork</h2>
          {d.artwork ? (
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element -- served from the Vault route, not a static asset */}
              <img src={`/vault/files/${d.artwork.sourceId}/raw`} alt={`${r.title} artwork`} className="max-w-[240px] border-2 border-rule" />
              <figcaption className="meta"><a href={`/vault/files/${d.artwork.sourceId}`}>{d.artwork.title}</a> · set <Time at={d.artwork.setAt} /></figcaption>
            </figure>
          ) : <p className="meta">none</p>}
          {d.artworkHistory.length > 0 && (
            <ul className="meta mt-1 text-sm">{d.artworkHistory.map((a) => <li key={`${a.sourceId}:${a.setAt}`}>earlier: <a href={`/vault/files/${a.sourceId}`}>{a.title}</a> · <Time at={a.setAt} /></li>)}</ul>
          )}
          <form action={artworkAction} className="mt-2 flex flex-wrap items-end gap-2">
            <input type="hidden" name="releaseId" value={r.id} />
            <label className="field">Image<input name="image" type="file" accept="image/*" required /></label>
            <button type="submit">{d.artwork ? 'Replace' : 'Set artwork'}</button>
          </form>
        </div>
        <div>
          <h2>Release links</h2>
          <Links links={d.links} releaseId={r.id} />
          <LinkForm releaseId={r.id} />

          <h2>Deliveries</h2>
          <table>
            <tbody>{d.deliveries.map((x) => (
              <tr key={x.distributor}><td>{x.distributor}</td><td><Status status={x.status} /></td><td className="meta">{x.note ?? ''}</td><td className="meta"><Time at={x.at} /></td></tr>
            ))}</tbody>
          </table>
          {d.deliveries.length === 0 && <p className="meta">none recorded; no distributor connector yet (AOS-06)</p>}
          <form action={deliveryAction} className="mt-2 flex flex-wrap items-end gap-2">
            <input type="hidden" name="releaseId" value={r.id} />
            <label className="field">Distributor<input name="distributor" required size={12} /></label>
            <label className="field">Status<select name="status" defaultValue="submitted">{DELIVERY_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
            <label className="field">Note<input name="note" size={10} /></label>
            <button type="submit">Record</button>
          </form>
        </div>
      </div>

      <h2>Calendar</h2>
      {r.status === 'draft' && (
        <form action={scheduleAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="releaseId" value={r.id} />
          <label className="field">Release date<input name="releaseDate" type="date" required /></label>
          <button type="submit">Schedule (runs the Rights check)</button>
        </form>
      )}
      {r.status === 'scheduled' && (
        <form action={releaseAction}>
          <input type="hidden" name="releaseId" value={r.id} />
          <button type="submit">Mark released (on or after {r.releaseDate})</button>
        </form>
      )}
      {r.status === 'released' && <p className="meta">released {r.releaseDate}</p>}

      <h2>Tasks</h2>
      <Tasks tasks={d.tasks} back={back} showTarget={false} />
      <TaskForm target={{ releaseId: r.id }} back={back} />
    </section>
  );
}
