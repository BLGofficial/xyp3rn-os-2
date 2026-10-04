import { loaders, runtime, vaultStore } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';

// A Vault file's bytes, from the content-addressed store (verified on read). Served inline for the
// audio player and images, but never as an active document: nosniff, and a sandbox CSP so an HTML
// or SVG file stored as "other" can't run script on this origin.
export async function GET(_req: Request, { params: pendingParams }: { params: Promise<{ id: string }> }) {
  const params = await pendingParams;
  const f = await (await loaders()).fileDetail((await runtime()).sql, params.id);
  if (!f) return new Response('no such Vault file', { status: 404 });
  // A copy backed by a plain ArrayBuffer: what the DOM's BodyInit accepts.
  const bytes = new Uint8Array(await (await vaultStore()).get(f.sha256));
  return new Response(bytes, {
    headers: {
      'content-type': f.mimeType ?? 'application/octet-stream',
      'content-length': String(bytes.length),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'; media-src 'self'; img-src 'self'",
      'cache-control': 'private, max-age=3600, immutable',
      'content-disposition': `inline; filename="${(f.filename ?? f.sha256).replace(/[^\w.-]/g, '_')}"`,
    },
  });
}
