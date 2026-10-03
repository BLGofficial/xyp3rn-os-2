import { hudLoaders, runtime } from '../../../../lib/server';

// Mercury HUD (F52): the right rail and the bottom bar (pulse, counts, 24 h runs, last scan, boot time). Behind the
// session check, never cached. Provider keys are reported as configured or not; their values never leave the server.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(): Promise<Response> {
  try {
    const rt = await runtime();
    return Response.json(await (await hudLoaders()).hudStatus(rt.sql, process.env, rt.deps.registry), { headers: NO_STORE });
  } catch (e) {
    console.error('system status failed:', e);
    return Response.json({ error: 'the server could not read the system status' }, { status: 500, headers: NO_STORE });
  }
}
