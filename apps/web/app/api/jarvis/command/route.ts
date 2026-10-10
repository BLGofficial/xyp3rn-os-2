import { jarvisCore, runtime as osRuntime } from '../../../../lib/server';
import { MAX_COMMAND_CHARS, relayCommand } from '../../../../server/jarvis-command';

// The command bar's endpoint. The middleware has already required the owner session; this adds the same-origin rule
// /api/jarvis/start uses, because a command can write notes and start runs, which another site may not trigger.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function POST(request: Request): Promise<Response> {
  let sameOrigin = false;
  try { sameOrigin = new URL(request.headers.get('origin') ?? '').host === request.headers.get('host'); } catch { /* refuse */ }
  if (!sameOrigin) return json({ error: 'Same-origin request required.' }, 403);
  let text = '';
  try { const b = (await request.json()) as { text?: unknown }; text = typeof b.text === 'string' ? b.text.trim() : ''; } catch { /* empty */ }
  if (!text) return json({ error: 'Type or say a command first.' }, 400);
  if (text.length > MAX_COMMAND_CHARS) return json({ error: `A command is at most ${MAX_COMMAND_CHARS} characters.` }, 413);
  // JarvisCore first, for what it answers read-only on its own (the playbooks); it works with Galaxy down. Anything
  // else goes to the Python Jarvis, which asks before it starts a run.
  try {
    const viaCore = await (await jarvisCore()).commandViaCore(text, await osRuntime());
    if (viaCore) return json({ kind: 'answer', answer: viaCore.answer, route: viaCore.route });
  } catch (e) {
    console.error('jarvis command via core failed:', e);
    return json({ error: 'Jarvis Core could not run that command.' }, 500);
  }
  const reply = await relayCommand(text);
  return reply.kind === 'offline' ? json(reply, 503) : reply.kind === 'refused' ? json(reply, 502) : json(reply);
}
