import { hudLoaders, runtime } from '../../../../lib/server';

// Mercury HUD (F52): sub-components, their matched files and the aggregated links (knowledge-graph/components.ts).
// Behind the session check (middleware.ts: no session, 401), read as xyp_web from one snapshot, never cached.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(): Promise<Response> {
  try {
    const rt = await runtime();
    return Response.json(await (await hudLoaders()).hudComponents(rt.sql), { headers: NO_STORE });
  } catch (e) {
    console.error('graph components failed:', e);
    return Response.json({ error: 'the server could not read the components' }, { status: 500, headers: NO_STORE });
  }
}
