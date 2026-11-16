import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IndexEntryRecord, SqliteRuntimeDb } from '../sqlite/client.ts';
import type { VaultAuditLogger } from './audit.ts';
import { parseFrontmatterDocument } from './frontmatter.ts';
import { resolveVaultPath, type VaultSector } from './path-resolver.ts';
import { sha256Hex } from './revision.ts';
import type { VaultEngineConfig } from './vault-config.ts';
import type { VaultVersionManager } from './version-manager.ts';

export type ExternalVaultChange = {
  readonly vaultPath: string;
  readonly changeType: 'created' | 'modified' | 'deleted';
  readonly previousSha256: string | null;
  readonly newSha256: string | null;
};

/**
 * Monitors and reconciles external Obsidian edits on disk against the SQLite `index_state`
 * and `.vault-revisions/` history so external edits are detected, versioned, and audited.
 */
export class VaultWatcher {
  readonly #config: VaultEngineConfig;
  readonly #db: SqliteRuntimeDb;
  readonly #versions: VaultVersionManager;
  readonly #audit: VaultAuditLogger;
  readonly #indexSingleFile: (
    vaultPath: string,
    absPath: string,
    sector: VaultSector | 'ROOT_KB',
    ext: string,
  ) => Promise<IndexEntryRecord>;
  #fsWatcher: FSWatcher | null = null;

  constructor(options: {
    readonly config: VaultEngineConfig;
    readonly db: SqliteRuntimeDb;
    readonly versions: VaultVersionManager;
    readonly audit: VaultAuditLogger;
    readonly indexSingleFile: (
      vaultPath: string,
      absPath: string,
      sector: VaultSector | 'ROOT_KB',
      ext: string,
    ) => Promise<IndexEntryRecord>;
  }) {
    this.#config = options.config;
    this.#db = options.db;
    this.#versions = options.versions;
    this.#audit = options.audit;
    this.#indexSingleFile = options.indexSingleFile;
  }

  /**
   * Checks a specific vault path on disk to detect whether Obsidian or an external editor
   * modified, created, or deleted it since `index_state` last recorded it.
   */
  async reconcilePath(relPath: string): Promise<ExternalVaultChange | null> {
    const resolved = await resolveVaultPath(this.#config, relPath, { requireSectorPrefix: false });
    const indexed = this.#db.getIndexEntry(resolved.normalizedPath);
    const st = await stat(resolved.absPath).catch(() => null);

    if (!st) {
      if (!indexed) return null;
      this.#db.removeIndexEntry(resolved.normalizedPath);
      this.#audit.record({
        actor: 'obsidian-external',
        operation: 'update',
        filePath: resolved.normalizedPath,
        previousChecksum: indexed.sha256,
        newChecksum: null,
        reason: 'External deletion detected on disk',
        result: 'success',
      });
      return {
        vaultPath: resolved.normalizedPath,
        changeType: 'deleted',
        previousSha256: indexed.sha256,
        newSha256: null,
      };
    }

    const raw = await readFile(resolved.absPath, 'utf8');
    const diskSha256 = sha256Hex(raw);
    if (indexed && indexed.sha256 === diskSha256) {
      return null;
    }

    const parsed = parseFrontmatterDocument(raw, { strict: false });
    const entityId =
      typeof parsed.rawFrontmatter.id === 'string'
        ? parsed.rawFrontmatter.id
        : typeof parsed.rawFrontmatter.id === 'number'
          ? String(parsed.rawFrontmatter.id)
          : null;

    await this.#versions.recordVersion({
      vaultPath: resolved.normalizedPath,
      entityId,
      content: raw,
      previousSha256: indexed?.sha256 ?? null,
      actor: 'obsidian-external',
      operation: 'external-sync',
      reason: indexed ? 'External Obsidian modification synced' : 'External Obsidian file creation synced',
    });

    await this.#indexSingleFile(
      resolved.normalizedPath,
      resolved.absPath,
      resolved.sector,
      resolved.ext,
    );

    this.#audit.record({
      actor: 'obsidian-external',
      operation: 'update',
      entityId,
      filePath: resolved.normalizedPath,
      previousChecksum: indexed?.sha256 ?? null,
      newChecksum: diskSha256,
      reason: indexed ? 'External Obsidian modification synced' : 'External Obsidian file creation synced',
      result: 'success',
    });

    return {
      vaultPath: resolved.normalizedPath,
      changeType: indexed ? 'modified' : 'created',
      previousSha256: indexed?.sha256 ?? null,
      newSha256: diskSha256,
    };
  }

  startWatching(onChange?: (change: ExternalVaultChange) => void): void {
    if (this.#fsWatcher) return;
    try {
      this.#fsWatcher = watch(this.#config.vaultRoot, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const norm = filename.replace(/\\/g, '/');
        if (
          norm.startsWith('.') ||
          norm.includes('/.') ||
          norm.includes('.tmp-') ||
          norm.startsWith('_attachments/')
        ) {
          return;
        }
        void this.reconcilePath(norm)
          .then((change) => {
            if (change && onChange) onChange(change);
          })
          .catch(() => undefined);
      });
    } catch {
      // Recursive fs.watch fallback if unsupported on a specific mount
    }
  }

  stopWatching(): void {
    if (this.#fsWatcher) {
      this.#fsWatcher.close();
      this.#fsWatcher = null;
    }
  }
}
