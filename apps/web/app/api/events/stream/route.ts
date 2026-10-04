import { hudLoaders, runtime } from '../../../../lib/server';

// Mercury HUD (F52): new activity rows as Server-Sent Events, behind the session check (middleware.ts: 401). The
// server polls the database every 2 s from a cursor (no triggers, no migration); each run arrives when it starts and
// when it finishes. A comment line every 15 s keeps proxies from closing an idle stream. The client reconnects on
// its own; a reconnect starts from now (events it missed are in the activity list).
export const dynamic = 'force-dynamic';

const POLL_MS = 2000;
const HEARTBEAT_MS = 15_000;

export async function GET(req: Request): Promise<Response> {
  const [rt, hl] = [await runtime(), await hudLoaders()];
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      let cursor: string | null = null; let seen: ReadonlySet<string> = new Set();
      let lastBeat = Date.now(); let closed = false;
      const close = () => { if (closed) return; closed = true; clearTimeout(timer); try { ctrl.close(); } catch { /* already closed */ } };
      req.signal.addEventListener('abort', close);
      const tick = async () => {
        if (closed) return;
        try {
          const r = await hl.hudEventsSince(rt.sql, cursor, seen);
          cursor = r.cursor; seen = r.seen;
          for (const e of r.events) ctrl.enqueue(enc.encode(`id: ${e.key}\nevent: activity\ndata: ${JSON.stringify(e)}\n\n`));
          if (Date.now() - lastBeat > HEARTBEAT_MS) { ctrl.enqueue(enc.encode(': heartbeat\n\n')); lastBeat = Date.now(); }
        } catch (e) {
          console.error('events stream failed:', e);
          ctrl.enqueue(enc.encode(`event: problem\ndata: ${JSON.stringify({ error: 'the server could not read new events' })}\n\n`));
        }
        if (!closed) timer = setTimeout(tick, POLL_MS);
      };
      ctrl.enqueue(enc.encode('retry: 5000\n\n'));
      await tick();
    },
    cancel() { clearTimeout(timer); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' } });
}
