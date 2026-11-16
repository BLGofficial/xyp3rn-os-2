import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import type { IndexEntryRecord, SqliteRuntimeDb } from '../sqlite/client.ts';
import { IGNORED_VAULT_DIRS, validateVaultPath } from '../vault-engine/path-guard.ts';
import { sha256Hex } from '../vault-engine/revision.ts';
import type { VaultEngine } from '../vault-engine/vault-engine.ts';

export type StructuralEntityNode = {
  readonly vaultPath: string;
  readonly entityId: string;
  readonly title: string;
  readonly docType: string | null;
  readonly schema: string | null;
  readonly domain: string;
  readonly sector: string;
  readonly tags: readonly string[];
  readonly status: string | null;
  readonly wikilinks: readonly string[];
  readonly backlinks: readonly string[];
  readonly dependencies: readonly string[];
  readonly mtimeMs: number;
  readonly checksum: string;
};

export type RelationshipTraversalHit = {
  readonly vaultPath: string;
  readonly entityId: string;
  readonly title: string;
  readonly depth: number;
  readonly relationKind: 'wikilink' | 'backlink' | 'dependency';
  readonly viaPath: string;
};

export type StaleIndexEntry = {
  readonly vaultPath: string;
  readonly reason: 'deleted_on_disk' | 'checksum_mismatch' | 'unindexed_on_disk';
  readonly indexedSha256: string | null;
  readonly diskSha256: string | null;
};

export type RenameDetection = {
  readonly fromPath: string;
  readonly toPath: string;
  readonly entityId: string | null;
  readonly sha256: string;
};

export type IndexReconciliationReport = {
  readonly created: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly renamed: readonly RenameDetection[];
  readonly staleCountBefore: number;
  readonly totalIndexedAfter: number;
};

const stripMd = (p: string): string => (p.toLowerCase().endsWith('.md') ? p.slice(0, -3) : p);

const deriveEntityId = (entry: IndexEntryRecord): string => {
  const fmId = entry.frontmatter.id;
  if (typeof fmId === 'string' && fmId.trim().length > 0) return fmId.trim();
  if (typeof fmId === 'number') return String(fmId);
  return `path:${stripMd(entry.vaultPath).toLowerCase().replace(/[^a-z0-9/_-]+/g, '-')}`;
};

const extractDependencies = (entry: IndexEntryRecord): readonly string[] => {
  const fm = entry.frontmatter;
  const deps = new Set<string>();

  const addRef = (val: unknown): void => {
    if (typeof val === 'string' && val.trim().length > 0) {
      const clean = val.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0]?.trim();
      if (clean) deps.add(clean);
    } else if (Array.isArray(val)) {
      for (const item of val) addRef(item);
    }
  };

  addRef(fm.depends_on);
  addRef(fm.source_ref);
  addRef(fm.source_refs);
  addRef(fm.evidence_ids);
  addRef(fm.tracks);

  for (const w of entry.wikilinks) {
    if (w.target.trim()) deps.add(w.target.trim());
  }

  return [...deps];
};

/**
 * OS 3.0 Structural Knowledge Index backed by the Obsidian Vault and disposable `index_state`.
 * Enforces the invariant: "The Vault always wins over generated indexes."
 */
export class Os3StructuralIndex {
  readonly #vault: VaultEngine;
  readonly #db: SqliteRuntimeDb;

  constructor(options: { readonly vault: VaultEngine; readonly db: SqliteRuntimeDb }) {
    this.#vault = options.vault;
    this.#db = options.db;
  }

  toStructuralNode(entry: IndexEntryRecord): StructuralEntityNode {
    const links = this.#vault.resolveLinks(entry.vaultPath);
    return {
      vaultPath: entry.vaultPath,
      entityId: deriveEntityId(entry),
      title: entry.title,
      docType: entry.docType,
      schema: typeof entry.frontmatter.schema === 'string' ? entry.frontmatter.schema : null,
      domain: entry.domain ?? entry.sector,
      sector: entry.sector,
      tags: entry.tags,
      status: entry.status,
      wikilinks: links.outgoing,
      backlinks: links.backlinks,
      dependencies: extractDependencies(entry),
      mtimeMs: entry.mtimeMs,
      checksum: entry.sha256,
    };
  }

  lookupByPath(vaultPath: string): StructuralEntityNode | null {
    const entry = this.#db.getIndexEntry(vaultPath);
    return entry ? this.toStructuralNode(entry) : null;
  }

  lookupByEntityId(entityId: string): StructuralEntityNode | null {
    const needle = entityId.trim().toLowerCase();
    const all = this.#db.listIndexEntries(undefined, 50_000);
    for (const entry of all) {
      if (deriveEntityId(entry).toLowerCase() === needle) {
        return this.toStructuralNode(entry);
      }
    }
    return null;
  }

