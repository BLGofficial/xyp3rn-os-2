import { stat } from 'node:fs/promises';
import type { IndexEntryRecord, SqliteRuntimeDb } from '../sqlite/client.ts';
import type { VaultAuditLogger } from './audit.ts';
import {
  VaultConflictError,
  VaultNotFoundError,
  VaultPermissionError,
  VaultValidationError,
} from './errors.ts';
import { parseFrontmatterDocument } from './frontmatter.ts';
import { targetExistsInIndex } from './links.ts';
import {
  resolveNoOverwritePath,
  resolveVaultPath,
  type ResolvedVaultPath,
  type VaultSector,
} from './path-resolver.ts';
import { writeFileAtomic } from './revision.ts';
import { assertValidEntityContent } from './schema-validator.ts';
import type { VaultTransactionManager } from './transaction-manager.ts';
import type { VaultEngineConfig } from './vault-config.ts';
import type { VaultVersionManager } from './version-manager.ts';

export type WriteNoteRequest = {
  readonly vaultPath: string;
  readonly content: string;
  readonly actor: string;
  readonly reason?: string | undefined;
  /**
   * 'no-overwrite' (default): creates `Note (2).md` if `vaultPath` exists.
   * 'reject-overwrite': throws `VaultConflictError('SILENT_OVERWRITE_FORBIDDEN')` if `vaultPath` exists.
   * 'compare-and-swap': overwrites ONLY if the existing file's SHA-256 equals `expectedSha256`.
   */
  readonly writeMode?: 'no-overwrite' | 'reject-overwrite' | 'compare-and-swap' | undefined;
  readonly expectedSha256?: string | undefined;
  readonly validateSchema?: boolean | undefined;
  readonly checkReferences?: boolean | undefined;
};

export type UpdateNoteRequest = {
  readonly vaultPath: string;
  readonly content: string;
  readonly actor: string;
  readonly expectedSha256: string;
  readonly reason?: string | undefined;
  readonly validateSchema?: boolean | undefined;
  readonly checkReferences?: boolean | undefined;
};

export type AppendNoteRequest = {
  readonly vaultPath: string;
  readonly appendText: string;
  readonly actor: string;
  readonly reason?: string | undefined;
  readonly expectedSha256?: string | undefined;
};

export type WriteNoteResult = {
  readonly vaultPath: string;
  readonly sha256: string;
  readonly previousSha256: string | null;
  readonly createdCopy: boolean;
  readonly byteSize: number;
  readonly revisionNumber: number;
};

export type WriterContext = {
  readonly config: VaultEngineConfig;
  readonly db: SqliteRuntimeDb;
  readonly versions: VaultVersionManager;
  readonly transactions: VaultTransactionManager;
  readonly audit: VaultAuditLogger;
  readonly indexSingleFile: (
    vaultPath: string,
    absPath: string,
    sector: VaultSector | 'ROOT_KB',
    ext: string,
  ) => Promise<IndexEntryRecord>;
};

const extractEntityId = (rawFm: Record<string, unknown>): string | null =>
  typeof rawFm.id === 'string' && rawFm.id.trim().length > 0
    ? rawFm.id.trim()
    : typeof rawFm.id === 'number'
      ? String(rawFm.id)
      : null;

