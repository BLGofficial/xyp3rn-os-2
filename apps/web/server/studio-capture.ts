import { validateCapture } from '../lib/studio-capture.ts';
import { transcriptProof } from './speech.ts';
import { uploadFiles } from './ops.ts';
import type { DispatchDeps } from '../../../core/orchestrator/dispatch.ts';

export function captureDocument(input: unknown, secret: string) {
  const capture = validateCapture(input);
  const proof = capture.receipt ? transcriptProof(capture.receipt, secret) : null;
  if (proof && proof.language !== capture.language) throw new Error('Keep the recorded source language or save as typed text.');
  return { format: 'xyp-studio-capture/v1', state: 'draft', captureId: capture.captureId, intent: capture.intent,
    text: capture.text, language: capture.language,
    provenance: proof ? { input: 'voice', ...proof, edited: proof.text !== capture.text }
      : capture.inputMethod === 'wispr-flow' ? { input: 'external-dictation', provider: 'wispr-flow', attestation: 'owner-declared' } : { input: 'typed' } };
}
/** Append a new Vault draft through the existing curator. No approved target or execution path exists here. */
export async function saveCapture(deps: DispatchDeps, input: unknown, secret: string) {
  const document = captureDocument(input, secret);
  const [saved] = await uploadFiles(deps, [{ name: `studio-${document.intent}-${document.captureId}.txt`,
    bytes: new TextEncoder().encode(JSON.stringify(document, null, 2)) }],
  { as: 'document', language: document.language, tags: ['studio-capture', 'draft', document.intent] });
  if (!saved) throw new Error('No capture receipt was returned.');
  return { sourceId: saved.file.sourceId, sha256: saved.file.sha256, runIds: saved.file.runIds,
    status: 'draft', href: `/vault/files/${saved.file.sourceId}` };
}
