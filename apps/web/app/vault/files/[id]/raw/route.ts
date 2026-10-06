import { parseRange } from '../../../../../lib/byte-range';
import { loaders, runtime, vaultStore } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';

// A Vault file's bytes, from the content-addressed store (verified on read). Served inline for the
// audio player and images, but never as an active document: nosniff, and a sandbox CSP so an HTML
// or SVG file stored as "other" can't run script on this origin. Byte ranges are honoured: without
// a 206 answer the browser's audio element can't seek, and stops reporting a duration for some formats.
export async function GET(req: Request, { params: pendingParams }: { params: Promise<{ id: string }> }) {
  const params = await pendingParams;
  const f = await (await loaders()).fileDetail((await runtime()).sql, params.id);
  if (!f) return new Response('no such Vault file', { status: 404 });
  // A copy backed by a plain ArrayBuffer: what the DOM's BodyInit accepts.
  const bytes = new Uint8Array(await (await vaultStore()).get(f.sha256));
  const headers: Record<string, string> = {
    'content-type': f.mimeType ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'; media-src 'self'; img-src 'self'",
    'cache-control': 'private, max-age=3600, immutable',
    'content-disposition': `inline; filename="${(f.filename ?? f.sha256).replace(/[^\w.-]/g, '_')}"`,
  };
  const range = parseRange(req.headers.get('range'), bytes.length);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${bytes.length}` } });
  }
  if (range) {
    const [start, end] = range;
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': String(end - start + 1) },
    });
  }
  return new Response(bytes, { headers: { ...headers, 'content-length': String(bytes.length) } });
}
