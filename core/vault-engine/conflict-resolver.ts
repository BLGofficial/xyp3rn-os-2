import { readFile, stat } from 'node:fs/promises';
import { VaultConflictError, VaultNotFoundError, VaultPermissionError, VaultValidationError } from './errors.ts';
import { parseFrontmatterDocument } from './frontmatter.ts';
import { resolveVaultPath } from './path-resolver.ts';
import { sha256Hex } from './revision.ts';
import { assertVaultPermission } from './vault-config.ts';
import {
  commitValidatedNote,
  extractEntityId,
  resolveUniqueCopyTarget,
  validateBeforeWrite,
  type WriterContext,
} from './writer.ts';

export type VaultConflictKind =
  | 'none'
  | 'missing_on_disk'
  | 'checksum_mismatch'
  | 'external_obsidian_edit'
  | 'corrupted_document';

export type VaultConflictReport = {
  readonly hasConflict: boolean;
  readonly kind: VaultConflictKind;
  readonly vaultPath: string;
  readonly isCanonical: boolean;
  readonly expectedSha256: string | null;
  readonly diskSha256: string | null;
  readonly indexedSha256: string | null;
  readonly diskFrontmatterError: string | null;
  readonly diskContent: string | null;
};

export type ConflictResolutionStrategy = 'keep-disk' | 'save-fork' | 'accept-proposed';

export type ResolveConflictRequest = {
  readonly vaultPath: string;
  readonly strategy: ConflictResolutionStrategy;
  readonly actor: string;
  readonly expectedDiskSha256?: string | undefined;
  readonly proposedContent?: string | undefined;
  readonly reason?: string | undefined;
  readonly validateSchema?: boolean | undefined;
  readonly checkReferences?: boolean | undefined;
};

export type ResolveConflictResult = {
  readonly strategy: ConflictResolutionStrategy;
  readonly resolvedPath: string;
  readonly forkPath: string | null;
  readonly sha256: string;
  readonly previousSha256: string | null;
  readonly revisionNumber: number;
};

/**
 * Inspects a Vault path for checksum mismatches, external on-disk Obsidian edits,
 * missing targets, or document corruption without mutating disk state.
 */
export const inspectVaultConflict = async (
  ctx: WriterContext,
  relPath: string,
  expectedSha256?: string | null,
  actor = 'system',
): Promise<VaultConflictReport> => {
  const check = await resolveVaultPath(ctx.config, relPath, { requireSectorPrefix: false });
  assertVaultPermission(ctx.config, ctx.audit, {
    actor,
    operation: 'inspectConflict',
    vaultPath: check.normalizedPath,
    sector: check.sector,
    isCanonical: check.isCanonical,
  });

  const indexed = ctx.db.isOpen
    ? (() => {
        try {
          return ctx.db.getIndexEntry(check.normalizedPath);
        } catch {
          return null;
        }
      })()
    : null;
  const indexedSha256 = indexed?.sha256 ?? null;

  const st = await stat(check.absPath).catch(() => null);
  if (!st || !st.isFile()) {
    const hasConflict = Boolean(expectedSha256 || indexedSha256);
    const kind: VaultConflictKind = hasConflict ? 'missing_on_disk' : 'none';
    ctx.audit.record({
      actor,
      operation: 'inspectConflict',
      filePath: check.normalizedPath,
      previousChecksum: expectedSha256 ?? indexedSha256,
      reason: hasConflict ? 'Conflict detected: file missing on disk' : 'No file or conflict present',
      result: hasConflict ? 'conflict' : 'success',
    });
    return {
      hasConflict,
      kind,
      vaultPath: check.normalizedPath,
      isCanonical: check.isCanonical,
      expectedSha256: expectedSha256 ?? null,
      diskSha256: null,
      indexedSha256,
      diskFrontmatterError: null,
      diskContent: null,
    };
  }

  const diskContent = await readFile(check.absPath, 'utf8');
  const diskSha256 = sha256Hex(diskContent);
  const parsed = parseFrontmatterDocument(diskContent, { strict: false, vaultPath: check.normalizedPath });
  const externalEdit = indexedSha256 !== null && indexedSha256 !== diskSha256;
  const expectedMismatch = expectedSha256 !== undefined && expectedSha256 !== null && expectedSha256 !== diskSha256;

  let kind: VaultConflictKind = 'none';
  if (parsed.frontmatterError) {
    kind = 'corrupted_document';
  } else if (externalEdit) {
    kind = 'external_obsidian_edit';
  } else if (expectedMismatch) {
    kind = 'checksum_mismatch';
  }

  const hasConflict = kind !== 'none';
  ctx.audit.record({
    actor,
    operation: 'inspectConflict',
    entityId: extractEntityId(parsed.rawFrontmatter),
    filePath: check.normalizedPath,
    previousChecksum: expectedSha256 ?? indexedSha256,
    newChecksum: diskSha256,
    reason: hasConflict ? `Conflict detected (${kind})` : 'No conflict detected',
    result: hasConflict ? 'conflict' : 'success',
  });

  return {
    hasConflict,
    kind,
    vaultPath: check.normalizedPath,
    isCanonical: check.isCanonical,
    expectedSha256: expectedSha256 ?? null,
    diskSha256,
    indexedSha256,
    diskFrontmatterError: parsed.frontmatterError,
    diskContent,
  };
};