const validateBeforeWrite = (
  ctx: WriterContext,
  vaultPath: string,
  content: string,
  options: {
    readonly validateSchema?: boolean | undefined;
    readonly checkReferences?: boolean | undefined;
    readonly actor: string;
    readonly operation: 'write' | 'update' | 'append';
  },
): { readonly entityId: string | null } => {
  try {
    const parsed = parseFrontmatterDocument(content, { strict: true, vaultPath });
    if (parsed.rawFrontmatter.status === 'canonical' || parsed.rawFrontmatter.domain === 'canonical') {
      throw new VaultPermissionError(
        'CANONICAL_WRITE_FORBIDDEN',
        `Note frontmatter declares canonical status/domain; canonical notes may only be written via promote().`,
        { vaultPath },
      );
    }

    const requireSchema =
      options.validateSchema ??
      (ctx.config.enforceSchemaOnWrite || typeof parsed.rawFrontmatter.schema === 'string');
    const checkReferences = options.checkReferences ?? ctx.config.enforceReferencesOnWrite;

    assertValidEntityContent(vaultPath, content, {
      requireSchema,
      checkReferences,
      targetExists: (target) => targetExistsInIndex(ctx.db, target),
    });

    return { entityId: extractEntityId(parsed.rawFrontmatter) };
  } catch (err) {
    if (err instanceof VaultPermissionError) {
      ctx.audit.record({
        actor: options.actor,
        operation: options.operation,
        filePath: vaultPath,
        reason: err.message,
        result: 'denied',
        domain: 'GOVERNANCE',
      });
    } else {
      ctx.audit.record({
        actor: options.actor,
        operation: options.operation,
        filePath: vaultPath,
        reason: (err as Error).message,
        result: 'invalid',
        domain: 'GOVERNANCE',
      });
    }
    throw err;
  }
};

