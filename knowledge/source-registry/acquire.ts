import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { isPdf } from '../ingestion/extract-pdf.ts';
import { slugify } from '../ingestion/types.ts';
import type { SourceKind, SourceOrigin } from '../quality/rubric.ts';

/**
 * Source Registry input. `origin` is required on every kind: reliability scoring depends on it,
 * and a default would silently mark external material as first-party.
 */
export type SourceInput =
  | { readonly kind: 'file'; readonly path: string; readonly origin: SourceOrigin }
  | { readonly kind: 'url'; readonly url: string; readonly origin: SourceOrigin }
  | { readonly kind: 'manual'; readonly title: string; readonly text: string; readonly origin: SourceOrigin };

export type AcquiredSource = {
  readonly kind: SourceKind;
  readonly origin: SourceOrigin;
  readonly uri: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly checksum: string;
  /** Used only when no normalizer supplies a better title. */
  readonly fallbackTitle: string;
};

/**
 * Lowercase hex SHA-256 — the content address stored in sources.checksum_sha256.
 * @param bytes - raw content
 * @returns 64-char hex digest
 */
export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Human-readable identifier of what was requested, recorded on the run before acquisition
 * (so a run that fails to fetch still says what it tried).
 * @param input - source registry input
 * @returns requested_uri value
 */
export const describeInput = (input: SourceInput): string =>
  input.kind === 'file' ? displayPath(input.path) : input.kind === 'url' ? input.url : `manual:${slugify(input.title)}`;

/** Repo-relative when inside the working tree, so the uri doesn't leak a machine's layout. */
const displayPath = (path: string): string => {
  const abs = resolve(path);
  const rel = relative(process.cwd(), abs);
  return rel.startsWith('..') || isAbsolute(rel) ? abs : rel;
};

const sniffMime = (bytes: Uint8Array, declared: string | null): string =>
  isPdf(bytes) ? 'application/pdf' : (declared?.split(';')[0]?.trim() || 'application/octet-stream');

/** Text formats a local file may be ingested as (Phase 7: module manifests). Anything else stays unsupported. */
const FILE_TEXT_TYPES: Readonly<Record<string, string>> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

/**
 * Reads the source's bytes and computes its checksum. Performs I/O only — no DB writes.
 * @param input - file path, URL, or manual text
 * @returns bytes plus the metadata the registry stores
 * @throws Error on unreadable file or non-2xx fetch
 */
export const acquireSource = async (input: SourceInput): Promise<AcquiredSource> => {
  if (input.kind === 'file') {
    const bytes = new Uint8Array(await readFile(input.path));
    return {
      kind: 'file',
      origin: input.origin,
      uri: displayPath(input.path),
      bytes,
      mimeType: sniffMime(bytes, FILE_TEXT_TYPES[extname(input.path).toLowerCase()] ?? null),
      checksum: sha256Hex(bytes),
      fallbackTitle: displayPath(input.path),
    };
  }
  if (input.kind === 'url') {
    const res = await fetch(input.url);
    if (!res.ok) throw new Error(`fetch ${input.url} failed: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      kind: 'url',
      origin: input.origin,
      uri: input.url,
      bytes,
      mimeType: sniffMime(bytes, res.headers.get('content-type')),
      checksum: sha256Hex(bytes),
      fallbackTitle: input.url,
    };
  }
  const bytes = new TextEncoder().encode(input.text);
  return {
    kind: 'manual',
    origin: input.origin,
    uri: describeInput(input),
    bytes,
    mimeType: 'text/plain',
    checksum: sha256Hex(bytes),
    fallbackTitle: input.title,
  };
};
