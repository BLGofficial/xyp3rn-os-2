import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { parseObsidianNote } from '../../knowledge/obsidian/parser.ts';
import type { IndexEntryRecord, SqliteRuntimeDb } from '../sqlite/client.ts';
import { VaultAuditLogger, type VaultAuditRecord } from './audit.ts';
import {
  VaultConflictError,
  VaultEngineError,
  VaultNotFoundError,
  VaultPathSecurityError,
  VaultPermissionError,
  VaultValidationError,
} from './errors.ts';
import {
  appendWikilinkToContent,
  resolveNoteLinks,
  targetExistsInIndex,
  type VaultLinkResolution,
} from './links.ts';
import {
  IGNORED_VAULT_DIRS,
  validateVaultPath,
  type VaultSector,
} from './path-guard.ts';
import { resolveVaultPath } from './path-resolver.ts';
import { VaultPromotionGate, type PromoteToCanonicalRequest } from './promotion-gate.ts';
import {
  listVaultEntries,
  readVaultMetadata,
  readVaultNote,
  type ListVaultOptions,
  type VaultNoteDocument,
  type VaultNoteMetadata,
} from './reader.ts';
import { VaultRevisionStore, sha256Hex, writeFileAtomic } from './revision.ts';
import {
  validateEntityContent,
  type EntityValidationResult,
  type ValidateEntityOptions,
} from './schema-validator.ts';
import { searchVaultIndex, type VaultSearchOptions } from './search.ts';
import { VaultTransactionManager } from './transaction-manager.ts';
import {
  createVaultConfig,
  type VaultEngineConfig,
  type VaultEngineConfigInput,
} from './vault-config.ts';
import {
  VaultVersionManager,
  type VaultSnapshotManifest,
  type VaultVersionEntry,
} from './version-manager.ts';
import { VaultWatcher, type ExternalVaultChange } from './watcher.ts';
import {
  executeControlledAppend,
  executeControlledUpdate,
  executeControlledWrite,
  type AppendNoteRequest,
  type UpdateNoteRequest,
  type WriteNoteRequest,
  type WriteNoteResult,
  type WriterContext,
} from './writer.ts';

export type VaultScanSummary = {
  readonly scannedFiles: number;
  readonly indexedFiles: number;
  readonly unchangedFiles: number;
  readonly removedFiles: number;
  readonly errors: readonly { readonly path: string; readonly error: string }[];
  readonly durationMs: number;
};

export type LinkNotesRequest = {
  readonly sourceVaultPath: string;
  readonly targetVaultPath: string;
  readonly actor: string;
  readonly alias?: string | undefined;
  readonly section?: string | undefined;
  readonly relationLabel?: string | undefined;
  readonly expectedSha256?: string | undefined;
};

export type LinkNotesResult = {
  readonly sourceVaultPath: string;
  readonly targetVaultPath: string;
  readonly wikilinkSyntax: string;
  readonly alreadyLinked: boolean;
  readonly sha256: string;
  readonly revisionNumber: number;
};

export type RestoreRevisionRequest = {
  readonly vaultPath: string;
  readonly targetSha256: string;
  readonly actor: string;
  readonly reason?: string | undefined;
};

const deriveTitle = (vaultPath: string, frontmatter: Record<string, unknown>, body: string): string => {
  if (typeof frontmatter.title === 'string' && frontmatter.title.trim()) {
    return frontmatter.title.trim();
  }
  const headingMatch = /^#\s+(.+)$/m.exec(body);
  if (headingMatch?.[1]?.trim()) {
    return headingMatch[1].trim();
  }
  const base = basename(vaultPath);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
};

/**
 * Production-grade XYP3RN OS 3.0 Vault Engine.
 * Implements all 13 contract operations (`read`, `readMetadata`, `list`, `search`,
 * `write`, `update`, `append`, `validate`, `link`, `backlinks`, `history`, `promote`, `snapshot`)
 * plus `restore()`, `scanVault()`, and `reconcileExternalChanges()`.
 */
