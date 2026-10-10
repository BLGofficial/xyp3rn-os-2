/**
 * Relays Jarvis's voice-status stream (galaxy/server.py, GET /voice/stream) to the browser. Jarvis refuses any request
 * that carries a foreign Origin or a cross-site fetch mode, so a page cannot read it directly; this server-side hop sends
 * neither header. The target is fixed here, never taken from the request.
 *
 * When Jarvis is not running the relay still answers 200 with an empty stream that closes at once: an EventSource
 * treats any other status as final and never retries, and a closed 200 stream is retried after `retry` ms.
 */

export const JARVIS_ORIGIN = 'http://127.0.0.1:4700';

const HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' };
const OFFLINE = 'retry: 5000\n: jarvis is not running\n\n';

/** @param signal - the browser request's abort signal: closing the page closes the upstream stream too */
export const relayVoice = async (signal: AbortSignal, origin: string = JARVIS_ORIGIN): Promise<Response> => {
  try {
    const up = await fetch(`${origin}/voice/stream`, { signal, cache: 'no-store', headers: { Accept: 'text/event-stream' } });
    if (!up.ok || !up.body) return new Response(OFFLINE, { headers: HEADERS });
    return new Response(up.body, { headers: HEADERS });
  } catch {
    return new Response(OFFLINE, { headers: HEADERS });
  }
};
