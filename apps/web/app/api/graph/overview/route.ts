import { graphLoaders, runtime } from '../../../../lib/server';

// Jarvis Prompt 01: the sphere's bounded overview (F48). Behind the session check (middleware.ts: no session, 401),
// read as xyp_web, never cached: a cached graph would show entities the index no longer holds.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(): Promise<Response> {
  try {
    const rt = await runtime();
    return Response.json(await (await graphLoaders()).overview(rt.sql), { headers: NO_STORE });
  } catch (e) {
    // The cause goes to the server log for the owner; the browser gets a reason without internals.
    console.error('graph overview failed:', e);
    return Response.json({ error: 'the server could not read the graph' }, { status: 500, headers: NO_STORE });
  }
}
