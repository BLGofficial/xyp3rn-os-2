import { loaders, runtime } from '../../lib/server';
import { upload } from '../actions';
import { ErrorBanner, Status, Time } from '../ui';

export const dynamic = 'force-dynamic';

export default async function Ingest({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const rt = await runtime();
  const [status, songs] = await Promise.all([(await loaders()).ingestStatus(rt.sql), (await loaders()).songList(rt.sql)]);
  return (
    <section>
      <h1>Ingest</h1>
      <ErrorBanner error={searchParams.error} />
      <form action={upload} className="mt-4 flex flex-col gap-3">
        <label className="field border-2 border-dashed border-paper p-6 text-center">
          Drop files here, or choose
          <input type="file" name="files" multiple required className="mt-2 border-0" />
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="field">As<select name="as" defaultValue=""><option value="">from the extension</option><option value="lyric_sheet">lyric_sheet</option><option>document</option><option>audio</option><option>image</option><option>other</option></select></label>
          <label className="field">Language<input name="language" placeholder="en, bg, mixed" size={8} /></label>
          <label className="field">Tags<input name="tags" placeholder="new-era, demo" /></label>
          <label className="field">Song<select name="songId" defaultValue=""><option value="">none</option>{songs.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
        </div>
        <button type="submit" className="self-start">Add to Vault</button>
      </form>

      <h2>Search backlog</h2>
      <p>Not yet indexed for vault search: {status.backlog.artifact} artifact versions · {status.backlog.source} files · {status.backlog.research_finding} findings. <span className="meta">`pnpm embed` indexes them.</span></p>

      <h2>Recent Vault runs</h2>
      <table>
        <thead><tr><th>Agent</th><th>Status</th><th>ms</th><th>At</th><th>Run</th></tr></thead>
        <tbody>
          {status.runs.map((r) => (
            <tr key={r.id}>
              <td>{r.agentName}</td>
              <td><Status status={r.status} />{r.error ? <div className="meta text-records">{r.error}</div> : null}</td>
              <td>{r.latencyMs ?? '—'}</td>
              <td className="meta"><Time at={r.createdAt} /></td>
              <td className="meta"><code>{r.id}</code></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Knowledge ingestion runs (`pnpm ingest`)</h2>
      <table>
        <thead><tr><th>Source</th><th>Status</th><th>Started</th></tr></thead>
        <tbody>{status.ingestionRuns.map((r) => <tr key={r.id}><td>{r.uri}</td><td><Status status={r.status} /></td><td className="meta"><Time at={r.startedAt} /></td></tr>)}</tbody>
      </table>
    </section>
  );
}