export const executeControlledWrite = async (
  ctx: WriterContext,
  req: WriteNoteRequest,
): Promise<WriteNoteResult> => {
  let initialCheck: ResolvedVaultPath;
  try {
    initialCheck = await resolveVaultPath(ctx.config, req.vaultPath, {
      requireSectorPrefix: true,
      requireWritableSector: true,
    });
  } catch (err) {
    ctx.audit.record({
      actor: req.actor,
      operation: 'write',
      filePath: req.vaultPath,
      reason: (err as Error).message,
      result: 'denied',
      domain: 'GOVERNANCE',
    });
    throw err;
  }

  if (initialCheck.isCanonical) {
    if (ctx.db.isOpen) {
      try {
        ctx.db.appendEvent({
          eventType: 'vault.write.denied',
          domain: 'GOVERNANCE',
          actor: req.actor,
          targetPath: initialCheck.normalizedPath,
          payload: { reason: 'direct canonical write forbidden; must pass Promotion Gate' },
        });
      } catch {
        // Ignore if SQLite unavailable
      }
    }
    ctx.audit.record({
      actor: req.actor,
      operation: 'write',
      filePath: initialCheck.normalizedPath,
      reason: 'Direct write to canonical path forbidden',
      result: 'denied',
      domain: 'GOVERNANCE',
    });
    throw new VaultPermissionError(
      'CANONICAL_WRITE_FORBIDDEN',
      `VaultEngine security violation: "${initialCheck.normalizedPath}" is in a canonical sector and cannot be written directly by "${req.actor}". Use promote() with a human-approved approvalId.`,
      { vaultPath: initialCheck.normalizedPath },
    );
  }

  const { entityId } = validateBeforeWrite(ctx, initialCheck.normalizedPath, req.content, {
    validateSchema: req.validateSchema,
    checkReferences: req.checkReferences,
    actor: req.actor,
    operation: 'write',
  });

  const mode = req.writeMode ?? 'no-overwrite';
  let finalCheck = initialCheck;
  let previousSha256: string | null = null;
  let createdCopy = false;

  const existingStat = await stat(initialCheck.absPath).catch(() => null);
  if (existingStat) {
    if (mode === 'reject-overwrite') {
      ctx.audit.record({
        actor: req.actor,
        operation: 'write',
        entityId,
        filePath: initialCheck.normalizedPath,
        reason: 'Silent overwrite rejected by writeMode=reject-overwrite',
        result: 'conflict',
      });
      throw new VaultConflictError(
        'SILENT_OVERWRITE_FORBIDDEN',
        `Silent overwrite rejected: "${initialCheck.normalizedPath}" already exists. Use update() with expectedSha256 or writeMode="no-overwrite".`,
        { vaultPath: initialCheck.normalizedPath },
      );
    }

    if (mode === 'no-overwrite') {
      const indexedPaths = new Set<string>(
        ctx.db.isOpen
          ? (() => {
              try {
                return ctx.db.listIndexEntries(undefined, 50_000).map((e) => e.vaultPath);
              } catch {
                return [];
              }
            })()
          : [],
      );
      indexedPaths.add(initialCheck.normalizedPath);
      let candidatePath = resolveNoOverwritePath(initialCheck.normalizedPath, indexedPaths);
      let candidateCheck = await resolveVaultPath(ctx.config, candidatePath, {
        requireSectorPrefix: true,
        requireWritableSector: true,
      });
      while ((await stat(candidateCheck.absPath).catch(() => null)) !== null) {
        indexedPaths.add(candidateCheck.normalizedPath);
        candidatePath = resolveNoOverwritePath(initialCheck.normalizedPath, indexedPaths);
        candidateCheck = await resolveVaultPath(ctx.config, candidatePath, {
          requireSectorPrefix: true,
          requireWritableSector: true,
        });
      }
      finalCheck = candidateCheck;
      createdCopy = true;
    } else {
      if (!req.expectedSha256) {
        throw new VaultConflictError(
          'CHECKSUM_MISMATCH',
          `VaultEngine compare-and-swap requires expectedSha256 for existing note "${initialCheck.normalizedPath}"`,
          { vaultPath: initialCheck.normalizedPath },
        );
      }
      try {
        const diskState = await ctx.transactions.inspectAndGuardDiskState({
          vaultPath: initialCheck.normalizedPath,
          absPath: initialCheck.absPath,
          expectedSha256: req.expectedSha256,
        });
        previousSha256 = diskState.diskSha256;
      } catch (err) {
        if (ctx.db.isOpen) {
          try {
            ctx.db.appendEvent({
              eventType: 'vault.write.conflict',
              domain: 'KNOWLEDGE',
              actor: req.actor,
              targetPath: initialCheck.normalizedPath,
              payload: { expectedSha256: req.expectedSha256, error: (err as Error).message },
            });
          } catch {
            // Ignore if SQLite unavailable
          }
        }
        ctx.audit.record({
          actor: req.actor,
          operation: 'write',
          entityId,
          filePath: initialCheck.normalizedPath,
          previousChecksum: req.expectedSha256,
          reason: (err as Error).message,
          result: 'conflict',
        });
        throw err;
      }
    }
  }

  return ctx.transactions.withPathLock(
    finalCheck.normalizedPath,
    req.actor,
    ctx.config.lockTtlMs,
    async () => {
      await writeFileAtomic(finalCheck.absPath, req.content);
      const versionEntry = await ctx.versions.recordVersion({
        vaultPath: finalCheck.normalizedPath,
        entityId,
        content: req.content,
        previousSha256,
        actor: req.actor,
        operation: 'write',
        reason: req.reason ?? (createdCopy ? 'Created safe non-overwriting copy' : 'Controlled vault write'),
      });

      await ctx.indexSingleFile(
        finalCheck.normalizedPath,
        finalCheck.absPath,
        finalCheck.sector,
        finalCheck.ext,
      );

      if (ctx.db.isOpen) {
        try {
          ctx.db.appendEvent({
            eventType: 'vault.write',
            domain: 'KNOWLEDGE',
            actor: req.actor,
            targetPath: finalCheck.normalizedPath,
            checksumSha256: versionEntry.sha256,
            payload: {
              previousSha256,
              createdCopy,
              byteSize: versionEntry.byteSize,
              revisionNumber: versionEntry.revisionNumber,
            },
          });
        } catch {
          // Ignore if SQLite unavailable
        }
      }

      ctx.audit.record({
        actor: req.actor,
        operation: 'write',
        entityId,
        filePath: finalCheck.normalizedPath,
        previousChecksum: previousSha256,
        newChecksum: versionEntry.sha256,
        reason: req.reason ?? 'Controlled vault write',
        result: 'success',
      });

      return {
        vaultPath: finalCheck.normalizedPath,
        sha256: versionEntry.sha256,
        previousSha256,
        createdCopy,
        byteSize: versionEntry.byteSize,
        revisionNumber: versionEntry.revisionNumber,
      };
    },
  );
};

