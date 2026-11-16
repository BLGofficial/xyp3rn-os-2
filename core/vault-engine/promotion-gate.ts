import { chmod } from 'node:fs/promises';
import { stringify as toYaml } from 'yaml';
import type { IndexEntryRecord, SqliteRuntimeDb } from '../sqlite/client.ts';
import type { VaultAuditLogger } from './audit.ts';
import {
  VaultNotFoundError,
  VaultPermissionError,
  VaultValidationError,
} from './errors.ts';
import { resolveVaultPath, type VaultSector } from './path-resolver.ts';
import { sha256Hex, writeFileAtomic } from './revision.ts';
import { assertValidEntityContent } from './schema-validator.ts';
import type { VaultTransactionManager } from './transaction-manager.ts';
import type { VaultEngineConfig } from './vault-config.ts';
import type { VaultVersionManager } from './version-manager.ts';
import type { WriteNoteResult } from './writer.ts';

export type PromoteToCanonicalRequest = {
  readonly approvalId: string;
  readonly targetVaultPath: string;
  readonly title: string;
  readonly body: string;
  readonly domain: string;
  readonly entityId?: string | undefined;
  readonly schema?: string | undefined;
  readonly sourceRefs?: readonly string[] | undefined;
  readonly evidenceIds?: readonly string[] | undefined;
  readonly confidence?: number | undefined;
  readonly provenance?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly readOnlyOnDisk?: boolean | undefined;
  readonly reason?: string | undefined;
};