  searchByTags(
    tags: readonly string[],
    mode: 'any' | 'all' = 'any',
    limit = 50,
  ): readonly StructuralEntityNode[] {
    const wanted = tags.map((t) => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean);
    if (wanted.length === 0) return [];

    const all = this.#db.listIndexEntries(undefined, 50_000);
    const out: StructuralEntityNode[] = [];

    for (const entry of all) {
      const entryTags = new Set(entry.tags.map((t) => t.toLowerCase()));
      const match =
        mode === 'all'
          ? wanted.every((w) => entryTags.has(w))
          : wanted.some((w) => entryTags.has(w));
      if (match) {
        out.push(this.toStructuralNode(entry));
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  searchByDomain(
    domain: string,
    options: { readonly status?: string | undefined; readonly docType?: string | undefined; readonly limit?: number | undefined } = {},
  ): readonly StructuralEntityNode[] {
    const targetDomain = domain.trim().toUpperCase();
    const limit = options.limit ?? 50;
    const all = this.#db.listIndexEntries(undefined, 50_000);
    const out: StructuralEntityNode[] = [];

    for (const entry of all) {
      if ((entry.domain ?? '').toUpperCase() !== targetDomain) continue;
      if (options.status && entry.status !== options.status) continue;
      if (options.docType && entry.docType !== options.docType) continue;
      out.push(this.toStructuralNode(entry));
      if (out.length >= limit) break;
    }
    return out;
  }

  getBacklinks(vaultPath: string): readonly string[] {
    return this.#vault.backlinks(vaultPath);
  }

  /**
   * Full-text and metadata search across indexed notes AND live Markdown body content.
   */
  async fullTextSearch(
    query: string,
    options: {
      readonly domain?: string | undefined;
      readonly sector?: string | undefined;
      readonly docType?: string | undefined;
      readonly status?: string | undefined;
      readonly tags?: readonly string[] | undefined;
      readonly limit?: number | undefined;
    } = {},
  ): Promise<
    ReadonlyArray<{
      readonly node: StructuralEntityNode;
      readonly score: number;
      readonly excerpt: string;
    }>
  > {
    const limit = options.limit ?? 20;
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .filter((t) => t.length >= 2);

    const all = this.#db.listIndexEntries(options.sector, 50_000);
    const scored: {
      readonly entry: IndexEntryRecord;
      readonly metadataScore: number;
    }[] = [];

    for (const entry of all) {
      if (options.domain && (entry.domain ?? '').toUpperCase() !== options.domain.toUpperCase()) continue;
      if (options.docType && entry.docType !== options.docType) continue;
      if (options.status && entry.status !== options.status) continue;
      if (options.tags && options.tags.length > 0) {
        const tagSet = new Set(entry.tags.map((t) => t.toLowerCase()));
        if (!options.tags.every((t) => tagSet.has(t.toLowerCase().replace(/^#/, '')))) continue;
      }

      const titleLower = entry.title.toLowerCase();
      const pathLower = entry.vaultPath.toLowerCase();
      const tagsLower = entry.tags.join(' ').toLowerCase();
      const fmLower = JSON.stringify(entry.frontmatter).toLowerCase();

      let metaScore = 0;
      if (terms.length === 0) {
        metaScore = 1;
      } else {
        for (const term of terms) {
          if (titleLower.includes(term)) metaScore += 3.0;
          if (tagsLower.includes(term)) metaScore += 2.0;
          if (pathLower.includes(term)) metaScore += 1.5;
          if (fmLower.includes(term)) metaScore += 1.0;
        }
      }

      scored.push({ entry, metadataScore: metaScore });
    }

    // Inspect top candidates' Markdown bodies for body-level full-text matches and excerpts
    scored.sort((a, b) => b.metadataScore - a.metadataScore);
    const candidates = scored.slice(0, Math.max(limit * 4, 80));

    const results: {
      readonly node: StructuralEntityNode;
      readonly score: number;
      readonly excerpt: string;
    }[] = [];

    for (const cand of candidates) {
      let bodyText = '';
      try {
        const doc = await this.#vault.read(cand.entry.vaultPath);
        bodyText = doc.body.trim();
      } catch {
        continue;
      }

      const bodyLower = bodyText.toLowerCase();
      let bodyScore = 0;
      for (const term of terms) {
        if (bodyLower.includes(term)) {
          bodyScore += 1.25;
        }
      }

      const totalScore = cand.metadataScore + bodyScore;
      if (terms.length > 0 && totalScore <= 0) continue;

      const statusBoost =
        cand.entry.status === 'canonical'
          ? 1.25
          : cand.entry.status === 'approved' || cand.entry.status === 'live'
            ? 1.1
            : 1.0;

      const excerpt = extractRelevantExcerpt(bodyText || cand.entry.title, terms, 260);
      results.push({
        node: this.toStructuralNode(cand.entry),
        score: Number((totalScore * statusBoost).toFixed(4)),
        excerpt,
      });
    }

    results.sort((a, b) => b.score - a.score || a.node.vaultPath.localeCompare(b.node.vaultPath));
    return results.slice(0, limit);
  }

  /**
   * Traverses outgoing wikilinks, backlinks, and explicit dependencies up to `maxDepth` hops.
   */
  traverseRelationships(
    startVaultPathOrEntityId: string,
    maxDepth = 2,
  ): readonly RelationshipTraversalHit[] {
    const startNode =
      this.lookupByPath(startVaultPathOrEntityId) ?? this.lookupByEntityId(startVaultPathOrEntityId);
    if (!startNode) return [];

    const all = this.#db.listIndexEntries(undefined, 50_000);
    const resolveTargetToEntry = (target: string): IndexEntryRecord | null => {
      const clean = stripMd(target.trim()).toLowerCase();
      const base = basename(clean);
      for (const e of all) {
        const vp = stripMd(e.vaultPath).toLowerCase();
        const stem = basename(vp);
        const eid = deriveEntityId(e).toLowerCase();
        if (vp === clean || stem === base || e.title.toLowerCase() === clean || eid === clean) {
          return e;
        }
      }
      return null;
    };

    const visited = new Set<string>([startNode.vaultPath]);
    const queue: { readonly node: StructuralEntityNode; readonly depth: number }[] = [
      { node: startNode, depth: 0 },
    ];
    const hits: RelationshipTraversalHit[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      const nextDepth = current.depth + 1;

      for (const wTarget of current.node.wikilinks) {
        const entry = resolveTargetToEntry(wTarget);
        if (!entry || visited.has(entry.vaultPath)) continue;
        visited.add(entry.vaultPath);
        const child = this.toStructuralNode(entry);
        hits.push({
          vaultPath: child.vaultPath,
          entityId: child.entityId,
          title: child.title,
          depth: nextDepth,
          relationKind: 'wikilink',
          viaPath: current.node.vaultPath,
        });
        queue.push({ node: child, depth: nextDepth });
      }

      for (const bPath of current.node.backlinks) {
        const entry = this.#db.getIndexEntry(bPath);
        if (!entry || visited.has(entry.vaultPath)) continue;
        visited.add(entry.vaultPath);
        const child = this.toStructuralNode(entry);
        hits.push({
          vaultPath: child.vaultPath,
          entityId: child.entityId,
          title: child.title,
          depth: nextDepth,
          relationKind: 'backlink',
          viaPath: current.node.vaultPath,
        });
        queue.push({ node: child, depth: nextDepth });
      }

      for (const depTarget of current.node.dependencies) {
        const entry = resolveTargetToEntry(depTarget);
        if (!entry || visited.has(entry.vaultPath)) continue;
        visited.add(entry.vaultPath);
        const child = this.toStructuralNode(entry);
        hits.push({
          vaultPath: child.vaultPath,
          entityId: child.entityId,
          title: child.title,
          depth: nextDepth,
          relationKind: 'dependency',
          viaPath: current.node.vaultPath,
        });
        queue.push({ node: child, depth: nextDepth });
      }
    }

    return hits;
  }

  /**
   * Scans the Vault on disk to detect stale, deleted, modified, or unindexed files.
   */
  async detectStaleEntries(): Promise<readonly StaleIndexEntry[]> {
    const indexedMap = new Map<string, IndexEntryRecord>();
    for (const entry of this.#db.listIndexEntries(undefined, 50_000)) {
      indexedMap.set(entry.vaultPath, entry);
    }

    const diskChecksums = new Map<string, string>();
    const walk = async (dirAbs: string): Promise<void> => {
      const entries = await readdir(dirAbs, { withFileTypes: true }).catch(() => []);
      for (const d of entries) {
        if (d.name.startsWith('.') || IGNORED_VAULT_DIRS.has(d.name)) continue;
        const abs = join(dirAbs, d.name);
        if (d.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!d.isFile()) continue;
        const rel = relative(this.#vault.vaultRoot, abs).split(sep).join('/');
        const check = validateVaultPath(this.#vault.vaultRoot, rel, { requireSectorPrefix: false });
        if (!check.ok) continue;

        const st = await stat(abs).catch(() => null);
        if (!st) continue;
        const raw = await readFile(abs);
        diskChecksums.set(check.normalizedPath, sha256Hex(raw));
      }
    };

    await walk(this.#vault.vaultRoot);

    const stale: StaleIndexEntry[] = [];
    for (const [vaultPath, entry] of indexedMap.entries()) {
      const diskSha = diskChecksums.get(vaultPath);
      if (!diskSha) {
        stale.push({
          vaultPath,
          reason: 'deleted_on_disk',
          indexedSha256: entry.sha256,
          diskSha256: null,
        });
      } else if (diskSha !== entry.sha256) {
        stale.push({
          vaultPath,
          reason: 'checksum_mismatch',
          indexedSha256: entry.sha256,
          diskSha256: diskSha,
        });
      }
    }

    for (const [diskPath, diskSha] of diskChecksums.entries()) {
      if (!indexedMap.has(diskPath)) {
        stale.push({
          vaultPath: diskPath,
          reason: 'unindexed_on_disk',
          indexedSha256: null,
          diskSha256: diskSha,
        });
      }
    }

    return stale;
  }

  /**
   * Reconciles external Obsidian edits, creations, deletions, and file renames against `index_state`.
   * The Vault on disk always wins over generated indexes.
   */
  async reconcileWithVault(): Promise<IndexReconciliationReport> {
    const beforeMap = new Map<string, IndexEntryRecord>();
    for (const entry of this.#db.listIndexEntries(undefined, 50_000)) {
      beforeMap.set(entry.vaultPath, entry);
    }

    const staleBefore = await this.detectStaleEntries();
    await this.#vault.scanVault({ full: true });

    const afterMap = new Map<string, IndexEntryRecord>();
    for (const entry of this.#db.listIndexEntries(undefined, 50_000)) {
      afterMap.set(entry.vaultPath, entry);
    }

    const rawCreated: string[] = [];
    const modified: string[] = [];
    const rawDeleted: string[] = [];

    for (const [path, afterEntry] of afterMap.entries()) {
      const beforeEntry = beforeMap.get(path);
      if (!beforeEntry) {
        rawCreated.push(path);
      } else if (beforeEntry.sha256 !== afterEntry.sha256) {
        modified.push(path);
      }
    }

    for (const path of beforeMap.keys()) {
      if (!afterMap.has(path)) {
        rawDeleted.push(path);
      }
    }

    // Detect renames by matching deleted entries to created entries via SHA-256 or stable entity ID
    const renamed: RenameDetection[] = [];
    const matchedCreated = new Set<string>();
    const matchedDeleted = new Set<string>();

    for (const delPath of rawDeleted) {
      const delEntry = beforeMap.get(delPath)!;
      const delEntityId = typeof delEntry.frontmatter.id === 'string' ? delEntry.frontmatter.id : null;

      for (const addPath of rawCreated) {
        if (matchedCreated.has(addPath)) continue;
        const addEntry = afterMap.get(addPath)!;
        const addEntityId = typeof addEntry.frontmatter.id === 'string' ? addEntry.frontmatter.id : null;

        if (
          delEntry.sha256 === addEntry.sha256 ||
          (delEntityId !== null && delEntityId === addEntityId)
        ) {
          renamed.push({
            fromPath: delPath,
            toPath: addPath,
            entityId: addEntityId ?? delEntityId,
            sha256: addEntry.sha256,
          });
          matchedDeleted.add(delPath);
          matchedCreated.add(addPath);
          break;
        }
      }
    }

    return {
      created: rawCreated.filter((p) => !matchedCreated.has(p)),
      modified,
      deleted: rawDeleted.filter((p) => !matchedDeleted.has(p)),
      renamed,
      staleCountBefore: staleBefore.length,
      totalIndexedAfter: afterMap.size,
    };
  }

  /**
   * Wipes `index_state` completely and rebuilds the entire structural index from the Obsidian Vault on disk.
   */
  async rebuildFromScratch(): Promise<{ readonly totalIndexed: number; readonly durationMs: number }> {
    this.#db.raw.exec('DELETE FROM index_state;');
    const summary = await this.#vault.scanVault({ full: true });
    return {
      totalIndexed: summary.indexedFiles,
      durationMs: summary.durationMs,
    };
  }
}

export const extractRelevantExcerpt = (
  text: string,
  terms: readonly string[],
  maxChars = 260,
): string => {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= maxChars) return clean;

  const lower = clean.toLowerCase();
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0) {
      const start = Math.max(0, idx - 60);
      const slice = clean.slice(start, start + maxChars).trim();
      return `${start > 0 ? '…' : ''}${slice}${start + maxChars < clean.length ? '…' : ''}`;
    }
  }

  return `${clean.slice(0, maxChars).trim()}…`;
};
