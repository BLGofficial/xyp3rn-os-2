import { createHash } from 'node:crypto';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import type { VaultEngine } from '../vault-engine/vault-engine.ts';
import { createLruCache, type LruCache } from './lru-cache.ts';
import type { Os3SemanticIndex } from './semantic-index.ts';
import { extractRelevantExcerpt, Os3StructuralIndex } from './structural-index.ts';

export type QueryIntent =
  | 'lookup'
  | 'research'
  | 'creative'
  | 'governance'
  | 'technical'
  | 'general';

export type AnalyzedQuery = {
  readonly rawQuery: string;
  readonly normalizedTerms: readonly string[];
  readonly intent: QueryIntent;
  readonly targetDomains: readonly string[];
  readonly tagFilters: readonly string[];
  readonly modelScope: string | null;
};

export type ContextItemProvenance = {
  readonly sourceRef: string | null;
  readonly approvalId: string | null;
  readonly approvedBy: string | null;
  readonly promotedVia: string | null;
  readonly origin: string;
};

export type Os3RetrievedContextItem = {
  readonly entityId: string;
  readonly filePath: string;
  readonly title: string;
  readonly domain: string;
  readonly sector: string;
  readonly status: string | null;
  readonly relevantExcerpt: string;
  readonly relevanceScore: number;
  readonly provenance: ContextItemProvenance;
  readonly checksum: string;
  readonly estimatedTokens: number;
  readonly matchSource: 'structural' | 'semantic' | 'hybrid' | 'relationship';
};

export type Os3ContextPackage = {
  readonly query: string;
  readonly analysis: AnalyzedQuery;
  readonly items: readonly Os3RetrievedContextItem[];
  readonly totalTokens: number;
  readonly tokenBudget: number;
  readonly maxItems: number;
  readonly truncatedByBudget: boolean;
  readonly cache: 'hit' | 'miss';
  readonly vaultGeneration: string;
};

export type RetrieveContextOptions = {
  readonly domain?: string | undefined;
  readonly sector?: string | undefined;
  readonly status?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly maxItems?: number | undefined;
  readonly tokenBudget?: number | undefined;
  readonly expandRelationships?: boolean | undefined;
  readonly bypassCache?: boolean | undefined;
};

export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

