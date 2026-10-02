import { runtime, studioLoaders } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';

// The package as the owner takes it to Suno (AOS-03, S3): xyp-suno-package/v1 as a JSON download, or
// ?format=text for the copy-paste blocks. Read only; the middleware requires a session.
export async function GET(req: Request, { params: pendingParams }: { params: Promise<{ id: string }> }) {
  const params = await pendingParams;
  const sl = await studioLoaders();
  const p = await sl.packageDetail((await runtime()).sql, params.id);
  if (!p) return new Response('no such package', { status: 404 });
  const text = new URL(req.url).searchParams.get('format') === 'text';
  const { sources, ...rest } = p.export;
  const body = text ? sl.packageText(p.export) : `${JSON.stringify({ ...rest, sources: sources.map(({ lineageId: _, ...s }) => s) }, null, 2)}\n`;
  return new Response(body, {
    headers: {
      'content-type': text ? 'text/plain; charset=utf-8' : 'application/json',
      'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="suno-package-${p.export.package.id}.${text ? 'txt' : 'json'}"`,
    },
  });
}