export class VaultEngine {
  readonly #config: VaultEngineConfig;
  readonly #db: SqliteRuntimeDb;
  readonly #revisions: VaultRevisionStore;
  readonly #versions: VaultVersionManager;
  readonly #transactions: VaultTransactionManager;
  readonly #audit: VaultAuditLogger;
  readonly #promotionGate: VaultPromotionGate;
  readonly #watcher: VaultWatcher;

  constructor(
    options: VaultEngineConfigInput & {
      readonly vaultRoot: string;
      readonly db: SqliteRuntimeDb;
    },
  ) {
    this.#config = createVaultConfig(options);
    this.#db = options.db;
    this.#revisions = new VaultRevisionStore(this.#config.vaultRoot);
    this.#versions = new VaultVersionManager(this.#config.vaultRoot, this.#revisions);
    this.#transactions = new VaultTransactionManager(this.#db, this.#versions);
    this.#audit = new VaultAuditLogger(this.#db);

    const writerCtx = this.#writerContext();
    this.#promotionGate = new VaultPromotionGate(writerCtx);
    this.#watcher = new VaultWatcher({
      config: this.#config,
      db: this.#db,
      versions: this.#versions,
      audit: this.#audit,
      indexSingleFile: writerCtx.indexSingleFile,
    });
  }

  get vaultRoot(): string {
    return this.#config.vaultRoot;
  }

  get config(): VaultEngineConfig {
    return this.#config;
  }

  get revisions(): VaultRevisionStore {
    return this.#revisions;
  }

  get versions(): VaultVersionManager {
    return this.#versions;
  }

  get audit(): VaultAuditLogger {
    return this.#audit;
  }

  get watcher(): VaultWatcher {
    return this.#watcher;
  }

  #writerContext(): WriterContext {
    return {
      config: this.#config,
      db: this.#db,
      versions: this.#versions,
      transactions: this.#transactions,
      audit: this.#audit,
      indexSingleFile: (vp, abs, sec, ext) => this.#indexSingleFile(vp, abs, sec, ext),
    };
  }

  // ─── 1. read() & readNote() ─────────────────────────────────────────────────

  async read(relPath: string, actor = 'system'): Promise<VaultNoteDocument> {
    return readVaultNote(this.#config, relPath, { audit: this.#audit, actor });
  }

  async readNote(relPath: string, actor = 'system'): Promise<VaultNoteDocument> {
    return this.read(relPath, actor);
  }

  // ─── 2. readMetadata() ──────────────────────────────────────────────────────

  async readMetadata(relPath: string, actor = 'system'): Promise<VaultNoteMetadata> {
    return readVaultMetadata(this.#config, relPath, { audit: this.#audit, actor });
  }

  // ─── 3. list() ──────────────────────────────────────────────────────────────

  list(options: ListVaultOptions = {}): readonly IndexEntryRecord[] {
    return listVaultEntries(this.#db, options);
  }

  // ─── 4. search() ────────────────────────────────────────────────────────────

  search(query: string, options: VaultSearchOptions = {}): readonly IndexEntryRecord[] {
    return searchVaultIndex(this.#db, query, options);
  }

  // ─── 5. write() & writeNote() ───────────────────────────────────────────────

  async write(req: WriteNoteRequest): Promise<WriteNoteResult> {
    return executeControlledWrite(this.#writerContext(), req);
  }

  async writeNote(req: WriteNoteRequest): Promise<WriteNoteResult> {
    return this.write(req);
  }

  // ─── 6. update() ────────────────────────────────────────────────────────────

  async update(req: UpdateNoteRequest): Promise<WriteNoteResult> {
    return executeControlledUpdate(this.#writerContext(), req);
  }

  // ─── 7. append() & appendNote() ─────────────────────────────────────────────

  async append(req: AppendNoteRequest): Promise<WriteNoteResult> {
    return executeControlledAppend(this.#writerContext(), req);
  }

  async appendNote(req: AppendNoteRequest): Promise<WriteNoteResult> {
    return this.append(req);
  }

  // ─── 8. validate() ──────────────────────────────────────────────────────────

  async validate(
    vaultPath: string,
    options: ValidateEntityOptions & { readonly content?: string | undefined; readonly actor?: string | undefined } = {},
  ): Promise<EntityValidationResult> {
    const resolved = await resolveVaultPath(this.#config, vaultPath, { requireSectorPrefix: false });
    const rawContent =
      options.content !== undefined ? options.content : await readFile(resolved.absPath, 'utf8');

    const res = validateEntityContent(resolved.normalizedPath, rawContent, {
      requireSchema: options.requireSchema ?? true,
      checkReferences: options.checkReferences ?? false,
      targetExists: options.targetExists ?? ((target) => targetExistsInIndex(this.#db, target)),
    });

    this.#audit.record({
      actor: options.actor ?? 'system',
      operation: 'validate',
      entityId: res.entityId,
      filePath: resolved.normalizedPath,
      newChecksum: res.sha256,
      reason: res.ok ? 'Entity validation passed' : `Entity validation failed: ${res.issues.map((i) => i.code).join(', ')}`,
      result: res.ok ? 'success' : 'invalid',
    });

    return res;
  }

  // ─── 9. link() ──────────────────────────────────────────────────────────────

  async link(req: LinkNotesRequest): Promise<LinkNotesResult> {
    const srcResolved = await resolveVaultPath(this.#config, req.sourceVaultPath, {
      requireSectorPrefix: true,
      requireWritableSector: true,
    });
    const dstResolved = await resolveVaultPath(this.#config, req.targetVaultPath, {
      requireSectorPrefix: false,
    });

    const dstStat = await stat(dstResolved.absPath).catch(() => null);
    if (!dstStat && !targetExistsInIndex(this.#db, dstResolved.normalizedPath)) {
      throw new VaultValidationError(
        'BROKEN_REFERENCE',
        `Cannot link "${srcResolved.normalizedPath}" to non-existent target "${dstResolved.normalizedPath}"`,
        { vaultPath: srcResolved.normalizedPath, details: { targetVaultPath: dstResolved.normalizedPath } },
      );
    }

    const srcDoc = await this.read(srcResolved.normalizedPath, req.actor);
    const expectedSha = req.expectedSha256 ?? srcDoc.sha256;

    const { updatedContent, wikilinkSyntax, alreadyLinked } = appendWikilinkToContent(
      srcDoc.rawContent,
      dstResolved.normalizedPath,
      {
        alias: req.alias,
        section: req.section,
        relationLabel: req.relationLabel,
      },
    );

    if (alreadyLinked) {
      return {
        sourceVaultPath: srcResolved.normalizedPath,
        targetVaultPath: dstResolved.normalizedPath,
        wikilinkSyntax,
        alreadyLinked: true,
        sha256: srcDoc.sha256,
        revisionNumber: (await this.history(srcResolved.normalizedPath)).length,
      };
    }

    const writeRes = await this.update({
      vaultPath: srcResolved.normalizedPath,
      content: updatedContent,
      actor: req.actor,
      expectedSha256: expectedSha,
      reason: `Linked to ${dstResolved.normalizedPath}`,
    });

    this.#audit.record({
      actor: req.actor,
      operation: 'link',
      entityId: typeof srcDoc.frontmatter.id === 'string' ? srcDoc.frontmatter.id : null,
      filePath: srcResolved.normalizedPath,
      previousChecksum: expectedSha,
      newChecksum: writeRes.sha256,
      reason: `Created link ${wikilinkSyntax}`,
      result: 'success',
    });

    return {
      sourceVaultPath: srcResolved.normalizedPath,
      targetVaultPath: dstResolved.normalizedPath,
      wikilinkSyntax,
      alreadyLinked: false,
      sha256: writeRes.sha256,
      revisionNumber: writeRes.revisionNumber,
    };
  }

  // ─── 10. backlinks() & resolveLinks() ───────────────────────────────────────

  backlinks(vaultPath: string): readonly string[] {
    return resolveNoteLinks(this.#db, vaultPath).backlinks;
  }

  resolveLinks(vaultPath: string): {
    readonly outgoing: readonly string[];
    readonly backlinks: readonly string[];
  } {
    const resolved: VaultLinkResolution = resolveNoteLinks(this.#db, vaultPath);
    return {
      outgoing: resolved.outgoingTargets,
      backlinks: resolved.backlinks,
    };
  }

  // ─── 11. history() & restore() ──────────────────────────────────────────────

  async history(vaultPath: string): Promise<readonly VaultVersionEntry[]> {
    const resolved = await resolveVaultPath(this.#config, vaultPath, { requireSectorPrefix: false });
    return this.#versions.getHistory(resolved.normalizedPath);
  }

  async restore(req: RestoreRevisionRequest): Promise<WriteNoteResult> {
    const check = await resolveVaultPath(this.#config, req.vaultPath, {
      requireSectorPrefix: true,
      requireWritableSector: true,
    });
    if (check.isCanonical) {
      throw new VaultPermissionError(
        'CANONICAL_WRITE_FORBIDDEN',
        `Direct restore into canonical path "${check.normalizedPath}" is forbidden without Promotion Gate`,
        { vaultPath: check.normalizedPath },
      );
    }

    const targetContent = await this.#versions.readRevisionContent(req.targetSha256, check.normalizedPath);

    return this.#transactions.withPathLock(
      check.normalizedPath,
      req.actor,
      this.#config.lockTtlMs,
      async () => {
        const diskState = await this.#transactions.inspectAndGuardDiskState({
          vaultPath: check.normalizedPath,
          absPath: check.absPath,
        });

        await writeFileAtomic(check.absPath, targetContent);
        const parsed = parseObsidianNote(targetContent);
        const entityId =
          typeof parsed.frontmatter.id === 'string'
            ? parsed.frontmatter.id
            : typeof parsed.frontmatter.id === 'number'
              ? String(parsed.frontmatter.id)
              : null;

        const versionEntry = await this.#versions.recordVersion({
          vaultPath: check.normalizedPath,
          entityId,
          content: targetContent,
          previousSha256: diskState.diskSha256,
          actor: req.actor,
          operation: 'restore',
          reason: req.reason ?? `Restored to revision ${req.targetSha256.slice(0, 12)}`,
        });

        await this.#indexSingleFile(check.normalizedPath, check.absPath, check.sector, check.ext);

        this.#audit.record({
          actor: req.actor,
          operation: 'restore',
          entityId,
          filePath: check.normalizedPath,
          previousChecksum: diskState.diskSha256,
          newChecksum: versionEntry.sha256,
          reason: req.reason ?? `Restored to revision ${req.targetSha256.slice(0, 12)}`,
          result: 'success',
        });

        return {
          vaultPath: check.normalizedPath,
          sha256: versionEntry.sha256,
          previousSha256: diskState.diskSha256,
          createdCopy: false,
          byteSize: versionEntry.byteSize,
          revisionNumber: versionEntry.revisionNumber,
        };
      },
    );
  }

  // ─── 12. promote() & promoteToCanonical() ───────────────────────────────────

  async promote(req: PromoteToCanonicalRequest): Promise<WriteNoteResult> {
    return this.#promotionGate.promote(req);
  }

  async promoteToCanonical(req: PromoteToCanonicalRequest): Promise<WriteNoteResult> {
    return this.promote(req);
  }

  // ─── 13. snapshot() ─────────────────────────────────────────────────────────

  async snapshot(label = 'manual', actor = 'system'): Promise<VaultSnapshotManifest> {
    const entries = this.#db.listIndexEntries(undefined, 50_000);
    const snap = await this.#versions.createSnapshot({
      label,
      actor,
      files: entries.map((e) => ({
        vaultPath: e.vaultPath,
        sha256: e.sha256,
        byteSize: e.byteSize,
        sector: e.sector,
      })),
    });

    this.#audit.record({
      actor,
      operation: 'snapshot',
      filePath: `.vault-revisions/snapshots/${snap.snapshotId}.json`,
      newChecksum: snap.manifestSha256,
      reason: `Created Vault snapshot "${label}" (${snap.totalFiles} files)`,
      result: 'success',
    });

    return snap;
  }

  // ─── External Edit Reconciliation & Structural Scanner ──────────────────────

  async reconcileExternalEdit(vaultPath: string): Promise<ExternalVaultChange | null> {
    return this.#watcher.reconcilePath(vaultPath);
  }

  listAuditLog(filter?: Parameters<VaultAuditLogger['list']>[0]): readonly VaultAuditRecord[] {
    return this.#audit.list(filter);
  }

  async scanVault(options: { readonly full?: boolean | undefined } = {}): Promise<VaultScanSummary> {
    const startMs = Date.now();
    const forceFull = options.full ?? false;

    const existingEntries = new Map<string, { readonly byteSize: number; readonly mtimeMs: number }>();
    const rawRows = this.#db.raw
      .prepare('SELECT vault_path, byte_size, mtime_ms FROM index_state')
      .all() as { vault_path: string; byte_size: number; mtime_ms: number }[];
    for (const r of rawRows) {
      existingEntries.set(r.vault_path, { byteSize: Number(r.byte_size), mtimeMs: Number(r.mtime_ms) });
    }

    const seenPaths = new Set<string>();
    const errors: { readonly path: string; readonly error: string }[] = [];
    const toIndex: {
      readonly normalizedPath: string;
      readonly abs: string;
      readonly sector: VaultSector | 'ROOT_KB';
      readonly ext: string;
      readonly st: { readonly size: number; readonly mtimeMs: number };
    }[] = [];
    let scannedFiles = 0;
    let indexedFiles = 0;
    let unchangedFiles = 0;

    const walk = async (dirAbs: string): Promise<void> => {
      const entries = await readdir(dirAbs, { withFileTypes: true });
      for (const d of entries) {
        if (d.name.startsWith('.') || IGNORED_VAULT_DIRS.has(d.name)) {
          continue;
        }
        const abs = join(dirAbs, d.name);
        if (d.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!d.isFile()) continue;

        const rel = relative(this.#config.vaultRoot, abs).split(sep).join('/');
        const check = validateVaultPath(this.#config.vaultRoot, rel, { requireSectorPrefix: false });
        if (!check.ok) continue;

        scannedFiles += 1;
        seenPaths.add(check.normalizedPath);

        try {
          const st = await stat(abs);
          const mtimeMs = Math.trunc(st.mtimeMs);
          const prev = existingEntries.get(check.normalizedPath);

          if (!forceFull && prev && prev.byteSize === st.size && prev.mtimeMs === mtimeMs) {
            unchangedFiles += 1;
            continue;
          }

          toIndex.push({
            normalizedPath: check.normalizedPath,
            abs,
            sector: check.sector,
            ext: check.ext,
            st: { size: st.size, mtimeMs },
          });
        } catch (err) {
          errors.push({ path: check.normalizedPath, error: (err as Error).message });
        }
      }
    };

    await walk(this.#config.vaultRoot);

    const BATCH_SIZE = 400;
    for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
      const batch = toIndex.slice(i, i + BATCH_SIZE);
      this.#db.raw.exec('BEGIN IMMEDIATE;');
      try {
        for (const item of batch) {
          try {
            await this.#indexSingleFile(item.normalizedPath, item.abs, item.sector, item.ext, item.st);
            indexedFiles += 1;
          } catch (err) {
            errors.push({ path: item.normalizedPath, error: (err as Error).message });
          }
        }
        this.#db.raw.exec('COMMIT;');
      } catch (txErr) {
        this.#db.raw.exec('ROLLBACK;');
        throw txErr;
      }
    }

    let removedFiles = 0;
    const toRemove = [...existingEntries.keys()].filter((oldPath) => !seenPaths.has(oldPath));
    if (toRemove.length > 0) {
      this.#db.raw.exec('BEGIN IMMEDIATE;');
      try {
        for (const oldPath of toRemove) {
          this.#db.removeIndexEntry(oldPath);
          removedFiles += 1;
        }
        this.#db.raw.exec('COMMIT;');
      } catch (txErr) {
        this.#db.raw.exec('ROLLBACK;');
        throw txErr;
      }
    }

    const durationMs = Date.now() - startMs;
    const summary: VaultScanSummary = {
      scannedFiles,
      indexedFiles,
      unchangedFiles,
      removedFiles,
      errors,
      durationMs,
    };

    this.#db.setIndexMeta('last_scan', {
      ...summary,
      completedAt: new Date().toISOString(),
    });

    return summary;
  }

  async #indexSingleFile(
    vaultPath: string,
    absPath: string,
    sector: VaultSector | 'ROOT_KB',
    ext: string,
    preStat?: { readonly size: number; readonly mtimeMs: number },
  ): Promise<IndexEntryRecord> {
    const st = preStat ?? (await stat(absPath));
    const mtimeMs = Math.trunc(st.mtimeMs);

    if ((ext === '.md' || ext === '.yaml' || ext === '.yml') && st.size <= this.#config.maxParseBytes) {
      const raw = await readFile(absPath, 'utf8');
      const parsed = parseObsidianNote(raw);
      const fm = parsed.frontmatter as Record<string, unknown>;
      const title = deriveTitle(vaultPath, fm, parsed.body);
      const entryInput = {
        vaultPath,
        sector,
        fileExt: ext,
        byteSize: st.size,
        mtimeMs,
        sha256: parsed.sha256,
        title,
        domain: typeof fm.domain === 'string' ? fm.domain : sector,
        docType: typeof fm.type === 'string' ? fm.type : null,
        status: typeof fm.status === 'string' ? fm.status : null,
        tags: parsed.frontmatter.tags,
        wikilinks: parsed.wikilinks,
        frontmatter: fm,
        frontmatterError: parsed.frontmatterError,
      };
      if (this.#db.isOpen) {
        try {
          return this.#db.upsertIndexEntry(entryInput);
        } catch {
          // Fall through to non-persisted entry when SQLite is unavailable
        }
      }
      return { ...entryInput, indexedAt: new Date().toISOString() };
    }

    const bytes =
      st.size <= this.#config.maxParseBytes
        ? await readFile(absPath)
        : Buffer.from(`${vaultPath}:${st.size}:${mtimeMs}`);
    const sha256 = sha256Hex(bytes);
    const binaryInput = {
      vaultPath,
      sector,
      fileExt: ext,
      byteSize: st.size,
      mtimeMs,
      sha256,
      title: deriveTitle(vaultPath, {}, ''),
      domain: sector,
      docType: ext.slice(1),
      status: null,
      tags: [],
      wikilinks: [],
      frontmatter: {},
      frontmatterError: null,
    };
    if (this.#db.isOpen) {
      try {
        return this.#db.upsertIndexEntry(binaryInput);
      } catch {
        // Fall through to non-persisted entry when SQLite is unavailable
      }
    }
    return { ...binaryInput, indexedAt: new Date().toISOString() };
  }
}

export {
  VaultAuditLogger,
  VaultConflictError,
  VaultEngineError,
  VaultNotFoundError,
  VaultPathSecurityError,
  VaultPermissionError,
  VaultPromotionGate,
  VaultTransactionManager,
  VaultValidationError,
  VaultVersionManager,
  VaultWatcher,
  type AppendNoteRequest,
  type EntityValidationResult,
  type ExternalVaultChange,
  type ListVaultOptions,
  type PromoteToCanonicalRequest,
  type UpdateNoteRequest,
  type VaultAuditRecord,
  type VaultEngineConfig,
  type VaultNoteDocument,
  type VaultNoteMetadata,
  type VaultSearchOptions,
  type VaultSnapshotManifest,
  type VaultVersionEntry,
  type WriteNoteRequest,
  type WriteNoteResult,
};
