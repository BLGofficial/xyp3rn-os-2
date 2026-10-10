import { jarvisLauncher } from '../../../../lib/server';

// Starts Jarvis for the agent ring's button. The middleware has already required the owner session; this adds the
// same-origin rule /api/tasks uses, because starting a process is not something another site may trigger.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function POST(request: Request): Promise<Response> {
  let sameOrigin = false;
  try { sameOrigin = new URL(request.headers.get('origin') ?? '').host === request.headers.get('host'); } catch { /* refuse */ }
  if (!sameOrigin) return json({ error: 'Same-origin request required.' }, 403);
  const result = await (await jarvisLauncher()).startJarvis();
  return json(result, result.reason === 'failed' ? 502 : 200);
}
