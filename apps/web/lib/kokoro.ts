/**
 * Server-only bridge to the local Kokoro-FastAPI service (OpenAI-compatible API). The address and
 * optional credential come from server env only; the browser talks to Mercury's /api/speech*.
 * Loopback-only by design: speech is disclosed as local, and there is no cloud fallback.
 *
 * Env: KOKORO_URL (default http://127.0.0.1:8880), KOKORO_API_KEY (optional Bearer),
 * KOKORO_TIMEOUT_MS (default 30000).
 */

export const VOICES = ['af_heart', 'af_bella', 'am_michael', 'am_fenrir', 'bf_emma', 'bm_george'] as const;
export type Voice = (typeof VOICES)[number];
export const MAX_SPEECH_CHARS = 2000;
export const SPEED_RANGE = [0.5, 2] as const;
export const MAX_WAV_BYTES = 16 * 1024 * 1024; // ~5.8 min of 24 kHz 16-bit mono; 2000 chars is far less
export const MAX_CONCURRENT = 2;
const STATUS_TIMEOUT_MS = 3000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type SpeechInput = { text: string; voice: Voice; speed: number };
export type SpeechResult = { ok: true; wav: Uint8Array<ArrayBuffer> } | { ok: false; status: number; error: string };

export const validateSpeech = (input: Record<string, unknown>): SpeechInput | null => {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const voice = VOICES.find(v => v === input.voice);
  const speed = input.speed === undefined ? 1 : input.speed;
  const format = input.format === undefined ? 'wav' : input.format;
  if (!text || text.length > MAX_SPEECH_CHARS || !voice || format !== 'wav') return null;
  if (typeof speed !== 'number' || !(speed >= SPEED_RANGE[0] && speed <= SPEED_RANGE[1])) return null;
  return { text, voice, speed };
};

const config = () => {
  const url = new URL(process.env.KOKORO_URL || 'http://127.0.0.1:8880');
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.has(url.hostname) || url.username || url.password) {
    throw new Error('KOKORO_URL must be a loopback http(s) URL without credentials');
  }
  const timeoutMs = Number(process.env.KOKORO_TIMEOUT_MS) || 30_000;
  return { base: url.origin + url.pathname.replace(/\/$/, ''), key: process.env.KOKORO_API_KEY, timeoutMs };
};

const upstream = (path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) => {
  const c = config();
  return fetch(c.base + path, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...(c.key ? { Authorization: `Bearer ${c.key}` } : {}) },
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    redirect: 'error', // a redirect could leave the machine
    cache: 'no-store',
  });
};

const failure = (error: unknown): SpeechResult => {
  const name = (error as { name?: string })?.name;
  if (name === 'TimeoutError') return { ok: false, status: 504, error: 'Speech service timed out' };
  if (name !== 'AbortError') console.error('kokoro bridge:', error instanceof Error ? error.message : error);
  return { ok: false, status: 503, error: 'Speech service unavailable' };
};

/** Readiness: the service answers /health within 3 s. Never throws. */
export const speechReady = async (): Promise<boolean> => {
  try { return (await upstream('/health', { method: 'GET' }, STATUS_TIMEOUT_MS)).ok; } catch { return false; }
};

/** Allowlisted voices the service reports installed; null when the service is unreachable. */
export const availableVoices = async (): Promise<Voice[] | null> => {
  try {
    const res = await upstream('/v1/audio/voices', { method: 'GET' }, STATUS_TIMEOUT_MS);
    if (!res.ok) return null;
    const body = (await res.json()) as { voices?: unknown };
    // Kokoro-FastAPI 0.9 returns [{ id, name, ... }]; older releases return plain names.
    const ids = Array.isArray(body.voices) ? body.voices.map((v: unknown) => (typeof v === 'string' ? v : (v as { id?: unknown } | null)?.id)) : [];
    const installed = new Set(ids.filter((v): v is string => typeof v === 'string'));
    return VOICES.filter(v => installed.has(v));
  } catch { return null; }
};

let active = 0;

/**
 * One complete WAV from Kokoro. Concurrency, timeout, size and format are enforced here.
 * @param signal - the browser request's signal, so a client disconnect cancels the upstream call
 */
export const synthesize = async (input: SpeechInput, signal?: AbortSignal): Promise<SpeechResult> => {
  if (active >= MAX_CONCURRENT) return { ok: false, status: 429, error: 'Speech busy; try again shortly' };
  active++;
  try {
    const { timeoutMs } = config();
    const res = await upstream('/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify({ model: 'kokoro', input: input.text, voice: input.voice, speed: input.speed, response_format: 'wav', stream: false }),
    }, timeoutMs, signal);
    if (!res.ok) {
      await res.body?.cancel();
      return res.status >= 500 ? { ok: false, status: 503, error: 'Speech service unavailable' } : { ok: false, status: 502, error: 'Speech service rejected the request' };
    }
    if (Number(res.headers.get('content-length')) > MAX_WAV_BYTES) { await res.body?.cancel(); return { ok: false, status: 502, error: 'Speech service returned an invalid response' }; }
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, status: 502, error: 'Speech service returned an invalid response' };
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_WAV_BYTES) { await reader.cancel(); return { ok: false, status: 502, error: 'Speech service returned an invalid response' }; }
      chunks.push(value);
    }
    const wav = Buffer.concat(chunks);
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
      return { ok: false, status: 502, error: 'Speech service returned an invalid response' };
    }
    return { ok: true, wav: new Uint8Array(wav) };
  } catch (error) {
    return failure(error);
  } finally {
    active--;
  }
};
