import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { VaultNotFoundError } from './errors.ts';
import { VaultRevisionStore, sha256Hex, writeFileAtomic, type RevisionMetadata } from './revision.ts';

export type VaultVersionEntry = {
  readonly revisionNumber: number;
  readonly sha256: string;
  readonly previousSha256: string | null;
  readonly entityId: string | null;
  readonly vaultPath: string;
  readonly actor: string;
  readonly operation: 'write' | 'update' | 'append' | 'promote' | 'restore' | 'external-sync';
  readonly reason: string;
  readonly byteSize: number;
  readonly createdAt: string;
};

export type VaultSnapshotManifest = {
  readonly snapshotId: string;
  readonly label: string;
  readonly actor: string;
  readonly createdAt: string;
  readonly totalFiles: number;
  readonly manifestSha256: string;
  readonly files: ReadonlyArray<{
    readonly vaultPath: string;
    readonly sha256: string;
    readonly byteSize: number;
    readonly sector: string;
  }>;
};

/**
 * Manages immutable content-addressed blobs AND ordered per-file revision histories
 * plus Vault-wide point-in-time snapshots inside `<vaultRoot>/.vault-revisions/`.
 */
export class VaultVersionManager {
  readonly #vaultRoot: string;
  readonly #revisions: VaultRevisionStore;
  readonly #historyDir: string;
  readonly #snapshotsDir: string;

  constructor(vaultRoot: string, revisionStore?: VaultRevisionStore) {
    this.#vaultRoot = resolve(vaultRoot);
    this.#revisions = revisionStore ?? new VaultRevisionStore(this.#vaultRoot);
    this.#historyDir = join(this.#revisions.revisionsRoot, 'history');
    this.#snapshotsDir = join(this.#revisions.revisionsRoot, 'snapshots');
  }

  get revisionStore(): VaultRevisionStore {
    return this.#revisions;
  }

  #historyLogPath(vaultPath: string): string {
    const pathHash = sha256Hex(vaultPath);
    return join(this.#historyDir, pathHash.slice(0, 2), `${pathHash}.jsonl`);
  }

  async recordVersion(input: {
    readonly vaultPath: string;
    readonly entityId?: string | null | undefined;
    readonly content: string | Uint8Array;
    readonly previousSha256: string | null;
    readonly actor: string;
    readonly operation: VaultVersionEntry['operation'];
    readonly reason: string;
  }): Promise<VaultVersionEntry> {
    const revMeta: RevisionMetadata = await this.#revisions.recordRevision({
      vaultPath: input.vaultPath,
      content: input.content,
      previousSha256: input.previousSha256,
      actor: input.actor,
    });

    const existingHistory = await this.getHistory(input.vaultPath);
    const revisionNumber = existingHistory.length + 1;

    const entry: VaultVersionEntry = {
      revisionNumber,
      sha256: revMeta.sha256,
      previousSha256: input.previousSha256,
      entityId: input.entityId ?? null,
      vaultPath: input.vaultPath,
      actor: input.actor,
      operation: input.operation,
      reason: input.reason,
      byteSize: revMeta.byteSize,
      createdAt: revMeta.createdAt,
    };

    const logPath = this.#historyLogPath(input.vaultPath);
    const existingRaw = await readFile(logPath, 'utf8').catch(() => '');
    const updatedRaw = `${existingRaw}${JSON.stringify(entry)}\n`;
    await writeFileAtomic(logPath, updatedRaw);

    return entry;
  }

  async getHistory(vaultPath: string): Promise<readonly VaultVersionEntry[]> {
    const logPath = this.#historyLogPath(vaultPath);
    const raw = await readFile(logPath, 'utf8').catch(() => null);
    if (!raw) return [];

    const entries: VaultVersionEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as VaultVersionEntry);
      } catch {
        // Ignore malformed tail line if any
      }
    }
    return entries;
  }

  async readRevisionContent(sha256: string, vaultPath?: string): Promise<string> {
    const text = await this.#revisions.readRevisionText(sha256);
    if (text === null) {
      throw new VaultNotFoundError(
        'REVISION_NOT_FOUND',
        `Revision blob "${sha256}" not found in .vault-revisions/`,
        { vaultPath, details: { sha256 } },
      );
    }
    return text;
  }

  async createSnapshot(input: {
    readonly label: string;
    readonly actor: string;
    readonly files: ReadonlyArray<{
      readonly vaultPath: string;
      readonly sha256: string;
      readonly byteSize: number;
      readonly sector: string;
    }>;
  }): Promise<VaultSnapshotManifest> {
    await mkdir(this.#snapshotsDir, { recursive: true });
    const snapshotId = `snap-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const sortedFiles = [...input.files].sort((a, b) => a.vaultPath.localeCompare(b.vaultPath));
    const manifestSha256 = sha256Hex(JSON.stringify(sortedFiles));

    const manifest: VaultSnapshotManifest = {
      snapshotId,
      label: input.label.trim() || 'vault-snapshot',
      actor: input.actor,
      createdAt: new Date().toISOString(),
      totalFiles: sortedFiles.length,
      manifestSha256,
      files: sortedFiles,
    };

    const snapPath = join(this.#snapshotsDir, `${snapshotId}.json`);
    await writeFileAtomic(snapPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }
}
