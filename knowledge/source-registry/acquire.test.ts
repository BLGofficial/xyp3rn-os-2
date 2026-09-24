import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireSource } from './acquire.ts';

const ROOT = join(import.meta.dirname, '..', '..');

describe('acquireSource: file MIME type', () => {
  it.each([
    ['XYP3RN_Agentic_OS_Build_Sequence.pdf', 'application/pdf'],
    ['records/x3lius/music-system.manifest.yaml', 'application/yaml'],
    ['README.md', 'text/markdown'],
    ['package.json', 'application/octet-stream'],
  ])('%s → %s (PDF by magic bytes, text formats by extension, anything else unsupported)', async (path, mime) => {
    const src = await acquireSource({ kind: 'file', path: join(ROOT, path), origin: 'first_party' });
    expect(src.mimeType).toBe(mime);
  });
});
