import type { Embedder } from '../../knowledge/vector-retrieval/embedder.ts';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import type { VaultEngine } from '../vault-engine/vault-engine.ts';

/**
 * Provider-independent embedding interface for OS 3.0 Semantic Retrieval.
 */
export interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export type SemanticVectorEntry = {
  readonly entityId: string;
  readonly vaultPath: string;
  readonly title: string;
  readonly domain: string;
  readonly sector: string;
  readonly checksum: string;
  readonly provenance: string;
  readonly excerpt: string;
  readonly modelId: string;
  readonly vector: readonly number[];
};

export type SemanticSearchHit = {
  readonly entityId: string;
  readonly vaultPath: string;
  readonly title: string;
  readonly domain: string;
  readonly sector: string;
  readonly checksum: string;
  readonly provenance: string;
  readonly excerpt: string;
  readonly similarity: number;
};

/**
 * Computes cosine similarity between two equal-length vectors.
 */
export const cosineSimilarity = (a: readonly number[], b: readonly number[]): number => {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
};

const fnv1aHash = (str: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/**
 * Local deterministic feature-hashing embedder (token + character trigram projections, L2-normalized).
 * Runs 100% locally in-memory with zero network or external model dependencies.
 */
export const createLocalDeterministicEmbedder = (dimensions = 128): EmbeddingProvider => ({
  modelId: `local-trigram-hash-${dimensions}d`,
  dimensions,
  embed: async (texts) =>
    texts.map((text) => {
      const vec = new Float64Array(dimensions);
      const tokens = text
        .toLowerCase()
        .replace(/[^a-z0-9\s_-]+/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 2);

      for (const token of tokens) {
        const h = fnv1aHash(token);
        const idx = h % dimensions;
        const sign = (h & 1) === 0 ? 1 : -1;
        vec[idx] = (vec[idx] ?? 0) + sign * 2.0;

        for (let i = 0; i <= token.length - 3; i++) {
          const trigram = token.slice(i, i + 3);
          const th = fnv1aHash(trigram);
          const tidx = th % dimensions;
          const tsign = (th & 1) === 0 ? 1 : -1;
          vec[tidx] = (vec[tidx] ?? 0) + tsign * 0.75;
        }
      }

      let norm = 0;
      for (let i = 0; i < dimensions; i++) {
        norm += vec[i]! * vec[i]!;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < dimensions; i++) {
          vec[i] = vec[i]! / norm;
        }
      }
      return Array.from(vec);
    }),
});

/**
 * Wraps the ONNX `Embedder` (`Supabase/gte-small` from `knowledge/vector-retrieval/embedder.ts`)
 * in the provider-independent `EmbeddingProvider` contract.
 */
export const wrapTransformersEmbedder = (embedder: Embedder, dimensions = 384): EmbeddingProvider => ({
  modelId: embedder.model,
  dimensions,
  embed: async (texts) => {
    const out = await embedder.embed(texts);
    return out.map((e) => e.vector);
  },
});

const SEMANTIC_META_KEY = 'os3_semantic_vectors_v3';

/**
 * Rebuildable local vector index over the Obsidian Vault.
 * Requires no cloud database; persists disposable vector cache in `index_meta` and can rebuild from scratch.
 */
export class Os3SemanticIndex {
  readonly #vault: VaultEngine;
  readonly #db: SqliteRuntimeDb;
  readonly #provider: EmbeddingProvider;
  readonly #entries = new Map<string, SemanticVectorEntry>();

  constructor(options: {
    readonly vault: VaultEngine;
    readonly db: SqliteRuntimeDb;
    readonly provider?: EmbeddingProvider | undefined;
  }) {
    this.#vault = options.vault;
    this.#db = options.db;
    this.#provider = options.provider ?? createLocalDeterministicEmbedder(128);

    // Hydrate cached vectors if modelId matches
    if (this.#db.isOpen) {
      const cached = this.#db.getIndexMeta<SemanticVectorEntry[]>(SEMANTIC_META_KEY);
      if (Array.isArray(cached)) {
        for (const item of cached) {
          if (item.modelId === this.#provider.modelId) {
            this.#entries.set(item.vaultPath, item);
          }
        }
      }
    }
  }

