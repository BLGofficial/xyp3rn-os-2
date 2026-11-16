import type { IndexEntryRecord, SqliteRuntimeDb } from '../sqlite/client.ts';

export type VaultSearchOptions = {
  readonly sector?: string | undefined;
  readonly domain?: string | undefined;
  readonly docType?: string | undefined;
  readonly status?: string | undefined;
  readonly tag?: string | undefined;
  readonly limit?: number | undefined;
};

/**
 * Searches the structural SQLite Vault index across title, path, tags, domain, and frontmatter.
 */
export const searchVaultIndex = (
  db: SqliteRuntimeDb,
  query: string,
  options: VaultSearchOptions = {},
): readonly IndexEntryRecord[] => {
  const limit = options.limit ?? 25;
  const rawHits = db.searchIndex(query, {
    sector: options.sector,
    limit: Math.max(limit * 4, 100),
  });

  const filtered: IndexEntryRecord[] = [];
  for (const hit of rawHits) {
    if (options.domain && hit.domain !== options.domain) continue;
    if (options.docType && hit.docType !== options.docType) continue;
    if (options.status && hit.status !== options.status) continue;
    if (options.tag && !hit.tags.includes(options.tag)) continue;

    filtered.push(hit);
    if (filtered.length >= limit) break;
  }

  return filtered;
};
