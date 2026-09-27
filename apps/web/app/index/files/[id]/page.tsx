import { notFound } from 'next/navigation';
import { graphFiles, graphLoaders, runtime } from '../../../../lib/server';
import { Connections, DomainChip } from '../../../graph-ui';
import { ScrollTable, Time } from '../../../ui';

export const dynamic = 'force-dynamic';

// A repository file from the index (AOS-04 Plan C1 Task 7): opened by its opaque id, re-checked against its root
// and checksum before a byte is shown. A refusal says why and never shows the file's contents.
const REFUSED: Readonly<Record<string, string>> = {
  missing: 'This file is no longer at its indexed path. Its record stays for history.',
  escaped: 'This path no longer resolves inside the index root, so it is not opened.',
  unreadable: 'This file could not be read.',
};

export default async function IndexedFile({ params }: { params: { id: string } }) {
  const sql = (await runtime()).sql;
  const r = await (await graphFiles()).openRepoFile(sql, params.id);
  if (!r.ok && (r.reason === 'not-found' || r.reason === 'escaped')) notFound();
  if (!r.ok) {
    return (
      <section>
        <h1>Repository file</h1>
        <p className="status-warning mt-4">
          {r.reason === 'changed'
            ? <>This file changed since the last scan (indexed <code>{r.indexed.slice(0, 12)}…</code>, now <code>{r.current.slice(0, 12)}…</code>). It is not shown under the old revision.</>
            : REFUSED[r.reason]}
        </p>
        <p className="mt-2"><a href="/system">Rescan on the System page</a></p>
      </section>
    );
  }
  const f = r.file;
  const detail = await (await graphLoaders()).nodeDetail(sql, `file:${f.root}/${f.path}`);
  const raw = `/index/files/${f.id}/raw`;
  return (
    <section>
      <h1 className="break-all">{f.path}</h1>
      <p className="meta"><a href={`/?node=${encodeURIComponent(`file:${f.root}/${f.path}`)}`}>Back to graph</a></p>
      <ScrollTable label="File details" className="mt-4">
        <tbody>
          <tr><th>Owner</th><td><DomainChip domain={f.ownerDomain as never} /> <span className="meta">by {f.ownershipBasis}</span></td></tr>
          <tr><th>sha256</th><td className="break-all"><code>{f.sha256}</code> <span className="meta">(verified on open)</span></td></tr>
          <tr><th>Size / type</th><td>{f.sizeBytes} bytes · {f.mime ?? 'unknown type'}</td></tr>
          <tr><th>Indexed</th><td><Time at={f.indexedAt} /></td></tr>
          <tr><th>Bytes</th><td><a href={raw}>open raw</a></td></tr>
        </tbody>
      </ScrollTable>
      {f.mime?.startsWith('image/') && <img className="mt-4 max-w-full rounded-control border border-line" src={raw} alt={f.path} />}
      {r.text !== null
        ? (
          <>
            <h2>Contents{r.truncated ? ' (first part)' : ''}</h2>
            <pre className="table-scroll" tabIndex={0} aria-label={`Contents of ${f.path}`}>{r.text}</pre>
            {r.truncated && <p className="meta">Truncated at a line break; open raw for the whole file.</p>}
          </>
        )
        : <p className="meta mt-4">No text preview: {f.textIndexed ? 'empty' : 'a binary or oversize file is indexed as metadata only'}.</p>}
      {detail && (
        <>
          <h2>Connections</h2>
          <Connections label="Outgoing connections" connections={detail.outgoing} />
          <Connections label="Incoming connections" connections={detail.incoming} />
        </>
      )}
    </section>
  );
}
