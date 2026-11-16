import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { VaultPermissionError, VaultValidationError } from './errors.ts';
import { parseFrontmatterDocument } from './frontmatter.ts';
import type { VaultEngine } from './vault-engine.ts';

export type ArchiveVaultNoteRequest = {
  readonly sourceVaultPath: string;
  readonly reason: string;
  readonly actor: string;
  readonly targetSubdir?: 'SUPERSEDED' | 'RETIRED' | undefined;
};

export type ArchiveVaultNoteResult = {
  readonly archivedPath: string;
  readonly sourceVaultPath: string;
  readonly sha256: string;
  readonly archivedAt: string;
};

export type SupersedeVaultNoteRequest = {
  readonly priorVaultPath: string;
  readonly supersededByIdOrPath: string;
  readonly reason: string;
  readonly actor: string;
};

export type SupersedeVaultNoteResult = {
  readonly archivedCopyPath: string;
  readonly updatedPriorPath: string;
  readonly supersededAt: string;
};

const rebuildMarkdown = (frontmatter: Record<string, unknown>, body: string): string => {
  const yamlBlock = toYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yamlBlock}\n---\n\n${body.trim()}\n`;
};

/**
 * Explicitly copies a non-canonical Vault note into `12_ARCHIVE/<subdir>/` with
 * immutable provenance fields (`archived_at`, `archive_reason`, `archived_from`).
 * Never overwrites or deletes the source note silently; never runs automatically.
 */
export const archiveVaultNote = async (
  vault: VaultEngine,
  req: ArchiveVaultNoteRequest,
): Promise<ArchiveVaultNoteResult> => {
  if (!req.reason.trim()) {
    throw new VaultValidationError('INVALID_METADATA', 'archiveVaultNote requires a non-empty reason', {
      vaultPath: req.sourceVaultPath,
    });
  }
  const sourceDoc = await vault.readNote(req.sourceVaultPath);
  if (sourceDoc.isCanonical) {
    throw new VaultPermissionError(
      'CANONICAL_WRITE_FORBIDDEN',
      `Direct archival mutation of canonical note "${req.sourceVaultPath}" requires supersession through Promotion Gate`,
      { vaultPath: req.sourceVaultPath },
    );
  }

  const archivedAt = new Date().toISOString();
  const subdir = req.targetSubdir ?? 'RETIRED';
  const rawId = sourceDoc.frontmatter.id ? String(sourceDoc.frontmatter.id) : basename(req.sourceVaultPath, '.md');
  const suffix = randomUUID().slice(0, 6);
  const targetPath = `12_ARCHIVE/${subdir}/${archivedAt.slice(0, 10)}-${basename(req.sourceVaultPath)}`;

  const parsed = parseFrontmatterDocument(sourceDoc.rawContent, { strict: false, vaultPath: req.sourceVaultPath });
  const nextFm: Record<string, unknown> = {
    ...parsed.rawFrontmatter,
    id: `arch-${rawId}-${archivedAt.slice(0, 10)}-${suffix}`,
    sector: '12_ARCHIVE',
    status: 'archived',
    archive_reason: req.reason.trim(),
    archived_at: archivedAt,
    archived_from: req.sourceVaultPath,
    previous_sha256: sourceDoc.sha256,
    updated_at: archivedAt,
  };

  const written = await vault.writeNote({
    vaultPath: targetPath,
    content: rebuildMarkdown(nextFm, sourceDoc.body),
    actor: req.actor,
    reason: req.reason.trim(),
    writeMode: 'no-overwrite',
    validateSchema: true,
  });

  return {
    archivedPath: written.vaultPath,
    sourceVaultPath: req.sourceVaultPath,
    sha256: written.sha256,
    archivedAt,
  };
};

/**
 * Explicitly marks a non-canonical Vault document as `superseded` (`superseded_by`, `superseded_at`)
 * using compare-and-swap and writes an immutable backup into `12_ARCHIVE/SUPERSEDED/`.
 */
export const supersedeVaultNote = async (
  vault: VaultEngine,
  req: SupersedeVaultNoteRequest,
): Promise<SupersedeVaultNoteResult> => {
  if (!req.supersededByIdOrPath.trim() || !req.reason.trim()) {
    throw new VaultValidationError(
      'INVALID_ARCHIVE_OR_SUPERSESSION',
      'supersedeVaultNote requires non-empty supersededByIdOrPath and reason',
      { vaultPath: req.priorVaultPath },
    );
  }
  const sourceDoc = await vault.readNote(req.priorVaultPath);
  if (sourceDoc.isCanonical) {
    throw new VaultPermissionError(
      'CANONICAL_WRITE_FORBIDDEN',
      `Direct supersession of canonical note "${req.priorVaultPath}" is blocked outside Promotion Gate`,
      { vaultPath: req.priorVaultPath },
    );
  }

  const supersededAt = new Date().toISOString();
  const parsed = parseFrontmatterDocument(sourceDoc.rawContent, { strict: false, vaultPath: req.priorVaultPath });

  // 1. Archive immutable copy first
  const archived = await archiveVaultNote(vault, {
    sourceVaultPath: req.priorVaultPath,
    reason: `Superseded by ${req.supersededByIdOrPath.trim()}: ${req.reason.trim()}`,
    actor: req.actor,
    targetSubdir: 'SUPERSEDED',
  });

  // 2. CAS-update prior working note to status: superseded
  const nextFm: Record<string, unknown> = {
    ...parsed.rawFrontmatter,
    status: 'superseded',
    superseded_by: req.supersededByIdOrPath.trim(),
    superseded_at: supersededAt,
    updated_at: supersededAt,
    previous_sha256: sourceDoc.sha256,
  };

  await vault.writeNote({
    vaultPath: req.priorVaultPath,
    content: rebuildMarkdown(nextFm, sourceDoc.body),
    actor: req.actor,
    reason: `Mark superseded by ${req.supersededByIdOrPath.trim()}`,
    writeMode: 'compare-and-swap',
    expectedSha256: sourceDoc.sha256,
    validateSchema: true,
  });

  return {
    archivedCopyPath: archived.archivedPath,
    updatedPriorPath: req.priorVaultPath,
    supersededAt,
  };
};
