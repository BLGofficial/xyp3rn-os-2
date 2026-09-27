import { notFound } from 'next/navigation';
import { runtime, studioLoaders } from '../../../../lib/server';
import { handOffAction, importTakeAction, rateTakeAction } from '../../../studio-actions';
import { ErrorBanner, ScrollTable, Status, Time } from '../../../ui';

export const dynamic = 'force-dynamic';

const SOURCE_PAGE: Readonly<Record<string, string>> = { lyrics: '/vault/lineages', 'style-recipe': '/studio/recipes', 'meta-tag-set': '/studio/tags' };

export default async function Package({ params, searchParams }: { params: { id: string }; searchParams: Record<string, string | string[] | undefined> }) {
  const p = await (await studioLoaders()).packageDetail((await runtime()).sql, params.id);
  if (!p) notFound();
  const e = p.export;
  const fields: readonly (readonly [string, string])[] = [['Song Title', e.title], ['Style of Music', e.style], ['Exclude Styles', e.excludeStyles.join(', ')], ['Lyrics', e.lyrics]];
  return (
    <section>
      <h1>{e.title}</h1>
      <p className="meta mt-1">
        Suno {e.sunoModel} package <code>{e.package.id}</code> · built <Time at={e.package.createdAt} /> ·
        song {p.song ? <a href={`/songs/${p.song.id}`}>{p.song.title}</a> : 'none'}
      </p>
      <ErrorBanner error={searchParams.error} />

      <h2>Handoff</h2>
      {e.ready ? (
        <form action={handOffAction} className="flex items-center gap-3">
          <input type="hidden" name="packageId" value={e.package.id} />
          <span className="status-approved">ready</span>
          <span className="meta">Paste the fields below into Suno&apos;s custom mode, then record the handoff and upload what it generates.</span>
          <button type="submit">Hand off (manual)</button>
        </form>
      ) : (
        <>
          <p><span className="status-draft">not ready</span> <span className="meta">every version it names must be approved, and a workflow run must have built it:</span></p>
          <ul className="list-inside list-disc text-sm">{e.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </>
      )}

      <h2>Suno fields</h2>
      <p className="meta">
        Download: <a href={`/studio/packages/${e.package.id}/export`}>xyp-suno-package/v1 (JSON)</a> · <a href={`/studio/packages/${e.package.id}/export?format=text`}>copy-paste text</a>
      </p>
      {fields.map(([label, value]) => (
        <div key={label} className="mt-3">
          <p className="meta">{label} · {value.length} characters</p>
          <pre data-field={label}>{value}</pre>
        </div>
      ))}
      <p className="meta mt-2">
        Canonical limits for Suno {e.sunoModel}: {e.limits.length === 0 ? 'none stated by a canonical claim' : e.limits.map((l) => `${l.field} ${l.actual}/${l.max} (${l.ref})`).join(' · ')}
      </p>

      <h2>Trace</h2>
      <ScrollTable label="Trace">
        <thead><tr><th>Role</th><th>Version</th><th>Status</th><th>Artifact</th></tr></thead>
        <tbody>
          {e.sources.map((s) => (
            <tr key={s.role}>
              <td>{s.role}</td>
              <td>{s.lineageId ? <a href={`${SOURCE_PAGE[s.role]}/${s.lineageId}`}>v{s.version}</a> : `v${s.version}`}</td>
              <td><Status status={s.status} /></td>
              <td className="meta"><code>{s.artifactId}</code></td>
            </tr>
          ))}
          <tr>
            <td>workflow</td>
            <td>{e.workflow ? e.workflow.name : <span className="meta">none</span>}</td>
            <td>{e.workflow ? <Status status={e.workflow.status} /> : null}</td>
            <td className="meta">{e.workflow ? <>spec <code>{e.workflow.sha256.slice(0, 16)}…</code> run <code>{e.workflow.runId}</code></> : null}</td>
          </tr>
        </tbody>
      </ScrollTable>

      <h2>Attempts</h2>
      {p.attempts.length === 0 && <p className="meta">not handed off yet</p>}
      {p.attempts.map((a, i) => (
        <div key={a.submissionId} className="mb-6" data-attempt={a.submissionId}>
          <p className="text-sm font-bold">Attempt {i + 1} · {a.adapter} · <Time at={a.createdAt} /> <span className="meta">submission <code>{a.submissionId}</code></span></p>
          <ScrollTable label="Attempts">
            <thead><tr><th>Take</th><th>Audio</th><th>Rating</th><th>Rate</th></tr></thead>
            <tbody>
              {a.takes.map((t) => (
                <tr key={t.takeId}>
                  <td>
                    {t.title ?? t.fileTitle ?? t.takeId}
                    <div className="meta">{t.audioSha256 ? <>sha256 <code>{t.audioSha256.slice(0, 16)}…</code></> : t.audioUrl}</div>
                  </td>
                  <td>{t.sourceId ? <audio controls preload="none" src={`/vault/files/${t.sourceId}/raw`} /> : t.audioUrl ? <a href={t.audioUrl}>provider audio</a> : null}</td>
                  <td>
                    {t.rating ? <><span className="status-approved">{t.rating}/5</span> <span className="meta"><Time at={t.ratedAt} /></span></> : <span className="meta">unrated</span>}
                    {t.keep && <div className="meta">keep: {t.keep}</div>}
                    {t.change && <div className="meta">change: {t.change}</div>}
                  </td>
                  <td>
                    <form action={rateTakeAction} className="flex flex-wrap gap-1">
                      <input type="hidden" name="packageId" value={e.package.id} />
                      <input type="hidden" name="takeId" value={t.takeId} />
                      <select name="rating" defaultValue={String(t.rating ?? 3)} aria-label="rating">{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select>
                      <input name="keep" placeholder="keep" size={14} aria-label="what to keep" />
                      <input name="change" placeholder="change" size={14} aria-label="what to change" />
                      <button type="submit" className="btn-quiet">Rate</button>
                    </form>
                  </td>
                </tr>
              ))}
              {a.takes.length === 0 && <tr><td colSpan={4} className="meta">no take yet</td></tr>}
            </tbody>
          </ScrollTable>
          <form action={importTakeAction} className="mt-2 flex flex-wrap items-end gap-2">
            <input type="hidden" name="packageId" value={e.package.id} />
            <input type="hidden" name="submissionId" value={a.submissionId} />
            <label className="field">Suno&apos;s audio<input type="file" name="audio" accept="audio/*" required /></label>
            <label className="field">Title<input name="title" size={24} /></label>
            <button type="submit">Import take</button>
          </form>
        </div>
      ))}
    </section>
  );
}