export const analyzeContextQuery = (rawQuery: string): AnalyzedQuery => {
  const trimmed = rawQuery.trim();
  const lower = trimmed.toLowerCase();

  const tagMatches = [...trimmed.matchAll(/#([a-zA-Z0-9/_-]+)/g)].map((m) => m[1]!.toLowerCase());
  const modelMatch = /\b(suno-v\d+(?:\.\d+)?)\b/i.exec(trimmed);
  const modelScope = modelMatch ? modelMatch[1]!.toLowerCase() : null;

  const targetDomains = new Set<string>();
  if (/\b(song|lyric|track|release|suno|vocal|bpm|808|drill|x3lius|split|rights)\b/i.test(lower)) {
    targetDomains.add('RECORDS');
  }
  if (/\b(evidence|finding|contradiction|hypothesis|experiment|research)\b/i.test(lower)) {
    targetDomains.add('RESEARCH_INTELLIGENCE');
  }
  if (/\b(policy|approval|governance|security|permission|acl)\b/i.test(lower)) {
    targetDomains.add('GOVERNANCE');
  }
  if (/\b(trace|lufs|loudness|audio|analyzer|tech)\b/i.test(lower)) {
    targetDomains.add('TECH');
  }
  if (/\b(rule|canonical|prompt|glossary|framework|knowledge)\b/i.test(lower)) {
    targetDomains.add('KNOWLEDGE');
  }

  let intent: QueryIntent = 'general';
  if (/\b(id:|path:|find entity|lookup)\b/i.test(lower)) {
    intent = 'lookup';
  } else if (targetDomains.has('GOVERNANCE')) {
    intent = 'governance';
  } else if (targetDomains.has('RESEARCH_INTELLIGENCE')) {
    intent = 'research';
  } else if (targetDomains.has('RECORDS')) {
    intent = 'creative';
  } else if (targetDomains.has('TECH')) {
    intent = 'technical';
  }

  const normalizedTerms = lower
    .replace(/#[a-z0-9/_-]+/g, ' ')
    .split(/[^a-z0-9_.-]+/)
    .filter((t) => t.length >= 2 && !['the', 'and', 'for', 'with', 'from', 'that', 'this'].includes(t));

  return {
    rawQuery: trimmed,
    normalizedTerms,
    intent,
    targetDomains: [...targetDomains],
    tagFilters: tagMatches,
    modelScope,
  };
};

/**
 * OS 3.0 Obsidian-First Context Engine.
 * Performs query analysis, hybrid structural + semantic + relationship retrieval,
 * deduplication, provenance attachment, token budget enforcement, and generation-aware caching.
 */
export class Os3ContextEngine {
  readonly #vault: VaultEngine;
  readonly #db: SqliteRuntimeDb;
  readonly #structural: Os3StructuralIndex;
  readonly #semantic: Os3SemanticIndex | null;
  readonly #cache: LruCache<Omit<Os3ContextPackage, 'cache'>>;

  constructor(options: {
    readonly vault: VaultEngine;
    readonly db: SqliteRuntimeDb;
    readonly structural?: Os3StructuralIndex | undefined;
    readonly semantic?: Os3SemanticIndex | null | undefined;
    readonly cacheMaxEntries?: number | undefined;
    readonly cacheTtlMs?: number | undefined;
  }) {
    this.#vault = options.vault;
    this.#db = options.db;
    this.#structural = options.structural ?? new Os3StructuralIndex({ vault: this.#vault, db: this.#db });
    this.#semantic = options.semantic ?? null;
    this.#cache = createLruCache({
      maxEntries: options.cacheMaxEntries ?? 256,
      ttlMs: options.cacheTtlMs ?? 10 * 60_000,
    });
  }

  get structural(): Os3StructuralIndex {
    return this.#structural;
  }

  get semantic(): Os3SemanticIndex | null {
    return this.#semantic;
  }

  /**
   * Computes a generation fingerprint from `index_state` so any Vault write, update,
   * deletion, or rename invalidates cached context packages immediately.
   */
  computeVaultGeneration(): string {
    if (!this.#db.isOpen) return 'offline';
    const row = this.#db.raw
      .prepare(
        `SELECT COUNT(*) as c, COALESCE(MAX(indexed_at), '-') as max_idx, COALESCE(MAX(sha256), '-') as max_sha FROM index_state`,
      )
      .get() as { c: number; max_idx: string; max_sha: string };
    return `${row.c}:${row.max_idx}:${row.max_sha.slice(0, 16)}`;
  }

  async retrieveContext(
    query: string,
    options: RetrieveContextOptions = {},
  ): Promise<Os3ContextPackage> {
    const analysis = analyzeContextQuery(query);
    const maxItems = options.maxItems ?? 10;
    const tokenBudget = options.tokenBudget ?? 2_000;
    const vaultGeneration = this.computeVaultGeneration();

    const cacheKey = createHash('sha256')
      .update(
        JSON.stringify({
          query: analysis.rawQuery,
          options,
          vaultGeneration,
          semanticModel: this.#semantic?.provider.modelId ?? 'none',
        }),
      )
      .digest('hex');

    if (!options.bypassCache) {
      const cached = this.#cache.get(cacheKey);
      if (cached) {
        return { ...cached, cache: 'hit' };
      }
    }

    const mergedTags = [
      ...(options.tags ?? []),
      ...analysis.tagFilters,
    ];

    // 1. Structural full-text & metadata search
    const structuralHits = await this.#structural.fullTextSearch(query, {
      domain: options.domain,
      sector: options.sector,
      status: options.status,
      tags: mergedTags.length > 0 ? mergedTags : undefined,
      limit: maxItems * 3,
    });

    // 2. Optional semantic retrieval
    const semanticHits = this.#semantic
      ? await this.#semantic.search(query, {
          domain: options.domain,
          sector: options.sector,
          limit: maxItems * 2,
        })
      : [];

    // 3. Merge and deduplicate by entityId and checksum
    const candidateMap = new Map<
      string,
      {
        readonly vaultPath: string;
        readonly entityId: string;
        readonly title: string;
        readonly domain: string;
        readonly sector: string;
        readonly status: string | null;
        readonly checksum: string;
        readonly excerpt: string;
        score: number;
        matchSource: Os3RetrievedContextItem['matchSource'];
      }
    >();

    for (const sHit of structuralHits) {
      candidateMap.set(sHit.node.vaultPath, {
        vaultPath: sHit.node.vaultPath,
        entityId: sHit.node.entityId,
        title: sHit.node.title,
        domain: sHit.node.domain,
        sector: sHit.node.sector,
        status: sHit.node.status,
        checksum: sHit.node.checksum,
        excerpt: sHit.excerpt,
        score: sHit.score,
        matchSource: 'structural',
      });
    }

    for (const semHit of semanticHits) {
      const existing = candidateMap.get(semHit.vaultPath);
      const semScore = semHit.similarity * 5.0;
      if (existing) {
        existing.score = Number((existing.score + semScore).toFixed(4));
        existing.matchSource = 'hybrid';
      } else {
        const node = this.#structural.lookupByPath(semHit.vaultPath);
        if (options.status && node?.status !== options.status) continue;
        candidateMap.set(semHit.vaultPath, {
          vaultPath: semHit.vaultPath,
          entityId: semHit.entityId,
          title: semHit.title,
          domain: semHit.domain,
          sector: semHit.sector,
          status: node?.status ?? null,
          checksum: semHit.checksum,
          excerpt: semHit.excerpt,
          score: Number(semScore.toFixed(4)),
          matchSource: 'semantic',
        });
      }
    }

    // 4. Optional 1-hop relationship expansion from top direct hits
    if (options.expandRelationships ?? true) {
      const topSeeds = [...candidateMap.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      for (const seed of topSeeds) {
        const rels = this.#structural.traverseRelationships(seed.vaultPath, 1);
        for (const rel of rels) {
          if (candidateMap.has(rel.vaultPath)) continue;
          const node = this.#structural.lookupByPath(rel.vaultPath);
          if (!node) continue;
          if (options.domain && node.domain.toUpperCase() !== options.domain.toUpperCase()) continue;
          if (options.sector && node.sector !== options.sector) continue;

          let excerpt = node.title;
          try {
            const doc = await this.#vault.read(node.vaultPath);
            excerpt = extractRelevantExcerpt(doc.body || node.title, analysis.normalizedTerms, 220);
          } catch {
            // Keep title fallback
          }

          candidateMap.set(node.vaultPath, {
            vaultPath: node.vaultPath,
            entityId: node.entityId,
            title: node.title,
            domain: node.domain,
            sector: node.sector,
            status: node.status,
            checksum: node.checksum,
            excerpt,
            score: Number((seed.score * 0.55).toFixed(4)),
            matchSource: 'relationship',
          });
        }
      }
    }

    // 5. Sort by relevance score desc, deduplicate by entityId & checksum, and enforce tokenBudget + maxItems
    const sortedCandidates = [...candidateMap.values()].sort(
      (a, b) => b.score - a.score || a.vaultPath.localeCompare(b.vaultPath),
    );

    const seenEntityIds = new Set<string>();
    const seenChecksums = new Set<string>();
    const finalItems: Os3RetrievedContextItem[] = [];
    let totalTokens = 0;
    let truncatedByBudget = false;

    for (const cand of sortedCandidates) {
      if (finalItems.length >= maxItems) break;
      if (seenEntityIds.has(cand.entityId) || seenChecksums.has(cand.checksum)) {
        continue;
      }

      const entry = this.#db.isOpen ? this.#db.getIndexEntry(cand.vaultPath) : null;
      const fm = entry?.frontmatter ?? {};
      const provenance: ContextItemProvenance = {
        sourceRef:
          typeof fm.source_ref === 'string'
            ? fm.source_ref
            : Array.isArray(fm.source_refs) && typeof fm.source_refs[0] === 'string'
              ? fm.source_refs[0]
              : typeof fm.provenance === 'string'
                ? fm.provenance
                : null,
        approvalId: typeof fm.approval_id === 'string' ? fm.approval_id : null,
        approvedBy: typeof fm.approved_by === 'string' ? fm.approved_by : null,
        promotedVia: typeof fm.promoted_via === 'string' ? fm.promoted_via : null,
        origin: typeof fm.origin === 'string' ? fm.origin : `vault://${cand.vaultPath}`,
      };

      let excerpt = cand.excerpt;
      let itemTokens = estimateTokens(`${cand.title}\n${excerpt}`);

      if (totalTokens + itemTokens > tokenBudget) {
        const remainingTokens = tokenBudget - totalTokens;
        const maxRemainingChars = Math.max(0, remainingTokens * 4 - cand.title.length - 4);
        if (maxRemainingChars >= 32) {
          excerpt = `${excerpt.slice(0, maxRemainingChars).trim()}…`;
          itemTokens = estimateTokens(`${cand.title}\n${excerpt}`);
          truncatedByBudget = true;
          if (totalTokens + itemTokens > tokenBudget) {
            break;
          }
        } else {
          truncatedByBudget = true;
          break;
        }
      }

      seenEntityIds.add(cand.entityId);
      seenChecksums.add(cand.checksum);
      totalTokens += itemTokens;

      finalItems.push({
        entityId: cand.entityId,
        filePath: cand.vaultPath,
        title: cand.title,
        domain: cand.domain,
        sector: cand.sector,
        status: cand.status,
        relevantExcerpt: excerpt,
        relevanceScore: cand.score,
        provenance,
        checksum: cand.checksum,
        estimatedTokens: itemTokens,
        matchSource: cand.matchSource,
      });
    }

    const pkgWithoutCache: Omit<Os3ContextPackage, 'cache'> = {
      query,
      analysis,
      items: finalItems,
      totalTokens,
      tokenBudget,
      maxItems,
      truncatedByBudget,
      vaultGeneration,
    };

    this.#cache.set(cacheKey, pkgWithoutCache);
    return {
      ...pkgWithoutCache,
      cache: 'miss',
    };
  }
}
