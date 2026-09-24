import { join } from 'node:path';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

/**
 * Embedding model (user decision): Supabase/gte-small via transformers.js, quantized ONNX.
 * Why: runs locally with no API key, deterministic, and it is the model Supabase's built-in AI
 * uses in Edge Functions — vectors made here stay compatible with ones made on hosted Supabase.
 * Changing the model invalidates every stored vector: embedding_input_sha256 includes the model
 * id, so the pipeline re-embeds everything on a model change instead of mixing vector spaces.
 */
export const EMBEDDING_MODEL = 'Supabase/gte-small';
export const EMBEDDING_DIM = 384;
/** gte-small's context window; longer input is truncated by the tokenizer and flagged. */
export const MAX_TOKENS = 512;

env.cacheDir = join(import.meta.dirname, '..', '..', '.local-models');

export type Embedding = { readonly vector: number[]; readonly tokens: number; readonly truncated: boolean };

export type Embedder = {
  readonly model: string;
  readonly embed: (texts: readonly string[]) => Promise<Embedding[]>;
};

// Loading the ONNX session costs ~1s and ~100MB; share one per process.
let shared: Promise<FeatureExtractionPipeline> | undefined;

/**
 * Loads (once per process) and wraps the gte-small feature-extraction pipeline.
 * @returns an embedder producing mean-pooled, unit-normalized 384-dim vectors
 */
export const loadEmbedder = async (): Promise<Embedder> => {
  shared ??= pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8' }) as Promise<FeatureExtractionPipeline>;
  const extractor = await shared;
  return {
    model: EMBEDDING_MODEL,
    embed: async (texts) => {
      const out: Embedding[] = [];
      for (const text of texts) {
        const tokens = extractor.tokenizer(text, { truncation: false }).input_ids.dims.at(-1) as number;
        const tensor = await extractor(text, { pooling: 'mean', normalize: true });
        const vector = Array.from(tensor.data as Float32Array);
        if (vector.length !== EMBEDDING_DIM) throw new Error(`expected ${EMBEDDING_DIM} dims, got ${vector.length}`);
        out.push({ vector, tokens, truncated: tokens > MAX_TOKENS });
      }
      return out;
    },
  };
};

/**
 * Serializes a vector for pgvector's text input format.
 * @param vector - numbers to send
 * @returns "[v1,v2,...]" literal to cast with ::extensions.vector
 */
export const toVectorLiteral = (vector: readonly number[]): string => `[${vector.join(',')}]`;
