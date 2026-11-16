import { readFile, rm, stat } from 'node:fs/promises';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import { VaultConflictError } from './errors.ts';
import { sha256Hex, writeFileAtomic } from './revision.ts';
import type { VaultVersionManager } from './version-manager.ts';

export type DiskStateInspection = {
  readonly existsOnDisk: boolean;
  readonly diskContent: string | null;
  readonly diskSha256: string | null;
  readonly indexedSha256: string | null;
  readonly externalEditDetected: boolean;
};

/**
 * Coordinates per-path optimistic/pessimistic locks, detects external Obsidian edits,
 * and supports atomic multi-file transactions with rollback.
 */
export class VaultTransactionManager {
  readonly #db: SqliteRuntimeDb | null;
  readonly #versions: VaultVersionManager;
  readonly #inProcessLocks = new Set<string>();

  constructor(db: SqliteRuntimeDb | null | undefined, versions: VaultVersionManager) {
    this.#db = db ?? null;
    this.#versions = versions;
  }

  #isDbReady(): boolean {
    return Boolean(this.#db && this.#db.isOpen);
  }

  /**
   * Acquires both an in-process lock and a SQLite `locks` row (when SQLite is available) for `vaultPath`,
   * throwing `VaultConflictError('LOCK_BUSY')` on contention.
   */
  async withPathLock<T>(
    vaultPath: string,
    actor: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lockKey = `vault:${vaultPath}`;
    const dbReady = this.#isDbReady();
    if (
      this.#inProcessLocks.has(lockKey) ||
      (dbReady && this.#db && !this.#db.acquireLock(lockKey, actor, ttlMs))
    ) {
      throw new VaultConflictError('LOCK_BUSY', `Vault lock busy for "${vaultPath}"`, {
        vaultPath,
        details: { actor },
      });
    }

    this.#inProcessLocks.add(lockKey);
    try {
      return await fn();
    } finally {
      this.#inProcessLocks.delete(lockKey);
      if (this.#isDbReady() && this.#db) {
        try {
          this.#db.releaseLock(lockKey, actor);
        } catch {
          // Ignore if SQLite closed during operation
        }
      }
    }
  }

  /**
   * Inspects the on-disk file against `index_state` and optional `expectedSha256`.
   * If the file was modified on disk outside `VaultEngine` (e.g. in Obsidian),
   * archives the external version in `.vault-revisions/` so user edits are never lost,
   * and throws `EXTERNAL_OBSIDIAN_EDIT` when optimistic concurrency (`expectedSha256`) fails.
   */
  async inspectAndGuardDiskState(input: {
    readonly vaultPath: string;
    readonly absPath: string;
    readonly expectedSha256?: string | undefined;
  }): Promise<DiskStateInspection> {
    const st = await stat(input.absPath).catch(() => null);
    if (!st) {
      return {
        existsOnDisk: false,
        diskContent: null,
        diskSha256: null,
        indexedSha256: null,
        externalEditDetected: false,
      };
    }

    const diskContent = await readFile(input.absPath, 'utf8');
    const diskSha256 = sha256Hex(diskContent);
    const indexed =
      this.#isDbReady() && this.#db
        ? (() => {
            try {
              return this.#db.getIndexEntry(input.vaultPath);
            } catch {
              return null;
            }
          })()
        : null;
    const indexedSha256 = indexed?.sha256 ?? null;

    const externalEditDetected = indexedSha256 !== null && indexedSha256 !== diskSha256;
    if (externalEditDetected) {
      // Preserve the external Obsidian edit in version history before doing anything else
      await this.#versions.recordVersion({
        vaultPath: input.vaultPath,
        entityId: typeof indexed?.frontmatter.id === 'string' ? indexed.frontmatter.id : null,
        content: diskContent,
        previousSha256: indexedSha256,
        actor: 'obsidian-external',
        operation: 'external-sync',
        reason: 'Detected external file modification on disk outside VaultEngine',
      });
    }

    if (input.expectedSha256 !== undefined) {
      if (diskSha256 !== input.expectedSha256) {
        if (externalEditDetected && input.expectedSha256 === indexedSha256) {
          throw new VaultConflictError(
            'EXTERNAL_OBSIDIAN_EDIT',
            `External Obsidian edit detected on "${input.vaultPath}": expected ${input.expectedSha256}, found on-disk ${diskSha256}`,
            {
              vaultPath: input.vaultPath,
              details: {
                expectedSha256: input.expectedSha256,
                indexedSha256,
                actualSha256: diskSha256,
              },
            },
          );
        }

        throw new VaultConflictError(
          'CHECKSUM_MISMATCH',
          `VaultEngine conflict detected on "${input.vaultPath}": expected SHA-256 ${input.expectedSha256}, found ${diskSha256}. Refusing to overwrite user data.`,
          {
            vaultPath: input.vaultPath,
            details: {
              expectedSha256: input.expectedSha256,
              actualSha256: diskSha256,
            },
          },
        );
      }
    }

    return {
      existsOnDisk: true,
      diskContent,
      diskSha256,
      indexedSha256,
      externalEditDetected,
    };
  }

  /**
   * Executes a multi-file batch atomically with rollback if any file write fails.
   */
  async executeAtomicBatch(
    items: ReadonlyArray<{
      readonly vaultPath: string;
      readonly absPath: string;
      readonly content: string;
    }>,
    actor: string,
    ttlMs = 15_000,
  ): Promise<void> {
    const acquiredKeys: string[] = [];
    const backups: {
      readonly absPath: string;
      readonly existed: boolean;
      readonly previousContent: string | null;
    }[] = [];

    try {
      for (const item of items) {
        const key = `vault:${item.vaultPath}`;
        if (
          this.#inProcessLocks.has(key) ||
          (this.#isDbReady() && this.#db && !this.#db.acquireLock(key, actor, ttlMs))
        ) {
          throw new VaultConflictError('LOCK_BUSY', `Vault lock busy for "${item.vaultPath}"`, {
            vaultPath: item.vaultPath,
          });
        }
        this.#inProcessLocks.add(key);
        acquiredKeys.push(key);
      }

      for (const item of items) {
        const prev = await readFile(item.absPath, 'utf8').catch(() => null);
        backups.push({
          absPath: item.absPath,
          existed: prev !== null,
          previousContent: prev,
        });
      }

      for (const item of items) {
        await writeFileAtomic(item.absPath, item.content);
      }
    } catch (err) {
      // Rollback any already-written files in reverse order
      for (const b of backups.reverse()) {
        try {
          if (b.existed && b.previousContent !== null) {
            await writeFileAtomic(b.absPath, b.previousContent);
          } else if (!b.existed) {
            await rm(b.absPath, { force: true });
          }
        } catch {
          // Best-effort rollback
        }
      }
      throw err;
    } finally {
      for (const key of acquiredKeys) {
        this.#inProcessLocks.delete(key);
        if (this.#isDbReady() && this.#db) {
          try {
            this.#db.releaseLock(key, actor);
          } catch {
            // Ignore if SQLite closed
          }
        }
      }
    }
  }
}
