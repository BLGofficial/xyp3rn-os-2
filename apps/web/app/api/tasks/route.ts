import type { NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '../../../lib/session';
import { askJobs, askOps, runtime as getRuntime, taskOps } from '../../../lib/server';
import { readBounded } from '../../../server/speech';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
const authorized = async (r: NextRequest) => {
  const token = process.env.XYP_WEB_TOKEN;
  return Boolean(token && await verifySession(token, r.cookies.get(SESSION_COOKIE)?.value, Date.now()));
};
export async function GET(request: NextRequest) {
  if (!await authorized(request)) return json({ error: 'Session required.' }, 401);
  try {
    const rt = await getRuntime();
    const recent = (await askJobs()).recentJobs(rt.owner);
    if (request.nextUrl.searchParams.get('recent') === '1') return json({ recent });
    return json({ knowledge: await (await taskOps()).musicKnowledge(rt.sql), recent });
  } catch { return json({ error: 'Knowledge could not be loaded. Check the database and retry.' }, 503); }
}
export async function POST(request: NextRequest) {
  if (!await authorized(request)) return json({ error: 'Session required.' }, 401);
  let sameOrigin = false;
  try { const origin = new URL(request.headers.get('origin') ?? ''); sameOrigin = origin.origin === request.headers.get('origin') && origin.host === request.headers.get('host') && origin.protocol === request.nextUrl.protocol; } catch { /* refuse */ }
  if (!sameOrigin) return json({ error: 'Same-origin request required.' }, 403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'JSON required.' }, 415);
  let body: unknown;
  try { body = JSON.parse((await readBounded(request.body, 40_000)).toString()); } catch { return json({ error: 'Invalid or oversized task request.' }, 400); }
  const ops = await taskOps();
  try { ops.validateTask(body); } catch (e) { return json({ error: (e as Error).message }, 400); }
  try {
    const rt = await getRuntime();
    const id = await ops.startTask(rt.owner, body, rt.sql, (await askOps()).askRunners(rt.deps));
    return json({ requestId: id, href: `/ask/${id}` }, 202);
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    const publicError = /^(A selected|Two requests|A deep task|Too many requests|Skills and deep tasks)/.test(message);
    return json({ error: publicError ? message : 'Task could not start. Your brief is preserved; check the server and try again.' }, 409);
  }
}
