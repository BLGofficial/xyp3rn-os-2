import type { NextRequest } from 'next/server';
import { graphLoaders, runtime } from '../../../../lib/server';

// Jarvis Prompt 01: one hop around a node (C1's neighbourhood), for the sphere's focus. Behind the session check,
// read as xyp_web, never cached.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(req: NextRequest): Promise<Response> {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return Response.json({ error: 'id is required' }, { status: 400, headers: NO_STORE });
  try {
    const rt = await runtime();
    const n = await (await graphLoaders()).neighbourhood(rt.sql, id);
    if (!n.center) return Response.json({ error: 'no entity has that id' }, { status: 404, headers: NO_STORE });
    return Response.json(n, { headers: NO_STORE });
  } catch (e) {
    console.error('graph node failed:', e);
    return Response.json({ error: 'the server could not read the graph' }, { status: 500, headers: NO_STORE });
  }
}
