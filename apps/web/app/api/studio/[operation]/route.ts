import { type NextRequest } from 'next/server';
import { AUDIO_LIMIT, readBounded, speak, speechStatus, SpeechError, transcribe } from '../../../../server/speech';
import { SESSION_COOKIE, verifySession } from '../../../../lib/session';
import { osImport } from '../../../../lib/os';
import { runtime as getRuntime } from '../../../../lib/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
let windowStart = 0, requests = 0;
async function authorized(request: NextRequest) {
  const secret = process.env.XYP_WEB_TOKEN;
  return Boolean(secret && await verifySession(secret, request.cookies.get(SESSION_COOKIE)?.value, Date.now()));
}
export async function GET(request: NextRequest, { params: pendingParams }: { params: Promise<{ operation: string }> }) {
  const params = await pendingParams;
  if (!await authorized(request)) return json({ error: 'Session required.' }, 401);
  return params.operation === 'status' ? json(speechStatus()) : json({ error: 'Not found.' }, 404);
}
export async function POST(request: NextRequest, { params: pendingParams }: { params: Promise<{ operation: string }> }) {
  const params = await pendingParams;
  if (!await authorized(request)) return json({ error: 'Session required.' }, 401);
  // Next may normalize request.nextUrl's hostname to localhost. Compare the browser's Host header.
  const origin = request.headers.get('origin');
  let sameOrigin = false;
  try { const source = new URL(origin ?? ''); sameOrigin = source.origin === origin && source.host === request.headers.get('host') && source.protocol === request.nextUrl.protocol; } catch { /* malformed or missing origin */ }
  if (!sameOrigin) return json({ error: 'Same-origin request required.' }, 403);
  if (!['transcribe', 'speak', 'capture'].includes(params.operation)) return json({ error: 'Not found.' }, 404);
  const now = Date.now(); if (now - windowStart > 60_000) { windowStart = now; requests = 0; }
  if (++requests > 20) return json({ error: 'Too many Studio requests. Retry in one minute.' }, 429);
  try {
    if (params.operation === 'transcribe') {
      const bytes = await readBounded(request.body, AUDIO_LIMIT);
      return json(await transcribe(bytes, request.headers.get('content-type') ?? '', request.headers.get('x-source-language') ?? '', request.signal));
    }
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new SpeechError('JSON body required.');
    let body: unknown;
    try { body = JSON.parse((await readBounded(request.body, 192_000)).toString()); } catch (error) {
      if (error instanceof SpeechError) throw error; throw new SpeechError('Invalid JSON body.');
    }
    if (params.operation === 'speak') {
      const b = body as { text?: unknown; language?: unknown } | null;
      if (!b || typeof b.text !== 'string' || typeof b.language !== 'string') throw new SpeechError('Text and language required.');
      const audio = await speak(b.text, b.language, request.signal);
      return new Response(new Uint8Array(audio), { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    const module = await osImport<typeof import('../../../../server/studio-capture')>('apps/web/server/studio-capture.ts');
    return json(await module.saveCapture((await getRuntime()).deps, body, process.env.XYP_WEB_TOKEN!), 201);
  } catch (error) {
    return json({ error: error instanceof SpeechError ? error.message : 'Capture could not be saved. Check the fields and database connection; your text is preserved.' }, error instanceof SpeechError ? error.status : 400);
  }
}
