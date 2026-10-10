import { JARVIS_ORIGIN } from './voice-relay.ts';

/**
 * Sends one typed or spoken command to Jarvis (galaxy/server.py) from the server. Jarvis answers POSTs only to its
 * own origin, so a page cannot call it; this hop sets that Origin. The target is fixed here, never taken from the
 * request. Jarvis has no single command endpoint: "remember ..." goes to /remember, anything else to /chat, which
 * itself routes playbooks, approvals and note questions.
 */

export const MAX_COMMAND_CHARS = 2000;

export type JarvisReply = { readonly kind: 'answer'; readonly answer: string; readonly route: string } | { readonly kind: 'offline' } | { readonly kind: 'refused'; readonly status: number; readonly message: string };

export const routeCommand = (text: string): { readonly path: '/remember' | '/chat'; readonly body: Record<string, string> } =>
  /^\s*remember\b/i.test(text) ? { path: '/remember', body: { text } } : { path: '/chat', body: { question: text } };

/**
 * @param text - the command, already trimmed and non-empty
 * @param origin - Jarvis's origin (a test passes its own)
 * @param fetcher - fetch (a test passes a fake)
 */
export const relayCommand = async (text: string, origin: string = JARVIS_ORIGIN, fetcher: typeof fetch = fetch): Promise<JarvisReply> => {
  const { path, body } = routeCommand(text.slice(0, MAX_COMMAND_CHARS));
  let res: Response;
  try {
    res = await fetcher(`${origin}${path}`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(120_000),
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'offline' };
  }
  const data = (await res.json().catch(() => ({}))) as { answer?: unknown; error?: unknown; route?: unknown };
  if (!res.ok) return { kind: 'refused', status: res.status, message: typeof data.error === 'string' ? data.error : `Jarvis answered ${res.status}` };
  return { kind: 'answer', answer: typeof data.answer === 'string' ? data.answer : '', route: typeof data.route === 'string' ? data.route : path.slice(1) };
};
