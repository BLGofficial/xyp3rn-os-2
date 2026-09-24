import type { NormalizedDocument } from '../types.ts';
import { detectBuildSequence, parseBuildSequence } from './build-sequence.ts';
import { NORMALIZER_ID, normalizeBuildSequence } from './build-sequence-normalize.ts';
import { detectMixRubric, MIX_RUBRIC_NORMALIZER_ID, normalizeMixRubric } from './mix-rubric.ts';
import { detectModuleManifest, MODULE_MANIFEST_NORMALIZER_ID, normalizeModuleManifest } from './module-manifest.ts';
import { detectVocalDna, normalizeVocalDna, VOCAL_DNA_NORMALIZER_ID } from './vocal-dna.ts';

export type Normalizer = {
  readonly id: string;
  readonly detect: (pages: readonly string[]) => boolean;
  readonly normalize: (pages: readonly string[]) => NormalizedDocument;
};

/**
 * Registered normalizers, tried in order. Deny by default: a source no entry detects is
 * rejected by the ingestion pipeline, never stored half-normalized.
 */
export const NORMALIZERS: readonly Normalizer[] = [
  {
    id: NORMALIZER_ID,
    detect: detectBuildSequence,
    normalize: (pages) => normalizeBuildSequence(parseBuildSequence(pages)),
  },
  { id: MODULE_MANIFEST_NORMALIZER_ID, detect: detectModuleManifest, normalize: normalizeModuleManifest },
  { id: VOCAL_DNA_NORMALIZER_ID, detect: detectVocalDna, normalize: normalizeVocalDna },
  { id: MIX_RUBRIC_NORMALIZER_ID, detect: detectMixRubric, normalize: normalizeMixRubric },
];

/**
 * Picks the first normalizer that recognizes the extracted text.
 * @param pages - per-page text (a plain-text source is a single page)
 * @returns the matching normalizer, or undefined if none applies
 */
export const selectNormalizer = (pages: readonly string[]): Normalizer | undefined =>
  NORMALIZERS.find((n) => n.detect(pages));