export const executeControlledUpdate = async (
  ctx: WriterContext,
  req: UpdateNoteRequest,
): Promise<WriteNoteResult> => {
  let check: ResolvedVaultPath;
  try {
    check = await resolveVaultPath(ctx.config, req.vaultPath, {
      requireSectorPrefix: true,
      requireWritableSector: true,
    });
  } catch (err) {
    ctx.audit.record({
      actor: req.actor,
      operation: 'update',
      filePath: req.vaultPath,
      reason: (err as Error).message,
      result: 'denied',
      domain: 'GOVERNANCE',
    });
    throw err;
  }

  if (check.isCanonical) {
    ctx.audit.record({
      actor: req.actor,
      operation: 'update',
      filePath: check.normalizedPath,
      reason: 'Direct update to canonical path forbidden',
      result: 'denied',
      domain: 'GOVERNANCE',
    });
    throw new VaultPermissionError(
      'CANONICAL_WRITE_FORBIDDEN',
      `Direct update to canonical path "${check.normalizedPath}" is forbidden; use promote().`,
      { vaultPath: check.normalizedPath },
    );
  }

  const { entityId: newEntityId } = validateBeforeWrite(ctx, check.normalizedPath, req.content, {
    validateSchema: req.validateSchema,
    checkReferences: req.checkReferences,
    actor: req.actor,
    operation: 'update',
  });

  return ctx.transactions.withPathLock(
    check.normalizedPath,
    req.actor,
    ctx.config.lockTtlMs,
    async () => {
      let diskState;
      try {
        diskState = await ctx.transactions.inspectAndGuardDiskState({
          vaultPath: check.normalizedPath,
          absPath: check.absPath,
          expectedSha256: req.expectedSha256,
        });
      } catch (err) {
        ctx.audit.record({
          actor: req.actor,
          operation: 'update',
          entityId: newEntityId,
          filePath: check.normalizedPath,
          previousChecksum: req.expectedSha256,
          reason: (err as Error).message,
          result: 'conflict',
        });
        throw err;
      }

      if (!diskState.existsOnDisk || diskState.diskContent === null) {
        throw new VaultNotFoundError('NOTE_NOT_FOUND', `Cannot update non-existent note "${check.normalizedPath}"`, {
          vaultPath: check.normalizedPath,
        });
      }

      // Enforce stable entity ID preservation across updates
      const prevParsed = parseFrontmatterDocument(diskState.diskContent, { strict: false });
      const prevEntityId = extractEntityId(prevParsed.rawFrontmatter);
      if (prevEntityId && newEntityId !== prevEntityId) {
        ctx.audit.record({
          actor: req.actor,
          operation: 'update',
          entityId: prevEntityId,
          filePath: check.normalizedPath,
          previousChecksum: diskState.diskSha256,
          reason: `Attempted to mutate stable entity ID from "${prevEntityId}" to "${newEntityId ?? '(none)'}"`,
          result: 'invalid',
        });
        throw new VaultValidationError(
          'ENTITY_ID_MUTATION_FORBIDDEN',
          `Stable entity ID cannot be mutated during update: expected "${prevEntityId}", got "${newEntityId ?? '(none)'}"`,
          { vaultPath: check.normalizedPath, details: { prevEntityId, newEntityId } },
        );
      }

      await writeFileAtomic(check.absPath, req.content);
      const versionEntry = await ctx.versions.recordVersion({
        vaultPath: check.normalizedPath,
        entityId: newEntityId ?? prevEntityId,
        content: req.content,
        previousSha256: diskState.diskSha256,
        actor: req.actor,
        operation: 'update',
        reason: req.reason ?? 'Controlled optimistic-concurrency update',
      });

      await ctx.indexSingleFile(check.normalizedPath, check.absPath, check.sector, check.ext);

      ctx.audit.record({
        actor: req.actor,
        operation: 'update',
        entityId: newEntityId ?? prevEntityId,
        filePath: check.normalizedPath,
        previousChecksum: diskState.diskSha256,
        newChecksum: versionEntry.sha256,
        reason: req.reason ?? 'Controlled optimistic-concurrency update',
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
};

export const executeControlledAppend = async (
  ctx: WriterContext,
  req: AppendNoteRequest,
): Promise<WriteNoteResult> => {
  let check: ResolvedVaultPath;
  try {
    check = await resolveVaultPath(ctx.config, req.vaultPath, {
      requireSectorPrefix: true,
      requireWritableSector: true,
    });
  } catch (err) {
    ctx.audit.record({
      actor: req.actor,
      operation: 'append',
      filePath: req.vaultPath,
      reason: (err as Error).message,
      result: 'denied',
      domain: 'GOVERNANCE',
    });
    throw err;
  }

  if (check.isCanonical) {
    ctx.audit.record({
      actor: req.actor,
      operation: 'append',
      filePath: check.normalizedPath,
      reason: 'Direct append to canonical path forbidden',
      result: 'denied',
      domain: 'GOVERNANCE',
    });
    throw new VaultPermissionError(
      'CANONICAL_WRITE_FORBIDDEN',
      `VaultEngine security violation: cannot append directly to canonical path "${check.normalizedPath}"`,
      { vaultPath: check.normalizedPath },
    );
  }

  return ctx.transactions.withPathLock(
    check.normalizedPath,
    req.actor,
    ctx.config.lockTtlMs,
    async () => {
      const diskState = await ctx.transactions.inspectAndGuardDiskState({
        vaultPath: check.normalizedPath,
        absPath: check.absPath,
        expectedSha256: req.expectedSha256,
      });

      const existingRaw = diskState.diskContent;
      const previousSha256 = diskState.diskSha256;
      const separator = existingRaw && !existingRaw.endsWith('\n') ? '\n' : '';
      const nextContent = existingRaw !== null ? `${existingRaw}${separator}${req.appendText}` : req.appendText;

      const { entityId } = validateBeforeWrite(ctx, check.normalizedPath, nextContent, {
        actor: req.actor,
        operation: 'append',
      });

      await writeFileAtomic(check.absPath, nextContent);
      const versionEntry = await ctx.versions.recordVersion({
        vaultPath: check.normalizedPath,
        entityId,
        content: nextContent,
        previousSha256,
        actor: req.actor,
        operation: 'append',
        reason: req.reason ?? 'Controlled vault append',
      });

      await ctx.indexSingleFile(check.normalizedPath, check.absPath, check.sector, check.ext);

      if (ctx.db.isOpen) {
        try {
          ctx.db.appendEvent({
            eventType: 'vault.append',
            domain: 'KNOWLEDGE',
            actor: req.actor,
            targetPath: check.normalizedPath,
            checksumSha256: versionEntry.sha256,
            payload: { previousSha256, byteSize: versionEntry.byteSize },
          });
        } catch {
          // Ignore if SQLite unavailable
        }
      }

      ctx.audit.record({
        actor: req.actor,
        operation: 'append',
        entityId,
        filePath: check.normalizedPath,
        previousChecksum: previousSha256,
        newChecksum: versionEntry.sha256,
        reason: req.reason ?? 'Controlled vault append',
        result: 'success',
      });

      return {
        vaultPath: check.normalizedPath,
        sha256: versionEntry.sha256,
        previousSha256,
        createdCopy: false,
        byteSize: versionEntry.byteSize,
        revisionNumber: versionEntry.revisionNumber,
      };
    },
  );
};