  get provider(): EmbeddingProvider {
    return this.#provider;
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Rebuilds the vector index from the current Obsidian Vault structural index.
   */
  async rebuild(options: { readonly sector?: string | undefined; readonly maxFiles?: number | undefined } = {}): Promise<{
    readonly indexedCount: number;
    readonly modelId: string;
  }> {
    this.#entries.clear();
    const indexRows = this.#db.listIndexEntries(options.sector, options.maxFiles ?? 2_000);
    const mdRows = indexRows.filter((r) => r.fileExt === '.md');

    const docs: {
      readonly vaultPath: string;
      readonly entityId: string;
      readonly title: string;
      readonly domain: string;
      readonly sector: string;
      readonly checksum: string;
      readonly provenance: string;
      readonly excerpt: string;
      readonly embedText: string;
    }[] = [];

    for (const row of mdRows) {
      try {
        const doc = await this.#vault.read(row.vaultPath);
        const fm = doc.frontmatter as Record<string, unknown>;
        const entityId =
          typeof fm.id === 'string' && fm.id.trim()
            ? fm.id.trim()
            : `path:${row.vaultPath.toLowerCase()}`;
        const provenance =
          typeof fm.provenance === 'string'
            ? fm.provenance
            : typeof fm.source_ref === 'string'
              ? fm.source_ref
              : `vault://${row.vaultPath}`;
        const excerpt = doc.body.trim().slice(0, 260) || row.title;
        const embedText = `${row.title}\n${row.tags.join(' ')}\n${doc.body.slice(0, 1200)}`;
        docs.push({
          vaultPath: row.vaultPath,
          entityId,
          title: row.title,
          domain: row.domain ?? row.sector,
          sector: row.sector,
          checksum: row.sha256,
          provenance,
          excerpt,
          embedText,
        });
      } catch {
        // Skip unreadable file
      }
    }

    if (docs.length > 0) {
      const vectors = await this.#provider.embed(docs.map((d) => d.embedText));
      for (let i = 0; i < docs.length; i++) {
        const d = docs[i]!;
        const vec = vectors[i]!;
        this.#entries.set(d.vaultPath, {
          entityId: d.entityId,
          vaultPath: d.vaultPath,
          title: d.title,
          domain: d.domain,
          sector: d.sector,
          checksum: d.checksum,
          provenance: d.provenance,
          excerpt: d.excerpt,
          modelId: this.#provider.modelId,
          vector: vec,
        });
      }
    }

    if (this.#db.isOpen && this.#entries.size <= 1_000) {
      this.#db.setIndexMeta(SEMANTIC_META_KEY, [...this.#entries.values()]);
    }

    return {
      indexedCount: this.#entries.size,
      modelId: this.#provider.modelId,
    };
  }

  async search(
    query: string,
    options: { readonly domain?: string | undefined; readonly sector?: string | undefined; readonly limit?: number | undefined } = {},
  ): Promise<readonly SemanticSearchHit[]> {
    if (this.#entries.size === 0) return [];
    const limit = options.limit ?? 10;
    const [queryVec] = await this.#provider.embed([query]);
    if (!queryVec) return [];

    const hits: SemanticSearchHit[] = [];
    for (const entry of this.#entries.values()) {
      if (options.domain && entry.domain.toUpperCase() !== options.domain.toUpperCase()) continue;
      if (options.sector && entry.sector !== options.sector) continue;

      const sim = cosineSimilarity(queryVec, entry.vector);
      if (sim <= 0) continue;

      hits.push({
        entityId: entry.entityId,
        vaultPath: entry.vaultPath,
        title: entry.title,
        domain: entry.domain,
        sector: entry.sector,
        checksum: entry.checksum,
        provenance: entry.provenance,
        excerpt: entry.excerpt,
        similarity: Number(sim.toFixed(4)),
      });
    }

    hits.sort((a, b) => b.similarity - a.similarity || a.vaultPath.localeCompare(b.vaultPath));
    return hits.slice(0, limit);
  }
}
