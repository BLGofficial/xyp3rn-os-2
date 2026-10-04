import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const AUDIO_LIMIT = 10 * 1024 * 1024;
export class SpeechError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
type Env = Record<string, string | undefined>;
const languages = (value?: string) => (value ?? '').split(',').map(s => s.trim().toLowerCase()).filter(s => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(s));
function config(kind: 'WHISPER' | 'KOKORO', env: Env) {
  const url = env[`XYP_${kind}_URL`], model = env[`XYP_${kind}_MODEL`];
  const supported = languages(env[`XYP_${kind}_LANGUAGES`]);
  const voice = env.XYP_KOKORO_VOICE;
  if (!url || !model || !supported.length || (kind === 'KOKORO' && !voice)) throw new SpeechError(`${kind} is not configured. Text capture remains available.`, 503);
  let endpoint: URL;
  try { endpoint = new URL(url); } catch { throw new SpeechError(`${kind} configuration is invalid.`, 503); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
    throw new SpeechError(`${kind} requires HTTPS or a loopback HTTP endpoint without URL credentials.`, 503);
  }
  return { url, model, supported, voice, key: env[`XYP_${kind}_API_KEY`] };
}
export function speechStatus(env: Env = process.env) {
  const status = (kind: 'WHISPER' | 'KOKORO') => {
    try { return { configured: true, languages: config(kind, env).supported }; }
    catch { return { configured: false, languages: [] as string[] }; }
  };
  return { transcription: status('WHISPER'), speech: status('KOKORO') };
}
export async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number) {
  if (!stream) throw new SpeechError('Empty request or response.');
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > limit) { await reader.cancel(); throw new SpeechError('Content exceeds the allowed size.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
export function audioExtension(bytes: Uint8Array, mime: string) {
  const b = Buffer.from(bytes), type = mime.split(';')[0];
  if (type === 'audio/webm' && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  if (type === 'audio/ogg' && b.subarray(0, 4).toString() === 'OggS') return 'ogg';
  if (['audio/wav', 'audio/x-wav'].includes(type!) && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WAVE') return 'wav';
  if (type === 'audio/mp4' && b.subarray(4, 8).toString() === 'ftyp') return 'mp4';
  throw new SpeechError('Unsupported or malformed audio. Use WebM, Ogg, WAV or MP4.');
}
async function request(url: string, init: RequestInit, fetcher: typeof fetch) {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', cache: 'no-store' });
    if (!response.ok) { await response.body?.cancel(); throw new SpeechError(`Speech service returned HTTP ${response.status}. Retry or use text.`, 502); }
    return response;
  } catch (error) {
    if (error instanceof SpeechError) throw error;
    throw new SpeechError('Speech service unavailable, cancelled or timed out. Retry or use text.', 502);
  }
}
type TranscriptProof = { text: string; language: string; detectedLanguage: string | null; audioSha256: string; model: string; at: string };
function sign(payload: string, secret: string) { return createHmac('sha256', secret).update(`studio-transcript/v1:${payload}`).digest(); }
export function transcriptProof(receipt: string, secret: string, now = Date.now()): TranscriptProof {
  try {
    const [payload, signature, extra] = receipt.split('.');
    if (!payload || !signature || extra || receipt.length > 120_000) throw new Error();
    const actual = Buffer.from(signature, 'base64url'), expected = sign(payload, secret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const proof = JSON.parse(Buffer.from(payload, 'base64url').toString()) as TranscriptProof;
    const age = now - Date.parse(proof.at);
    if (!Number.isFinite(age) || age < -60_000 || age > 60 * 60_000) throw new Error();
    return proof;
  } catch { throw new SpeechError('Transcription receipt is invalid or expired. Retry transcription or save as typed text.'); }
}
export async function transcribe(bytes: Uint8Array, mime: string, language: string, signal?: AbortSignal,
  env: Env = process.env, fetcher: typeof fetch = fetch) {
  const c = config('WHISPER', env);
  if (!c.supported.includes(language)) throw new SpeechError('This transcription language is not configured.');
  if (!bytes.length || bytes.length > AUDIO_LIMIT) throw new SpeechError('Recording must be between 1 byte and 10 MiB.', 413);
  const extension = audioExtension(bytes, mime);
  if (!env.XYP_WEB_TOKEN || env.XYP_WEB_TOKEN.length < 16) throw new SpeechError('Owner session is not configured.', 503);
  const body = new FormData();
  body.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), `capture.${extension}`);
  body.set('model', c.model); body.set('language', language); body.set('response_format', 'verbose_json');
  const abort = AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
  const response = await request(c.url, { method: 'POST', body, signal: abort, headers: c.key ? { Authorization: `Bearer ${c.key}` } : {} }, fetcher);
  let result: { text?: unknown; language?: unknown };
  try { result = JSON.parse((await readBounded(response.body, 256_000)).toString()); }
  catch { throw new SpeechError('Transcription service returned an invalid response.', 502); }
  if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 20_000) throw new SpeechError('Transcription is empty or too long. Record a shorter fragment.', 502);
  const proof: TranscriptProof = { text: result.text.trim(), language, detectedLanguage: typeof result.language === 'string' ? result.language.slice(0, 80) : null,
    audioSha256: createHash('sha256').update(bytes).digest('hex'), model: c.model, at: new Date().toISOString() };
  const payload = Buffer.from(JSON.stringify(proof)).toString('base64url');
  return { text: proof.text, language, detectedLanguage: proof.detectedLanguage, receipt: `${payload}.${sign(payload, env.XYP_WEB_TOKEN).toString('base64url')}` };
}
export async function speak(text: string, language: string, signal?: AbortSignal, env: Env = process.env, fetcher: typeof fetch = fetch) {
  const c = config('KOKORO', env);
  if (!c.supported.includes(language)) throw new SpeechError('Read-back is unavailable for this language. Your text is preserved.');
  if (!text.trim() || text.length > 600) throw new SpeechError('Select between 1 and 600 characters for read-back.');
  const response = await request(c.url, { method: 'POST', signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]),
    headers: { 'Content-Type': 'application/json', ...(c.key ? { Authorization: `Bearer ${c.key}` } : {}) },
    body: JSON.stringify({ model: c.model, voice: c.voice, input: text, response_format: 'wav' }) }, fetcher);
  const bytes = await readBounded(response.body, AUDIO_LIMIT);
  try { audioExtension(bytes, 'audio/wav'); } catch { throw new SpeechError('Speech service returned invalid WAV audio.', 502); }
  return bytes;
}