export type PromotionGateContext = {
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

const AGENT_OR_SYSTEM_ACTOR_RE =
  /^(agent:|system$|jarvis$|auto$|x3lius-|tech-|records-)|-(agent|researcher|orchestrator|curator|summarizer|retriever|checker|generator|editor|advisor|assessor|forecaster|advocate|engine)$/i;

const isAgentIdentity = (actor: string): boolean => AGENT_OR_SYSTEM_ACTOR_RE.test(actor.trim());

/**
 * Promotion Gate — the sole authorized mechanism to promote candidates into canonical Vault paths.
 * Enforces human approval, blocks agent self-approval, requires provenance and evidence validation,
 * and records an immutable version + audit entry.
 */
export class VaultPromotionGate {
  readonly #ctx: PromotionGateContext;

  constructor(ctx: PromotionGateContext) {
    this.#ctx = ctx;
  }

  async promote(req: PromoteToCanonicalRequest): Promise<WriteNoteResult> {
    const approval = this.#ctx.db.getApproval(req.approvalId);
    if (!approval) {
      this.#ctx.audit.record({
        actor: 'unknown',
        operation: 'promote',
        filePath: req.targetVaultPath,
        reason: `Approval "${req.approvalId}" not found`,
        result: 'denied',
        domain: 'GOVERNANCE',
      });
      throw new VaultNotFoundError(
        'APPROVAL_NOT_FOUND',
        `Promotion Gate rejected: approval "${req.approvalId}" does not exist`,
        { vaultPath: req.targetVaultPath },
      );
    }

    if (approval.status !== 'approved') {
      this.#ctx.audit.record({
        actor: approval.proposer,
        operation: 'promote',
        filePath: req.targetVaultPath,
        reason: `Approval "${req.approvalId}" has status "${approval.status}" (requires human "approved")`,
        result: 'denied',
        domain: 'GOVERNANCE',
      });
      throw new VaultPermissionError(
        'UNAUTHORIZED_ACTOR',
        `Promotion Gate rejected: approval "${req.approvalId}" has status "${approval.status}" (requires human "approved" decision)`,
        { vaultPath: req.targetVaultPath, details: { status: approval.status } },
      );
    }

    const approver = (approval.approver ?? '').trim();
    const proposer = approval.proposer.trim();

    if (!approver || approver.toLowerCase() === proposer.toLowerCase() || isAgentIdentity(approver)) {
      this.#ctx.audit.record({
        actor: approver || proposer,
        operation: 'promote',
        filePath: req.targetVaultPath,
        reason: `Self-approval or agent approval forbidden (proposer="${proposer}", approver="${approver}")`,
        result: 'denied',
        domain: 'GOVERNANCE',
      });
      throw new VaultPermissionError(
        'SELF_APPROVAL_FORBIDDEN',
        `Promotion Gate security violation: agent or proposer "${proposer}" cannot approve its own promotion candidate (approver="${approver}"). Human operator approval is required.`,
        { vaultPath: req.targetVaultPath, details: { proposer, approver } },
      );
    }

    // Provenance verification
    const explicitSourceRefs = req.sourceRefs;
    if (explicitSourceRefs !== undefined && explicitSourceRefs.length === 0) {
      this.#ctx.audit.record({
        actor: approver,
        operation: 'promote',
        filePath: req.targetVaultPath,
        reason: 'Promotion rejected: empty sourceRefs array',
        result: 'invalid',
        domain: 'GOVERNANCE',
      });
      throw new VaultValidationError(
        'MISSING_PROVENANCE',
        'Promotion Gate rejected: canonical promotion requires at least one source or provenance reference.',
        { vaultPath: req.targetVaultPath },
      );
    }

    const provenanceRef =
      req.provenance?.trim() ||
      (explicitSourceRefs && explicitSourceRefs.length > 0 ? explicitSourceRefs.join(', ') : '') ||
      (typeof req.metadata?.source_ref === 'string' ? req.metadata.source_ref.trim() : '') ||
      approval.itemId.trim();

    if (!provenanceRef) {
      throw new VaultValidationError(
        'MISSING_PROVENANCE',
        'Promotion Gate rejected: missing provenance/source metadata for canonical promotion.',
        { vaultPath: req.targetVaultPath },
      );
    }

    // Evidence verification when evidenceIds or confidence are supplied
    if (req.evidenceIds !== undefined && req.evidenceIds.length === 0) {
      this.#ctx.audit.record({
        actor: approver,
        operation: 'promote',
        filePath: req.targetVaultPath,
        reason: 'Promotion rejected: empty evidenceIds',
        result: 'invalid',
        domain: 'GOVERNANCE',
      });
      throw new VaultValidationError(
        'INSUFFICIENT_EVIDENCE',
        'Promotion Gate rejected: evidenceIds cannot be empty when promoting research-backed canonical knowledge.',
        { vaultPath: req.targetVaultPath },
      );
    }

    if (req.confidence !== undefined && ( !Number.isFinite(req.confidence) || req.confidence < 0.7 || req.confidence > 1 )) {
      this.#ctx.audit.record({
        actor: approver,
        operation: 'promote',
        filePath: req.targetVaultPath,
        reason: `Promotion rejected: confidence ${String(req.confidence)} below threshold 0.7`,
        result: 'invalid',
        domain: 'GOVERNANCE',
      });
      throw new VaultValidationError(
        'INSUFFICIENT_EVIDENCE',
        `Promotion Gate rejected: confidence ${String(req.confidence)} must be between 0.70 and 1.00 for canonical promotion.`,
        { vaultPath: req.targetVaultPath, details: { confidence: req.confidence } },
      );
    }

    const check = await resolveVaultPath(this.#ctx.config, req.targetVaultPath, {
      requireSectorPrefix: true,
      requireWritableSector: false,
    });

    return this.#ctx.transactions.withPathLock(
      check.normalizedPath,
      approver,
      this.#ctx.config.lockTtlMs,
      async () => {
        const diskState = await this.#ctx.transactions.inspectAndGuardDiskState({
          vaultPath: check.normalizedPath,
          absPath: check.absPath,
        });
        const previousSha256 = diskState.diskSha256;

        const bodySha256 = sha256Hex(req.body.trim());
        const entityId =
          req.entityId?.trim() ||
          (typeof req.metadata?.id === 'string' ? req.metadata.id.trim() : '') ||
          `canon-${approval.itemId}`;
        const schema =
          req.schema?.trim() ||
          (typeof req.metadata?.schema === 'string' ? req.metadata.schema.trim() : '') ||
          'xyp3rn.knowledge/v3';

        const frontmatterObj: Record<string, unknown> = {
          ...(req.metadata ?? {}),
          schema,
          id: entityId,
          title: req.title,
          domain: req.domain,
          sector: check.sector,
          status: 'canonical',
          promoted_via: 'gate',
          approval_id: approval.id,
          proposer: approval.proposer,
          approved_by: approver,
          approved_at: approval.decidedAt,
          provenance: provenanceRef,
          ...(req.sourceRefs ? { source_refs: req.sourceRefs } : {}),
          ...(req.evidenceIds ? { evidence_ids: req.evidenceIds } : {}),
          ...(req.confidence !== undefined ? { confidence: req.confidence } : {}),
          source_sha256: bodySha256,
          previous_sha256: previousSha256,
          tags: [...new Set(['xyp3rn', 'canonical', ...(req.tags ?? [])])],
        };

        const fmYaml = toYaml(frontmatterObj, { lineWidth: 0 }).trimEnd();
        const fullNote = `---\n${fmYaml}\n---\n\n# ${req.title}\n\n${req.body.trim()}\n`;

        assertValidEntityContent(check.normalizedPath, fullNote, { requireSchema: true });

        if (diskState.existsOnDisk) {
          await chmod(check.absPath, 0o644).catch(() => undefined);
        }

        await writeFileAtomic(check.absPath, fullNote);
        if (req.readOnlyOnDisk) {
          await chmod(check.absPath, 0o444).catch(() => undefined);
        }

        const versionEntry = await this.#ctx.versions.recordVersion({
          vaultPath: check.normalizedPath,
          entityId,
          content: fullNote,
          previousSha256,
          actor: `promotion-gate:${approver}`,
          operation: 'promote',
          reason: req.reason ?? approval.reason ?? `Promoted via approval ${approval.id}`,
        });

        await this.#ctx.indexSingleFile(
          check.normalizedPath,
          check.absPath,
          check.sector,
          check.ext,
        );

        this.#ctx.db.appendEvent({
          eventType: 'vault.promoted',
          domain: 'KNOWLEDGE',
          actor: approver,
          targetPath: check.normalizedPath,
          checksumSha256: versionEntry.sha256,
          payload: {
            approvalId: approval.id,
            itemType: approval.itemType,
            itemId: approval.itemId,
            entityId,
            previousSha256,
            sourceSha256: bodySha256,
          },
        });

        this.#ctx.audit.record({
          actor: approver,
          operation: 'promote',
          entityId,
          filePath: check.normalizedPath,
          previousChecksum: previousSha256,
          newChecksum: versionEntry.sha256,
          reason: req.reason ?? approval.reason ?? `Promoted via approval ${approval.id}`,
          result: 'success',
          domain: 'GOVERNANCE',
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
  }
}
