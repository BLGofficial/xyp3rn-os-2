import { runtime } from '../../../../../lib/server';
import { draftNode, draftsSince } from '../../../../../server/vault-drafts';

// Live feed of the Obsidian watcher: each note it stages or changes becomes a NODE_CREATED frame (the explorer adds or
// updates the node). Polls the staging table; the explorer also listens to /api/v1/hud/stream for agent runs.
export const dynamic = 'force-dynamic';

const POLL_MS = 3000;
const HEARTBEAT_MS = 25_000;

export async function GET(req: Request): Promise<Response> {
  const rt = await runtime();
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      let since = new Date();
      let lastBeat = Date.now();
      let closed = false;
      const close = () => { if (closed) return; closed = true; clearTimeout(timer); try { ctrl.close(); } catch { /* already closed */ } };
      req.signal.addEventListener('abort', close);
      const tick = async () => {
        if (closed) return;
        try {
          for (const r of await draftsSince(rt.sql, since)) {
            since = r.updated_at > since ? r.updated_at : since;
            ctrl.enqueue(enc.encode(`event: NODE_CREATED\ndata: ${JSON.stringify({ node: draftNode(r) })}\n\n`));
          }
          if (Date.now() - lastBeat > HEARTBEAT_MS) { ctrl.enqueue(enc.encode(': heartbeat\n\n')); lastBeat = Date.now(); }
        } catch (e) {
          console.error('v1 vault stream failed:', e);
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
