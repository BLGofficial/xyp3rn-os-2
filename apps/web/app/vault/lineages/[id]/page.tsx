import { notFound } from 'next/navigation';
import { lineDiff } from '../../../../lib/diff';
import { loaders, runtime } from '../../../../lib/server';
import { decideVersion, editVersion } from '../../../actions';
import { ErrorBanner, first, SongLinks, Status, Time } from '../../../ui';

export const dynamic = 'force-dynamic';

export default async function Lineage({ params, searchParams }: { params: { id: string }; searchParams: Record<string, string | string[] | undefined> }) {
  const l = await (await loaders()).lineageDetail((await runtime()).sql, params.id);
  if (!l) notFound();
  const latest = l.versions.at(-1)!;
  const byVersion = (v: string | undefined, fallback: number) => l.versions.find((x) => x.version === Number(v)) ?? l.versions.find((x) => x.version === fallback)!;
  const a = byVersion(first(searchParams.a), Math.max(1, latest.version - 1));
  const b = byVersion(first(searchParams.b), latest.version);
  return (
    <section>
      <h1>{l.versions[0]!.brief}</h1>
      <p className="meta mt-1">{l.schemaId} · lineage <code>{l.lineageId}</code> · approved: {l.approvedVersion ? `v${l.approvedVersion}` : 'none'} · songs: <SongLinks songs={l.songs} /></p>
      <ErrorBanner error={searchParams.error} />

      <h2>Versions</h2>
      <table>
        <thead><tr><th>V</th><th>Status</th><th>By</th><th>Written</th><th>Decision</th><th>Decide</th></tr></thead>
        <tbody>
          {l.versions.map((v) => (
            <tr key={v.id}>
              <td>v{v.version}{v.version === l.approvedVersion ? ' ◆' : ''}</td>
              <td><Status status={v.status} /></td>
              <td>{v.agentName}</td>
              <td className="meta"><Time at={v.createdAt} /></td>
              <td className="meta">{v.decidedBy ? <>{v.decidedBy} at <Time at={v.decidedAt} />: {v.decisionReason}</> : '—'}</td>
              <td>
                {v.status === 'draft' && (
                  <form action={decideVersion} className="flex gap-2">
                    <input type="hidden" name="lineageId" value={l.lineageId} />
                    <input type="hidden" name="artifactId" value={v.id} />
                    <input name="reason" placeholder="reason" required size={16} aria-label={`reason for v${v.version}`} />
                    <button name="decision" value="approve">Approve</button>
                    <button name="decision" value="reject">Reject</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>v{b.version}</h2>
      <pre>{b.sheet}</pre>

      {l.versions.length > 1 && (
        <>
          <h2>Diff v{a.version} → v{b.version}</h2>
          <form method="get" className="mb-2 flex gap-2 text-xs">
            <select name="a" defaultValue={a.version}>{l.versions.map((v) => <option key={v.id} value={v.version}>v{v.version}</option>)}</select>
            <select name="b" defaultValue={b.version}>{l.versions.map((v) => <option key={v.id} value={v.version}>v{v.version}</option>)}</select>
            <button type="submit">Compare</button>
          </form>
          <pre>{lineDiff(a.sheet.split('\n'), b.sheet.split('\n')).map((d, i) => (
            <div key={i} className={d.op === '+' ? 'text-records' : d.op === '-' ? 'text-zinc-500 line-through' : ''}>{d.op} {d.line}</div>
          ))}</pre>
        </>
      )}

      {l.schemaId === 'x3lius.lyrics/v2' && (
        <>
          <h2>Edit → v{latest.version + 1} (a draft)</h2>
          <form action={editVersion} className="flex flex-col gap-2">
            <input type="hidden" name="lineageId" value={l.lineageId} />
            <input type="hidden" name="parentId" value={latest.id} />
            <textarea name="text" rows={14} defaultValue={latest.sheet} aria-label="lyric sheet" />
            <div className="flex gap-2"><input name="language" placeholder="language (default: unchanged)" size={30} /><button type="submit">Save version</button></div>
          </form>
        </>
      )}
    </section>
  );
}
