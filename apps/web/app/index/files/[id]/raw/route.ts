import { graphFiles, runtime } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';

// A repository file's bytes (AOS-04 Plan C1 Task 7), under the Vault raw route's rules: nosniff and a sandbox CSP,
// so nothing served here runs as a document on this origin. Text is served as plain text; images inline; anything
// else as a download. A file that changed since the scan is refused, never served under the old checksum.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const r = await (await graphFiles()).openRepoFile((await runtime()).sql, params.id);
  if (!r.ok) {
    const [status, why] = r.reason === 'changed' ? [409, 'changed since the last scan'] : r.reason === 'missing' ? [410, 'no longer at its indexed path']
      : r.reason === 'unreadable' ? [500, 'could not be read'] : [404, 'no such indexed file'];
    return new Response(why, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' } });
  }
  const f = r.file;
  const image = f.mime?.startsWith('image/') ?? false;
  const type = f.textIndexed && !image ? 'text/plain; charset=utf-8' : image ? f.mime! : 'application/octet-stream';
  const name = (f.path.split('/').pop() ?? 'file').replace(/[^\w.-]/g, '_');
  // A copy backed by a plain ArrayBuffer: what the DOM's BodyInit accepts.
  return new Response(new Uint8Array(r.bytes), {
    headers: {
      'content-type': type,
      'content-length': String(r.bytes.length),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'; img-src 'self'",
      'cache-control': 'private, no-store',
      'content-disposition': `${f.textIndexed || image ? 'inline' : 'attachment'}; filename="${name}"`,
    },
  });
}
