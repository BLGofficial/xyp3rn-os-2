export const CAPTURE_KINDS = ['lyric-fragment', 'song-idea', 'task', 'style-request', 'meta-tag-request', 'general-note'] as const;
export type CaptureKind = typeof CAPTURE_KINDS[number];
export type StudioCapture = { captureId: string; text: string; language: string; intent: CaptureKind; receipt?: string; inputMethod?: 'typed' | 'wispr-flow' };

/** Both finished voice transcripts and typed text enter this same explicit, draft-only route. */
export function validateCapture(input: unknown): StudioCapture {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Capture fields are required.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['captureId', 'text', 'language', 'intent', 'receipt', 'inputMethod'].includes(key))) throw new Error('Unsupported capture field.');
  if (typeof value.captureId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.captureId)) throw new Error('A capture ID is required.');
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 20_000) throw new Error('Enter between 1 and 20,000 characters.');
  if (typeof value.language !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(value.language)) throw new Error('Choose a source language.');
  if (!CAPTURE_KINDS.includes(value.intent as CaptureKind)) throw new Error('Choose a capture kind.');
  if (value.receipt !== undefined && (typeof value.receipt !== 'string' || value.receipt.length > 120_000)) throw new Error('Invalid transcription receipt.');
  if (value.inputMethod !== undefined && !['typed', 'wispr-flow'].includes(value.inputMethod as string)) throw new Error('Invalid input method.');
  if (value.receipt && value.inputMethod === 'wispr-flow') throw new Error('Wispr Flow text cannot claim a browser transcription receipt.');
  return { captureId: value.captureId, text: value.text.trim(), language: value.language, intent: value.intent as CaptureKind,
    ...(value.inputMethod ? { inputMethod: value.inputMethod as 'typed' | 'wispr-flow' } : {}),
    ...(value.receipt ? { receipt: value.receipt as string } : {}) };
}