/**
 * Safely resolves a write or Obsidian concurrency conflict without silent data loss.
 * Supports:
 * - `keep-disk`: preserves the live disk file, archives its SHA-256 revision if needed, and reconciles SQLite index.
 * - `save-fork`: writes conflicting content to a non-overwriting sibling path so both versions survive.
 * - `accept-proposed`: requires `expectedDiskSha256` matching live disk, archives the disk version first, then atomically updates.
 */
export const resolveVaultConflict = async (
  ctx: WriterContext,
  req: ResolveConflictRequest,
): Promise<ResolveConflictResult> => {
  const requireWritable = req.strategy !== 'keep-disk';
  const check = await resolveVaultPath(ctx.config, req.vaultPath, {
    requireSectorPrefix: true,
    requireWritableSector: requireWritable,
  });

  assertVaultPermission(ctx.config, ctx.audit, {
    actor: req.actor,
    operation: 'resolveConflict',
    vaultPath: check.normalizedPath,
    sector: check.sector,
    isCanonical: check.isCanonical,
  });

  if (req.strategy === 'accept-proposed' && check.isCanonical) {
    ctx.audit.record({
      actor: req.actor,
      operation: 'resolveConflict',
      filePath: check.normalizedPath,
      reason: 'Direct accept-proposed overwrite on canonical path forbidden; use promote()',
      result: 'denied',
      domain: 'GOVERNANCE',
    });
    throw new VaultPermissionError(
      'CANONICAL_WRITE_FORBIDDEN',
      `Conflict resolution strategy "accept-proposed" cannot mutate canonical path "${check.normalizedPath}" outside Promotion Gate`,
      { vaultPath: check.normalizedPath },
    );
  }

  return ctx.transactions.withPathLock(
    check.normalizedPath,
    req.actor,
    ctx.config.lockTtlMs,
    async () => {
      if (req.strategy === 'keep-disk') {
        const st = await stat(check.absPath).catch(() => null);
        if (!st || !st.isFile()) {
          throw new VaultNotFoundError('NOTE_NOT_FOUND', `Cannot resolve conflict with keep-disk: "${check.normalizedPath}" not found`, {
            vaultPath: check.normalizedPath,
          });
        }
        const diskContent = await readFile(check.absPath, 'utf8');
        const diskSha256 = sha256Hex(diskContent);
        const parsed = parseFrontmatterDocument(diskContent, { strict: false, vaultPath: check.normalizedPath });
        const entityId = extractEntityId(parsed.rawFrontmatter);
        const history = await ctx.versions.getHistory(check.normalizedPath);
        const lastRev = history.at(-1);

        let revNum = history.length;
        if (!lastRev || lastRev.sha256 !== diskSha256) {
          const entry = await ctx.versions.recordVersion({
            vaultPath: check.normalizedPath,
            entityId,
            content: diskContent,
            previousSha256: lastRev?.sha256 ?? null,
            actor: 'obsidian-external',
            operation: 'external-sync',
            reason: req.reason ?? 'Conflict resolved via keep-disk strategy',
          });
          revNum = entry.revisionNumber;
        }

        await ctx.indexSingleFile(check.normalizedPath, check.absPath, check.sector, check.ext);
        ctx.audit.record({
          actor: req.actor,
          operation: 'resolveConflict',
          entityId,
          filePath: check.normalizedPath,
          previousChecksum: lastRev?.sha256 ?? null,
          newChecksum: diskSha256,
          reason: req.reason ?? 'Resolved conflict via keep-disk',
          result: 'success',
        });

        return {
          strategy: 'keep-disk',
          resolvedPath: check.normalizedPath,
          forkPath: null,
          sha256: diskSha256,
          previousSha256: lastRev?.sha256 ?? null,
          revisionNumber: revNum,
        };
      }

      if (req.proposedContent === undefined) {
        throw new VaultValidationError(
          'INVALID_SCHEMA',
          `Conflict resolution strategy "${req.strategy}" requires non-empty proposedContent`,
          { vaultPath: check.normalizedPath },
        );
      }

      const { entityId: proposedEntityId } = validateBeforeWrite(ctx, check.normalizedPath, req.proposedContent, {
        validateSchema: req.validateSchema,
        checkReferences: req.checkReferences,
        actor: req.actor,
        operation: 'resolveConflict',
      });

      if (req.strategy === 'save-fork') {
        const forkCheck = await resolveUniqueCopyTarget(ctx, check);

        const forkResult = await ctx.transactions.withPathLock(
          forkCheck.normalizedPath,
          req.actor,
          ctx.config.lockTtlMs,
          () =>
            commitValidatedNote(ctx, {
              check: forkCheck,
              content: req.proposedContent!,
              actor: req.actor,
              entityId: proposedEntityId,
              previousSha256: null,
              createdCopy: true,
              operation: 'write',
              reason: req.reason ?? `Conflict fork preserved alongside ${check.normalizedPath}`,
              eventType: 'vault.write',
            }),
        );

        ctx.audit.record({
          actor: req.actor,
          operation: 'resolveConflict',
          entityId: proposedEntityId,
          filePath: check.normalizedPath,
          newChecksum: forkResult.sha256,
          reason: req.reason ?? `Resolved conflict via save-fork -> ${forkResult.vaultPath}`,
          result: 'success',
        });

        return {
          strategy: 'save-fork',
          resolvedPath: forkResult.vaultPath,
          forkPath: forkResult.vaultPath,
          sha256: forkResult.sha256,
          previousSha256: null,
          revisionNumber: forkResult.revisionNumber,
        };
      }

      // Strategy: accept-proposed (requires matching expectedDiskSha256)
      if (!req.expectedDiskSha256) {
        throw new VaultConflictError(
          'CHECKSUM_MISMATCH',
          `Conflict resolution strategy "accept-proposed" requires expectedDiskSha256 matching live disk state for "${check.normalizedPath}"`,
          { vaultPath: check.normalizedPath },
        );
      }

      const diskState = await ctx.transactions.inspectAndGuardDiskState({
        vaultPath: check.normalizedPath,
        absPath: check.absPath,
        expectedSha256: req.expectedDiskSha256,
      });

      if (!diskState.existsOnDisk || diskState.diskContent === null || !diskState.diskSha256) {
        throw new VaultNotFoundError('NOTE_NOT_FOUND', `Cannot apply accept-proposed: "${check.normalizedPath}" does not exist on disk`, {
          vaultPath: check.normalizedPath,
        });
      }

      // Preserve entity ID across resolution unless source frontmatter was corrupted
      const prevParsed = parseFrontmatterDocument(diskState.diskContent, { strict: false });
      const prevEntityId = prevParsed.frontmatterError ? null : extractEntityId(prevParsed.rawFrontmatter);
      if (prevEntityId && proposedEntityId !== prevEntityId) {
        throw new VaultValidationError(
          'ENTITY_ID_MUTATION_FORBIDDEN',
          `Stable entity ID cannot be mutated during conflict resolution: expected "${prevEntityId}", got "${proposedEntityId ?? '(none)'}"`,
          { vaultPath: check.normalizedPath, details: { prevEntityId, proposedEntityId } },
        );
      }

      // Ensure live disk version is archived before applying proposed overwrite so nothing is ever lost
      const history = await ctx.versions.getHistory(check.normalizedPath);
      if (history.at(-1)?.sha256 !== diskState.diskSha256) {
        await ctx.versions.recordVersion({
          vaultPath: check.normalizedPath,
          entityId: prevEntityId,
          content: diskState.diskContent,
          previousSha256: history.at(-1)?.sha256 ?? null,
          actor: 'obsidian-external',
          operation: 'external-sync',
          reason: 'Preserved conflicting disk revision prior to accept-proposed',
        });
      }

      const writeRes = await commitValidatedNote(ctx, {
        check,
        content: req.proposedContent,
        actor: req.actor,
        entityId: proposedEntityId ?? prevEntityId,
        previousSha256: diskState.diskSha256,
        createdCopy: false,
        operation: 'update',
        reason: req.reason ?? 'Conflict resolved via accept-proposed',
      });

      ctx.audit.record({
        actor: req.actor,
        operation: 'resolveConflict',
        entityId: proposedEntityId ?? prevEntityId,
        filePath: check.normalizedPath,
        previousChecksum: diskState.diskSha256,
        newChecksum: writeRes.sha256,
        reason: req.reason ?? 'Resolved conflict via accept-proposed',
        result: 'success',
      });

      return {
        strategy: 'accept-proposed',
        resolvedPath: check.normalizedPath,
        forkPath: null,
        sha256: writeRes.sha256,
        previousSha256: diskState.diskSha256,
        revisionNumber: writeRes.revisionNumber,
      };
    },
  );
};
