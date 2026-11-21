import { randomUUID } from 'node:crypto';
import type { SqliteRuntimeDb } from '../core/sqlite/client.ts';
import { serializeFrontmatterDocument } from '../core/vault-engine/frontmatter.ts';
import { sha256Hex } from '../core/vault-engine/revision.ts';
import type { VaultEngine } from '../core/vault-engine/vault-engine.ts';
import { checkRights, type RightsVerdict } from './ops/rights-splits/check.ts';
import type { CatalogRecord, ReleaseStatus } from './ops/tools.ts';
import {
  addContributorAlias as opsAddContributorAlias,
  applyApprovedSplitProposal as opsApplyApprovedSplitProposal,
  approveMasterVersion as opsApproveMasterVersion,
  computeCatalogReadinessChecks as opsComputeCatalogReadinessChecks,
  createMusicProject as opsCreateMusicProject,
  getAlbumContinuity as opsGetAlbumContinuity,
  linkSongTarget as opsLinkSongTarget,
  proposeRightsSplitChange as opsProposeRightsSplitChange,
  recordMasterVersion as opsRecordMasterVersion,
  recordMixVersion as opsRecordMixVersion,
  recordReleaseDelivery as opsRecordReleaseDelivery,
  registerContributor as opsRegisterContributor,
  requestMasterApproval as opsRequestMasterApproval,
  retractCredit as opsRetractCredit,
  retractPlatformLink as opsRetractPlatformLink,
  retractSongLink as opsRetractSongLink,
  setReleaseArtwork as opsSetReleaseArtwork,
  validateRightsSharesMilli,
  writeCredit as opsWriteCredit,
  writePlatformLink as opsWritePlatformLink,
} from './os3-records-catalog-ops.ts';
import type {
  CatalogReadinessReport,
  AlbumContinuityReport,
  ContributorAliasInput,
  ContributorInput,
  CreditInput,
  CreditRetractionInput,
  MasterVersionInput,
  MixVersionInput,
  MusicProjectInput,
  PlatformLinkInput,
  PlatformLinkRetractionInput,
  ReleaseArtworkInput,
  ReleaseDeliveryInput,
  SongLinkInput,
  SongLinkRetractionInput,
  SplitProposalInput,
} from './os3-records-types.ts';
import { mixedScriptWords } from './x3lius/creative/script-check.ts';

export const X3LIUS_DOMAINS = [
  'songwriting',
  'lyrics',
  'vocal-dna',
  'composition',
  'arrangement',
  'genre-style',
  'suno',
  'production',
  'mix-master',
  'evaluation',
  'catalog',
  'rights-splits',
  'release-calendar',
] as const;

export type X3liusDomain = (typeof X3LIUS_DOMAINS)[number];

export const ISRC_REGEX = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;

/**
 * Exact OS2 GS1 mod-10 check-digit validation for 12-digit UPC-A and 13-digit EAN-13 codes.
 * Matches `public.xyp_is_valid_gs1(text)` in `supabase/migrations/20260925110000_records_ops.sql`.
 */
export const isValidGs1Code = (code: string): boolean => {
  const clean = code.trim();
  if (!/^[0-9]{12,13}$/.test(clean)) return false;
  let sum = 0;
  for (let i = 1; i <= clean.length - 1; i++) {
    const digit = Number(clean[clean.length - 1 - i]);
    sum += digit * (i % 2 === 1 ? 3 : 1);
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === Number(clean[clean.length - 1]);
};

export const isValidIsrcCode = (isrc: string): boolean => ISRC_REGEX.test(isrc.trim());

const milli = (n: number): number => Math.round(n * 1000);

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';

const SUBDOMAIN_TO_DIR: Readonly<Record<string, string>> = {
  songwriting: '09_X3LIUS_MUSIC/SONGS',
  lyrics: '09_X3LIUS_MUSIC/LYRICS',
  'vocal-dna': '09_X3LIUS_MUSIC/VOCAL_DNA',
  composition: '09_X3LIUS_MUSIC/COMPOSITIONS',
  arrangement: '09_X3LIUS_MUSIC/ARRANGEMENTS',
  'genre-style': '09_X3LIUS_MUSIC/GENRES_STYLES',
  suno: '09_X3LIUS_MUSIC/SUNO_PACKAGES',
  production: '09_X3LIUS_MUSIC/TAKES',
  'mix-master': '09_X3LIUS_MUSIC/EVALUATION',
  evaluation: '09_X3LIUS_MUSIC/EVALUATION',
};

export type SplitShareInput = {
  readonly payee: string | null;
  readonly role: string;
  readonly percentage: number;
};

export type ReleaseHistoryEntry = {
  readonly fromStatus: ReleaseStatus | null;
  readonly toStatus: ReleaseStatus;
  readonly releaseDate: string | null;
  readonly rightsCheckRunId: string | null;
  readonly actor: string;
  readonly at: string;
  readonly reason: string;
};

export type LegacyRecordsExport = {
  readonly songs: ReadonlyArray<{ readonly id: string; readonly title: string; readonly artist: string; readonly language: string }>;
  readonly lyricVersions: ReadonlyArray<{ readonly lineageId: string; readonly version: number; readonly approved: boolean }>;
  readonly tracks: ReadonlyArray<{ readonly id: string; readonly releaseId: string; readonly position: number; readonly title: string; readonly isrc: string | null }>;
  readonly releases: ReadonlyArray<{ readonly id: string; readonly title: string; readonly kind: string; readonly upc: string | null; readonly status: ReleaseStatus }>;
  readonly splits: ReadonlyArray<{ readonly trackId: string; readonly version: number; readonly sum: number; readonly hasUnassigned: boolean }>;
  readonly takes: ReadonlyArray<{ readonly id: string; readonly sunoModel: string; readonly promptText: string }>;
};

export type LegacyReconciliationReport = {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly counts: Readonly<Record<string, { readonly legacy: number; readonly migrated: number; readonly matched: number }>>;
  readonly discrepancies: readonly string[];
};

/**
 * OS 3.0 Vault-First X3LIUS Music System & Records Engine.
 * Preserves every OS2 creative, provenance, approval, split-sum, ISRC/UPC, and scheduling
 * invariant using `VaultEngine` for canonical storage and `SqliteRuntimeDb` strictly for
 * ephemeral run/approval state.
 */
export class Os3RecordsEngine {
  readonly #vault: VaultEngine;
  readonly #db: SqliteRuntimeDb;

  constructor(options: { readonly vault: VaultEngine; readonly db: SqliteRuntimeDb }) {
    this.#vault = options.vault;
    this.#db = options.db;
  }

  // ─── 1. Songs & Song Revisions (Identity Preserved) ─────────────────────────

  async createSong(input: {
    readonly id?: string | undefined;
    readonly title: string;
    readonly artist: string;
    readonly language: string;
    readonly genre?: string | undefined;
    readonly bpm?: number | undefined;
    readonly actor?: string | undefined;
  }) {
    if (!input.title.trim()) throw new Error('Song title is required');
    const id = input.id?.trim() || `song-${randomUUID().slice(0, 8)}`;
    const vaultPath = `09_X3LIUS_MUSIC/SONGS/SONG-${id.replace(/^song-/, '')}-${slugify(input.title)}.md`;

    // Prevent duplicate song ID
    if (this.#findByEntityId(id)) {
      throw new Error(`Song identity "${id}" already exists in Vault`);
    }

    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.song/v3',
        id,
        type: 'song',
        title: input.title.trim(),
        domain: 'RECORDS',
        sector: '09_X3LIUS_MUSIC',
        artist: input.artist.trim(),
        language: input.language.trim(),
        genre: input.genre?.trim() ?? 'unspecified',
        bpm: input.bpm ?? null,
        status: 'draft',
        version: 1,
        revision: 1,
        tags: ['xyp3rn', 'os3', 'x3lius', 'song'],
      },
      `# Song: ${input.title.trim()}\n\n- **Song ID:** \`${id}\`\n- **Artist:** ${input.artist.trim()}\n- **Language:** \`${input.language.trim()}\``,
    );

    return this.#vault.write({
      vaultPath,
      content,
      actor: input.actor ?? 'records-songs',
      writeMode: 'reject-overwrite',
      reason: `Create song ${id}`,
    });
  }

  async createSongRevision(input: {
    readonly songPathOrId: string;
    readonly summary: string;
    readonly metadataPatch?: Record<string, unknown> | undefined;
    readonly actor?: string | undefined;
  }) {
    const songEntry = this.#findEntry(input.songPathOrId, '09_X3LIUS_MUSIC/SONGS/');
    if (!songEntry) throw new Error(`Song not found: "${input.songPathOrId}"`);
    const songDoc = await this.#vault.read(songEntry.vaultPath);
    const songId = String(songDoc.frontmatter.id);
    const nextRev = Number(songDoc.frontmatter.revision ?? 1) + 1;

    // 1. Write immutable Song Revision record (preserves permanent song_id)
    const revId = `srev-${songId.replace(/^song-/, '')}-v${nextRev}`;
    const revPath = `09_X3LIUS_MUSIC/SONGS/SREV-${songId.replace(/^song-/, '')}-v${nextRev}.md`;
    const revContent = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id: revId,
        type: 'song_revision',
        title: `Song Revision ${nextRev}: ${songDoc.frontmatter.title}`,
        domain: 'RECORDS',
        sector: '09_X3LIUS_MUSIC',
        song_id: songId,
        song_ref: songDoc.vaultPath,
        revision: nextRev,
        status: 'approved',
        version: nextRev,
        tags: ['xyp3rn', 'os3', 'x3lius', 'song-revision'],
      },
      `# Song Revision v${nextRev} (\`${songId}\`)\n\n${input.summary.trim()}`,
    );

    const revWritten = await this.#vault.write({
      vaultPath: revPath,
      content: revContent,
      actor: input.actor ?? 'records-songs',
      writeMode: 'reject-overwrite',
      reason: `Record immutable song revision v${nextRev}`,
    });

    // 2. Update parent Song note atomically while keeping song.id immutable
    const updatedSongContent = serializeFrontmatterDocument(
      {
        ...songDoc.frontmatter,
        ...(input.metadataPatch ?? {}),
        id: songId, // Identity never changes
        revision: nextRev,
        latest_revision_ref: revWritten.vaultPath,
      },
      `${songDoc.body.trim()}\n- **Revision v${nextRev}:** [[${revWritten.vaultPath.replace(/\.md$/, '')}|${revId}]] — ${input.summary.trim()}`,
    );

    const songUpdated = await this.#vault.update({
      vaultPath: songDoc.vaultPath,
      content: updatedSongContent,
      actor: input.actor ?? 'records-songs',
      expectedSha256: songDoc.sha256,
      reason: `Advance song revision pointer to v${nextRev}`,
    });

    return { songId, revision: nextRev, revisionWrite: revWritten, songUpdate: songUpdated };
  }

  // ─── 2. Immutable Lyric Versions, Creative Artifacts & Creative Approvals ──

  async createLyricVersion(input: {
    readonly songPathOrId: string;
    readonly lineageId: string;
    readonly title: string;
    readonly language: string;
    readonly sections: ReadonlyArray<{ readonly label: string; readonly lines: readonly string[] }>;
    readonly author?: string | undefined;
    readonly structureRef?: string | undefined;
  }) {
    const songEntry = this.#findEntry(input.songPathOrId, '09_X3LIUS_MUSIC/SONGS/');
    if (!songEntry) throw new Error(`Song not found: "${input.songPathOrId}"`);
    const songId = String(songEntry.frontmatter.id);

    // Enforce OS2 Homoglyph mixed-script guard (Latin + Cyrillic inside same word)
    const faults = mixedScriptWords(input.sections);
    if (faults.length > 0) {
      throw new Error(
        `Lyric rejected (homoglyph guard F22): mixed-script word(s) detected: ${faults.map((f) => `${f.word} at ${f.path}`).join(', ')}`,
      );
    }

    // Compute next monotonic immutable version in this lineage
    const existing = this.#db
      .listIndexEntries('09_X3LIUS_MUSIC', 5_000)
      .filter(
        (e) =>
          e.vaultPath.startsWith('09_X3LIUS_MUSIC/LYRICS/LYR-') &&
          e.frontmatter.lineage_id === input.lineageId,
      );
    const nextVer =
      existing.length === 0
        ? 1
        : Math.max(...existing.map((e) => Number(e.frontmatter.version ?? 0))) + 1;

    const id = `lyr-${slugify(input.lineageId)}-v${nextVer}`;
    const vaultPath = `09_X3LIUS_MUSIC/LYRICS/LYR-${slugify(input.lineageId)}-v${nextVer}.md`;

    const renderedSections = input.sections
      .map((s) => `## [${s.label}]\n${s.lines.join('\n')}`)
      .join('\n\n');

    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.lyric/v3',
        id,
        lineage_id: input.lineageId,
        song_id: songId,
        song_ref: songEntry.vaultPath,
        structure_ref: input.structureRef ?? null,
        type: 'lyric',
        title: `${input.title.trim()} (v${nextVer})`,
        domain: 'RECORDS',
        sector: '09_X3LIUS_MUSIC',
        author: input.author ?? 'x3lius-lyrics',
        language: input.language.trim(),
        status: 'draft',
        version: nextVer,
        immutable_revision: true,
        mixed_script_checked: true,
        tags: ['xyp3rn', 'os3', 'x3lius', 'lyrics'],
      },
      `# ${input.title.trim()} — v${nextVer}\n\n${renderedSections}`,
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor: input.author ?? 'x3lius-lyrics',
      writeMode: 'reject-overwrite',
      reason: `Create immutable lyric version v${nextVer}`,
    });

    return {
      id,
      lineageId: input.lineageId,
      songId,
      version: nextVer,
      vaultPath: written.vaultPath,
      sha256: written.sha256,
    };
  }

  requestCreativeApproval(input: {
    readonly artifactPathOrId: string;
    readonly proposer: string;
  }) {
    const entry = this.#findEntry(input.artifactPathOrId, '09_X3LIUS_MUSIC/');
    if (!entry) throw new Error(`Creative artifact/lyric not found: "${input.artifactPathOrId}"`);
    const artifactId = String(entry.frontmatter.id);
    return this.#db.queueApproval({
      itemType: 'artifact_version',
      itemId: artifactId,
      proposer: input.proposer,
      request: {
        artifactId,
        vaultPath: entry.vaultPath,
        lineageId: entry.frontmatter.lineage_id ?? null,
        version: entry.frontmatter.version ?? 1,
      },
    });
  }

  async approveCreativeVersion(input: {
    readonly artifactPathOrId: string;
    readonly approvalId: string;
    readonly approver: string;
    readonly reason: string;
  }) {
    const approval = this.#db.getApproval(input.approvalId);
    if (!approval) throw new Error(`Approval not found: "${input.approvalId}"`);
    if (input.approver.trim().toLowerCase() === approval.proposer.trim().toLowerCase()) {
      throw new Error(`Security violation: proposer "${approval.proposer}" cannot approve own creative version`);
    }

    const entry = this.#findEntry(input.artifactPathOrId, '09_X3LIUS_MUSIC/');
    if (!entry) throw new Error(`Creative artifact not found: "${input.artifactPathOrId}"`);

    const decided =
      approval.status === 'pending'
        ? this.#db.decideApproval({
            approvalId: approval.id,
            decision: 'approved',
            approver: input.approver,
            reason: input.reason,
          })
        : approval;

    if (decided.status !== 'approved') {
      throw new Error(`Approval "${approval.id}" is "${decided.status}", not approved`);
    }

    // Write separate immutable Approval Pointer record instead of overwriting immutable lyric text
    const artId = String(entry.frontmatter.id);
    const lineageId = String(entry.frontmatter.lineage_id ?? artId);
    const ptrPath = `09_X3LIUS_MUSIC/EVALUATION/APPR-${slugify(artId)}.md`;
    const ptrContent = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.approval/v3',
        id: `appr-${slugify(artId)}`,
        type: 'approval',
        title: `Creative Approval: ${artId}`,
        domain: 'RECORDS',
        sector: '09_X3LIUS_MUSIC',
        status: 'approved',
        version: 1,
        item_type: 'artifact_version',
        item_id: artId,
        lineage_id: lineageId,
        artifact_ref: entry.vaultPath,
        artifact_sha256: entry.sha256,
        approval_id: decided.id,
        proposer: decided.proposer,
        approver: decided.approver,
        reason: decided.reason,
        tags: ['xyp3rn', 'os3', 'x3lius', 'creative-approval'],
      },
      `# Creative Approval for \`${artId}\`\n\n- **Artifact:** [[${entry.vaultPath.replace(/\.md$/, '')}|${artId}]]\n- **Approved By:** \`${decided.approver}\``,
    );

    const written = await this.#vault.write({
      vaultPath: ptrPath,
      content: ptrContent,
      actor: input.approver,
      writeMode: 'no-overwrite',
      reason: `Record creative approval pointer for ${artId}`,
    });

    return { approval: decided, pointerWrite: written };
  }

  async writeCreativeArtifact(input: {
    readonly subdomain: X3liusDomain;
    readonly slug: string;
    readonly title: string;
    readonly body: string;
    readonly upstreamRefs?: readonly string[] | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
    readonly actor?: string | undefined;
  }) {
    const dir = SUBDOMAIN_TO_DIR[input.subdomain] ?? '09_X3LIUS_MUSIC/TAKES';
    const existing = this.#db
      .listIndexEntries('09_X3LIUS_MUSIC', 5_000)
      .filter((e) => e.vaultPath.startsWith(`${dir}/ART-${slugify(input.slug)}-v`));
    const ver = existing.length + 1;
    const id = `art-${slugify(input.slug)}-v${ver}`;
    const vaultPath = `${dir}/ART-${slugify(input.slug)}-v${ver}.md`;

    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id,
        type: 'creative_artifact',
        subdomain: input.subdomain,
        title: input.title.trim(),
        domain: 'RECORDS',
        sector: '09_X3LIUS_MUSIC',
        status: 'draft',
        version: ver,
        upstream_refs: input.upstreamRefs ? [...input.upstreamRefs] : [],
        ...(input.metadata ?? {}),
        tags: ['xyp3rn', 'os3', 'x3lius', `subdomain/${input.subdomain}`],
      },
      `# ${input.title.trim()} (v${ver})\n\n${input.body.trim()}`,
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor: input.actor ?? `x3lius-${input.subdomain}`,
      writeMode: 'reject-overwrite',
      reason: `Create creative artifact ${id}`,
    });

    return { id, subdomain: input.subdomain, version: ver, ...written };
  }

  // ─── 3. Production Sessions, AI Generation Attempts, Takes, Critiques & Revisions ─

  async recordProductionSession(input: {
    readonly songPathOrId: string;
    readonly dawOrEnvironment: string;
    readonly notes: string;
    readonly vocalDnaRef?: string | undefined;
    readonly actor?: string | undefined;
  }) {
    const songEntry = this.#findEntry(input.songPathOrId, '09_X3LIUS_MUSIC/SONGS/');
    if (!songEntry) throw new Error(`Song not found: "${input.songPathOrId}"`);
    const shortId = randomUUID().slice(0, 8);
    const id = `psess-${shortId}`;
    const vaultPath = `09_X3LIUS_MUSIC/TAKES/PSESS-${shortId}.md`;

    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id,
        type: 'production_session',
        title: `Production Session ${id}: ${songEntry.title}`,
        domain: 'RECORDS',
        sector: '09_X3LIUS_MUSIC',
        song_id: songEntry.frontmatter.id,
        song_ref: songEntry.vaultPath,
        vocal_dna_ref: input.vocalDnaRef ?? null,
        environment: input.dawOrEnvironment,
        status: 'live',
        version: 1,
        tags: ['xyp3rn', 'os3', 'production-session'],
      },
      `# Production Session \`${id}\`\n\n- **Environment:** ${input.dawOrEnvironment}\n\n${input.notes.trim()}`,
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor: input.actor ?? 'x3lius-production',
      writeMode: 'reject-overwrite',
    });

    return { id, ...written };
  }

  async recordGenerationAttemptAndTake(input: {
    readonly attemptId?: string | undefined;
    readonly takeId?: string | undefined;
    readonly songPathOrId: string;
    readonly sunoModel: string;
    readonly stylePrompt: string;
    readonly promptText: string;
    readonly audioSha256?: string | undefined;
    readonly lyricRef?: string | undefined;
    readonly styleRecipeRef?: string | undefined;
    readonly adapter?: 'manual' | 'sunoapi' | undefined;
    readonly audioAttachmentRef?: string | undefined;
    readonly actor?: string | undefined;
  }) {
    if (!input.sunoModel.trim() || !input.promptText.trim()) {
      throw new Error('Generation attempt requires non-empty sunoModel and promptText for AI provenance');
    }
    const songEntry = this.#findEntry(input.songPathOrId, '09_X3LIUS_MUSIC/SONGS/');
    if (!songEntry) throw new Error(`Song not found: "${input.songPathOrId}"`);
    const songId = String(songEntry.frontmatter.id);

    const shortId = randomUUID().slice(0, 8);
    const attemptId = input.attemptId?.trim() || `gtry-${shortId}`;
    const takeId = input.takeId?.trim() || `take-${shortId}`;
    const packageSha256 = sha256Hex(`${input.sunoModel}\n${input.stylePrompt}\n${input.promptText}`);

    // 1. Write Generation Attempt (provenance envelope)
    const attemptPath = `09_X3LIUS_MUSIC/SUNO_PACKAGES/GTRY-${attemptId.replace(/^gtry-/, '')}.md`;
    const attemptContent = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id: attemptId,
        type: 'generation_attempt',
        title: `Generation Attempt ${attemptId} (${input.sunoModel})`,
        domain: 'RECORDS',
        sector: '09_X3LIUS_MUSIC',
        song_id: songId,
        suno_model: input.sunoModel.trim(),
        adapter: input.adapter ?? 'manual',
        package_sha256: packageSha256,
        style_prompt: input.stylePrompt.trim(),
        lyric_ref: input.lyricRef ?? null,
        style_recipe_ref: input.styleRecipeRef ?? null,
        status: 'approved',
        version: 1,
        tags: ['xyp3rn', 'os3', 'generation-attempt', `model/${input.sunoModel.trim()}`],
      },
      `# Generation Attempt \`${attemptId}\`\n\n- **Model:** \`${input.sunoModel.trim()}\`\n- **Package SHA-256:** \`${packageSha256}\`\n\n## Prompt\n\n\`\`\`text\n${input.promptText.trim()}\n\`\`\``,
    );

    const attemptWritten = await this.#vault.write({
      vaultPath: attemptPath,
      content: attemptContent,
      actor: input.actor ?? 'suno-submitter',
      writeMode: 'reject-overwrite',
    });

    // 2. Write Take with full back-linked AI provenance
    const takePath = `09_X3LIUS_MUSIC/TAKES/TAKE-${takeId.replace(/^take-/, '')}.md`;
    const takeContent = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id: takeId,
        type: 'take',
        title: `Take ${takeId}: ${songEntry.title}`,
        domain: 'RECORDS',
        sector: '09_X3LIUS_MUSIC',
        song_id: songId,
        generation_attempt_id: attemptId,
        generation_attempt_ref: attemptWritten.vaultPath,
        suno_model: input.sunoModel.trim(),
        package_sha256: packageSha256,
        style_prompt: input.stylePrompt.trim(),
        prompt_text: input.promptText.trim(),
        audio_sha256: input.audioSha256 ?? null,
        audio_ref: input.audioAttachmentRef ?? null,
        status: 'draft',
        version: 1,
        tags: ['xyp3rn', 'os3', 'take', 'ai-generated'],
      },
      `# Audio Take \`${takeId}\`\n\n- **Provenance:** [[${attemptWritten.vaultPath.replace(/\.md$/, '')}|${attemptId}]] (\`${input.sunoModel.trim()}\`)\n- **Song:** [[${songEntry.vaultPath.replace(/\.md$/, '')}|${songId}]]`,
    );

    const takeWritten = await this.#vault.write({
      vaultPath: takePath,
      content: takeContent,
      actor: input.actor ?? 'suno-submitter',
      writeMode: 'reject-overwrite',
    });

    return {
      attemptId,
      takeId,
      sunoModel: input.sunoModel.trim(),
      packageSha256,
      attemptPath: attemptWritten.vaultPath,
      takePath: takeWritten.vaultPath,
    };
  }

  async recordCritiqueAndRevision(input: {
    readonly targetPathOrId: string;
    readonly overallScore: number;
    readonly findings: readonly string[];
    readonly revisionSummary: string;
    readonly criticActor?: string | undefined;
    readonly revisionActor?: string | undefined;
  }) {
    const target = this.#findEntry(input.targetPathOrId, '09_X3LIUS_MUSIC/');
    if (!target) throw new Error(`Target artifact/take not found: "${input.targetPathOrId}"`);

    const shortId = randomUUID().slice(0, 8);
    const critiqueId = `crit-${shortId}`;
    const critiquePath = `09_X3LIUS_MUSIC/EVALUATION/CRIT-${shortId}.md`;

    const critContent = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id: critiqueId,
        type: 'critique',
        title: `Critique ${critiqueId} on ${String(target.frontmatter.id)}`,
        domain: 'RECORDS',
        sector: '09_X3LIUS_MUSIC',
        target_ref: target.vaultPath,
        target_id: target.frontmatter.id,
        overall_score: input.overallScore,
        findings: [...input.findings],
        status: 'approved',
        version: 1,
        tags: ['xyp3rn', 'os3', 'critique'],
      },
      `# Critique \`${critiqueId}\`\n\n- **Overall Score:** ${input.overallScore}\n- **Target:** [[${target.vaultPath.replace(/\.md$/, '')}]]\n\n## Findings\n${input.findings.map((f) => `- ${f}`).join('\n')}`,
    );

    const critWritten = await this.#vault.write({
      vaultPath: critiquePath,
      content: critContent,
      actor: input.criticActor ?? 'x3lius-evaluation',
      writeMode: 'reject-overwrite',
    });

    const revId = `rev-${shortId}`;
    const revPath = `09_X3LIUS_MUSIC/EVALUATION/REV-${shortId}.md`;
    const revContent = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id: revId,
        type: 'revision',
        title: `Revision ${revId} answering ${critiqueId}`,
        domain: 'RECORDS',
        sector: '09_X3LIUS_MUSIC',
        critique_id: critiqueId,
        critique_ref: critWritten.vaultPath,
        target_ref: target.vaultPath,
        status: 'approved',
        version: 1,
        tags: ['xyp3rn', 'os3', 'revision'],
      },
      `# Revision \`${revId}\`\n\nAddresses [[${critWritten.vaultPath.replace(/\.md$/, '')}|${critiqueId}]]:\n\n${input.revisionSummary.trim()}`,
    );

    const revWritten = await this.#vault.write({
      vaultPath: revPath,
      content: revContent,
      actor: input.revisionActor ?? 'x3lius-revision',
      writeMode: 'reject-overwrite',
    });

    return { critiqueId, revisionId: revId, critiquePath: critWritten.vaultPath, revisionPath: revWritten.vaultPath };
  }

  // ─── 4. Catalog: Releases, Tracks, ISRC/UPC Assignments, Rights Splits, Calendar ──

  async createRelease(input: {
    readonly id?: string | undefined;
    readonly title: string;
    readonly artist: string;
    readonly kind: 'single' | 'ep' | 'album';
    readonly actor?: string | undefined;
  }) {
    const id = input.id?.trim() || `rel-${randomUUID().slice(0, 8)}`;
    const vaultPath = `06_RECORDS/RELEASES/REL-${id.replace(/^rel-/, '')}-${slugify(input.title)}.md`;
    if (this.#findByEntityId(id)) {
      throw new Error(`Duplicate release ID "${id}"`);
    }

    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.release/v3',
        id,
        type: 'release',
        title: input.title.trim(),
        domain: 'RECORDS',
        sector: '06_RECORDS',
        artist: input.artist.trim(),
        kind: input.kind,
        upc: null,
        status: 'draft',
        version: 1,
        release_date: null,
        rights_check_run_id: null,
        release_history: [],
        tracks: [],
        tags: ['xyp3rn', 'os3', 'release'],
      },
      `# Release: ${input.title.trim()}\n\n- **Artist:** ${input.artist.trim()}\n- **Kind:** \`${input.kind}\`\n- **Status:** \`draft\``,
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor: input.actor ?? 'records-catalog',
      writeMode: 'reject-overwrite',
      reason: `Create draft release ${id}`,
    });

    return { id, ...written };
  }

  async registerTrack(input: {
    readonly id?: string | undefined;
    readonly releasePathOrId: string;
    readonly position: number;
    readonly title: string;
    readonly songId?: string | undefined;
    readonly takePathOrId?: string | undefined;
    readonly sourceRef?: string | undefined;
    readonly actor?: string | undefined;
  }) {
    if (!Number.isInteger(input.position) || input.position <= 0) {
      throw new Error('Track position must be a positive integer');
    }
    if (Boolean(input.takePathOrId) === Boolean(input.sourceRef)) {
      throw new Error('registerTrack requires exactly one of takePathOrId or sourceRef');
    }

    const relEntry = this.#findEntry(input.releasePathOrId, '06_RECORDS/RELEASES/');
    if (!relEntry) throw new Error(`Release not found: "${input.releasePathOrId}"`);
    if (relEntry.frontmatter.status !== 'draft') {
      throw new Error(
        `Catalog invariant violation: release "${String(relEntry.frontmatter.id)}" is "${String(relEntry.frontmatter.status)}"; tracks may only be added to draft releases`,
      );
    }

    const releaseId = String(relEntry.frontmatter.id);
    const trackId = input.id?.trim() || `trk-${randomUUID().slice(0, 8)}`;
    if (this.#findByEntityId(trackId)) {
      throw new Error(`Duplicate track ID "${trackId}"`);
    }

    const recordingRef = input.takePathOrId ?? input.sourceRef!;
    // Prevent duplicate track position or duplicate recording on same release
    const existingTracks = this.#listTracksForRelease(releaseId);
    if (existingTracks.some((t) => Number(t.frontmatter.position) === input.position)) {
      throw new Error(
        `Duplicate catalog assignment: release "${releaseId}" already has a track at position ${input.position}`,
      );
    }
    if (existingTracks.some((t) => t.frontmatter.recording_ref === recordingRef)) {
      throw new Error(
        `Duplicate catalog assignment: recording "${recordingRef}" is already registered on release "${releaseId}"`,
      );
    }

    const takeEntry = input.takePathOrId ? this.#findEntry(input.takePathOrId, '09_X3LIUS_MUSIC/TAKES/') : null;
    const vaultPath = `06_RECORDS/TRACKS/TRK-${trackId.replace(/^trk-/, '')}-${slugify(input.title)}.md`;
    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.track/v3',
        id: trackId,
        type: 'track',
        title: input.title.trim(),
        domain: 'RECORDS',
        sector: '06_RECORDS',
        release_id: releaseId,
        release_ref: relEntry.vaultPath,
        song_id: input.songId ?? (takeEntry?.frontmatter.song_id ? String(takeEntry.frontmatter.song_id) : null),
        position: input.position,
        isrc: null,
        recording_kind: input.takePathOrId ? 'suno_take' : 'vault_audio',
        recording_ref: recordingRef,
        take_id: takeEntry ? String(takeEntry.frontmatter.id) : input.takePathOrId ?? null,
        source_path: input.sourceRef ?? null,
        status: 'draft',
        version: 1,
        tags: ['xyp3rn', 'os3', 'track'],
      },
      `# Track ${input.position}: ${input.title.trim()}\n\n- **Release:** [[${relEntry.vaultPath.replace(/\.md$/, '')}|${releaseId}]]\n- **Recording:** \`${recordingRef}\``,
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor: input.actor ?? 'records-catalog',
      writeMode: 'reject-overwrite',
      reason: `Register track ${trackId} on release ${releaseId}`,
    });

    return { id: trackId, releaseId, position: input.position, ...written };
  }

  /**
   * Assigns an ISRC to a Track (write-once, ISO 3901 validated, globally unique).
   */
  async assignIsrc(input: {
    readonly trackPathOrId: string;
    readonly isrc: string;
    readonly actor?: string | undefined;
  }) {
    const cleanIsrc = input.isrc.trim().toUpperCase();
    if (!isValidIsrcCode(cleanIsrc)) {
      throw new Error(`Invalid ISRC format "${cleanIsrc}": must match ISO 3901 (CCXXXYYNNNNN)`);
    }

    const trackEntry = this.#findEntry(input.trackPathOrId, '06_RECORDS/TRACKS/TRK-');
    if (!trackEntry) throw new Error(`Track not found: "${input.trackPathOrId}"`);
    const trackId = String(trackEntry.frontmatter.id);

    const doc = await this.#vault.read(trackEntry.vaultPath);
    if (typeof doc.frontmatter.isrc === 'string' && doc.frontmatter.isrc.trim().length > 0) {
      throw new Error(
        `Catalog invariant violation: track "${trackId}" already has ISRC "${doc.frontmatter.isrc}"; an assigned ISRC never changes`,
      );
    }

    // Prevent duplicate ISRC across catalog
    const allTracks = this.#db
      .listIndexEntries('06_RECORDS', 5_000)
      .filter((e) => e.vaultPath.startsWith('06_RECORDS/TRACKS/TRK-'));
    if (allTracks.some((t) => t.frontmatter.isrc === cleanIsrc)) {
      throw new Error(`Duplicate catalog assignment: ISRC "${cleanIsrc}" is already assigned`);
    }

    const updatedTrack = await this.#vault.update({
      vaultPath: doc.vaultPath,
      content: serializeFrontmatterDocument({ ...doc.frontmatter, isrc: cleanIsrc }, doc.body),
      actor: input.actor ?? 'records-catalog',
      expectedSha256: doc.sha256,
      reason: `Assign ISRC ${cleanIsrc} to track ${trackId}`,
    });

    // Record explicit ISRC Assignment entity
    const assignId = `isrc-${cleanIsrc.toLowerCase()}`;
    const assignPath = `06_RECORDS/TRACKS/ISRC-${cleanIsrc}.md`;
    await this.#vault.write({
      vaultPath: assignPath,
      content: serializeFrontmatterDocument(
        {
          schema: 'xyp3rn.entity/v3',
          id: assignId,
          type: 'isrc_assignment',
          title: `ISRC Assignment ${cleanIsrc}`,
          domain: 'RECORDS',
          sector: '06_RECORDS',
          track_id: trackId,
          track_ref: doc.vaultPath,
          isrc: cleanIsrc,
          status: 'approved',
          version: 1,
          tags: ['xyp3rn', 'os3', 'isrc'],
        },
        `# ISRC Assignment \`${cleanIsrc}\`\n\nAssigned immutably to [[${doc.vaultPath.replace(/\.md$/, '')}|${trackId}]].`,
      ),
      actor: input.actor ?? 'records-catalog',
      writeMode: 'reject-overwrite',
    });

    return { trackId, isrc: cleanIsrc, assignmentPath: assignPath, ...updatedTrack };
  }

  /**
   * Assigns a UPC to a Release (write-once, GS1 mod-10 validated, globally unique).
   */
  async assignUpc(input: {
    readonly releasePathOrId: string;
    readonly upc: string;
    readonly actor?: string | undefined;
  }) {
    const cleanUpc = input.upc.trim();
    if (!isValidGs1Code(cleanUpc)) {
      throw new Error(`Invalid GS1 UPC/EAN check digit or length for "${cleanUpc}"`);
    }

    const relEntry = this.#findEntry(input.releasePathOrId, '06_RECORDS/RELEASES/REL-');
    if (!relEntry) throw new Error(`Release not found: "${input.releasePathOrId}"`);
    const releaseId = String(relEntry.frontmatter.id);

    const doc = await this.#vault.read(relEntry.vaultPath);
    if (typeof doc.frontmatter.upc === 'string' && doc.frontmatter.upc.trim().length > 0) {
      throw new Error(
        `Catalog invariant violation: release "${releaseId}" already has UPC "${doc.frontmatter.upc}"; an assigned UPC never changes`,
      );
    }

    const allReleases = this.#db
      .listIndexEntries('06_RECORDS', 5_000)
      .filter((e) => e.vaultPath.startsWith('06_RECORDS/RELEASES/REL-'));
    if (allReleases.some((r) => r.frontmatter.upc === cleanUpc)) {
      throw new Error(`Duplicate catalog assignment: UPC "${cleanUpc}" is already assigned`);
    }

    const updatedRelease = await this.#vault.update({
      vaultPath: doc.vaultPath,
      content: serializeFrontmatterDocument({ ...doc.frontmatter, upc: cleanUpc }, doc.body),
      actor: input.actor ?? 'records-catalog',
      expectedSha256: doc.sha256,
      reason: `Assign UPC ${cleanUpc} to release ${releaseId}`,
    });

    const assignId = `upc-${cleanUpc}`;
    const assignPath = `06_RECORDS/RELEASES/UPC-${cleanUpc}.md`;
    await this.#vault.write({
      vaultPath: assignPath,
      content: serializeFrontmatterDocument(
        {
          schema: 'xyp3rn.entity/v3',
          id: assignId,
          type: 'upc_assignment',
          title: `UPC Assignment ${cleanUpc}`,
          domain: 'RECORDS',
          sector: '06_RECORDS',
          release_id: releaseId,
          release_ref: doc.vaultPath,
          upc: cleanUpc,
          status: 'approved',
          version: 1,
          tags: ['xyp3rn', 'os3', 'upc'],
        },
        `# UPC Assignment \`${cleanUpc}\`\n\nAssigned immutably to [[${doc.vaultPath.replace(/\.md$/, '')}|${releaseId}]].`,
      ),
      actor: input.actor ?? 'records-catalog',
      writeMode: 'reject-overwrite',
    });

    return { releaseId, upc: cleanUpc, assignmentPath: assignPath, ...updatedRelease };
  }

  /**
   * Writes a new versioned Rights Split Set for a Track using exact thousandths math (must sum to 100.000%).
   */
  async writeRightsSplits(input: {
    readonly trackPathOrId: string;
    readonly shares: readonly SplitShareInput[];
    readonly actor?: string | undefined;
  }) {
    if (input.shares.length === 0) {
      throw new Error('Rights split set must contain at least one share');
    }

    const trackEntry = this.#findEntry(input.trackPathOrId, '06_RECORDS/TRACKS/TRK-');
    if (!trackEntry) throw new Error(`Track not found: "${input.trackPathOrId}"`);
    const trackId = String(trackEntry.frontmatter.id);

    const { unassignedMilli, hasUnassigned } = validateRightsSharesMilli(input.shares);
    const existingSets = this.#db
      .listIndexEntries('06_RECORDS', 5_000)
      .filter(
        (e) =>
          e.vaultPath.startsWith('06_RECORDS/RIGHTS/SPLT-') &&
          e.frontmatter.track_id === trackId,
      );
    const nextVersion =
      existingSets.length === 0
        ? 1
        : Math.max(...existingSets.map((e) => Number(e.frontmatter.version ?? 0))) + 1;

    const id = `splt-${trackId.replace(/^trk-/, '')}-v${nextVersion}`;
    const vaultPath = `06_RECORDS/RIGHTS/SPLT-${trackId.replace(/^trk-/, '')}-v${nextVersion}.md`;

    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.rights-split/v3',
        id,
        type: 'rights_split',
        title: `Rights Splits: ${trackEntry.title} (v${nextVersion})`,
        domain: 'RECORDS',
        sector: '06_RECORDS',
        track_id: trackId,
        track_ref: trackEntry.vaultPath,
        status: hasUnassigned ? 'draft' : 'approved',
        version: nextVersion,
        total_percentage: 100.0,
        has_unassigned_share: hasUnassigned,
        unassigned_percentage: unassignedMilli / 1000,
        shares: input.shares,
        tags: ['xyp3rn', 'os3', 'rights-split'],
      },
      [
        `# Rights Splits: ${trackEntry.title} (v${nextVersion})`,
        '',
        ...input.shares.map((s) => `- **${s.payee ?? 'UNASSIGNED'}:** ${s.percentage}% (${s.role})`),
      ].join('\n'),
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor: input.actor ?? 'records-catalog',
      writeMode: 'reject-overwrite',
      reason: `Write versioned rights split v${nextVersion} for ${trackId}`,
    });

    return { id, trackId, version: nextVersion, hasUnassigned, ...written };
  }

  /**
   * Executes the deterministic `records-rights-splits` Governance check over Vault state
   * and records an official `agent_runs` verdict in `SqliteRuntimeDb`.
   */
  runRightsCheck(releasePathOrId: string): { readonly runId: string; readonly verdict: RightsVerdict } {
    const relEntry = this.#findEntry(releasePathOrId, '06_RECORDS/RELEASES/REL-');
    if (!relEntry) throw new Error(`Release not found: "${releasePathOrId}"`);
    const releaseId = String(relEntry.frontmatter.id);

    const trackEntries = this.#listTracksForRelease(releaseId);
    const allSplits = this.#db
      .listIndexEntries('06_RECORDS', 5_000)
      .filter((e) => e.vaultPath.startsWith('06_RECORDS/RIGHTS/SPLT-'));

    const catalogRecord: CatalogRecord = {
      release: {
        id: releaseId,
        title: relEntry.title,
        artist: String(relEntry.frontmatter.artist ?? ''),
        kind: String(relEntry.frontmatter.kind ?? 'single'),
        upc: (relEntry.frontmatter.upc as string | null) ?? null,
        status: (relEntry.frontmatter.status as ReleaseStatus) ?? 'draft',
        releaseDate: (relEntry.frontmatter.release_date as string | null) ?? null,
        rightsCheckRunId: (relEntry.frontmatter.rights_check_run_id as string | null) ?? null,
      },
      tracks: trackEntries.map((t) => {
        const tId = String(t.frontmatter.id);
        const trackSplits = allSplits
          .filter((s) => s.frontmatter.track_id === tId)
          .sort((a, b) => Number(b.frontmatter.version ?? 0) - Number(a.frontmatter.version ?? 0));
        const latest = trackSplits[0];
        const shares = latest && Array.isArray(latest.frontmatter.shares)
          ? (latest.frontmatter.shares as SplitShareInput[])
          : null;

        return {
          id: tId,
          position: Number(t.frontmatter.position),
          title: t.title,
          isrc: (t.frontmatter.isrc as string | null) ?? null,
          takeId: t.frontmatter.recording_kind === 'suno_take' ? String(t.frontmatter.recording_ref ?? '') : null,
          sourceId: t.frontmatter.recording_kind !== 'suno_take' ? String(t.frontmatter.recording_ref ?? '') : null,
          mixReportArtifactId: null,
          splits: latest && shares
            ? {
                version: Number(latest.frontmatter.version ?? 1),
                rows: shares.map((s) => ({ payee: s.payee, percentage: Number(s.percentage) })),
              }
            : null,
        };
      }),
    };

    const verdict = checkRights(catalogRecord);
    const run = this.#db.startAgentRun({
      agentName: 'records-rights-splits',
      class: 'Governance',
      domain: 'RECORDS',
      model: 'none',
      input: { releaseId },
    });
    this.#db.completeAgentRun(run.id, {
      output: { result: verdict, logs: [] },
      tokensUsed: 0,
      latencyMs: 1,
    });

    return { runId: run.id, verdict };
  }

  /**
   * Release Calendar scheduling & release transitions, preserving full `release_history[]`
   * and enforcing all OS2 scheduling guard rules (`draft <-> scheduled -> released`).
   */
  async transitionReleaseCalendar(input: {
    readonly releasePathOrId: string;
    readonly action: 'schedule' | 'unschedule' | 'release';
    readonly releaseDate?: string | undefined;
    readonly rightsCheckRunId?: string | undefined;
    readonly actor?: string | undefined;
    readonly todayIso?: string | undefined;
  }) {
    const relEntry = this.#findEntry(input.releasePathOrId, '06_RECORDS/RELEASES/REL-');
    if (!relEntry) throw new Error(`Release not found: "${input.releasePathOrId}"`);
    const doc = await this.#vault.read(relEntry.vaultPath);
    const fm = doc.frontmatter as Record<string, unknown>;
    const releaseId = String(fm.id);
    const curStatus = (fm.status as ReleaseStatus) ?? 'draft';
    const today = (input.todayIso ?? new Date().toISOString().slice(0, 10)).slice(0, 10);

    let nextStatus: ReleaseStatus;
    let nextDate = (fm.release_date as string | null) ?? null;
    let checkRunId = (fm.rights_check_run_id as string | null) ?? null;

    if (input.action === 'schedule') {
      if (curStatus !== 'draft') {
        throw new Error(`Release "${releaseId}" cannot move from "${curStatus}" to "scheduled"`);
      }
      if (!input.releaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.releaseDate)) {
        throw new Error('Scheduling requires YYYY-MM-DD releaseDate');
      }
      if (input.releaseDate < today) {
        throw new Error(`Release "${releaseId}" cannot be scheduled for ${input.releaseDate} (in the past)`);
      }
      if (!input.rightsCheckRunId) {
        throw new Error(`Release "${releaseId}" needs a passing records-rights-splits run to be scheduled`);
      }

      // Verify passing agent_runs row AND live re-check splits on disk
      const runRow = this.#db.getAgentRun(input.rightsCheckRunId);
      const outObj = (runRow?.output as { readonly result?: RightsVerdict } | null)?.result;
      if (
        !runRow ||
        runRow.agentName !== 'records-rights-splits' ||
        runRow.status !== 'success' ||
        outObj?.verdict !== 'pass' ||
        outObj?.releaseId !== releaseId
      ) {
        throw new Error(`Run "${input.rightsCheckRunId}" is not a passing records-rights-splits check of "${releaseId}"`);
      }

      const liveCheck = this.runRightsCheck(releaseId);
      if (liveCheck.verdict.verdict !== 'pass') {
        throw new Error(
          `Release "${releaseId}" failed live rights check: ${liveCheck.verdict.flags.map((f) => f.detail).join('; ')}`,
        );
      }

      nextStatus = 'scheduled';
      nextDate = input.releaseDate;
      checkRunId = input.rightsCheckRunId;
    } else if (input.action === 'unschedule') {
      if (curStatus !== 'scheduled') {
        throw new Error(`Release "${releaseId}" cannot unschedule from "${curStatus}"`);
      }
      nextStatus = 'draft';
    } else {
      if (curStatus !== 'scheduled') {
        throw new Error(`Release "${releaseId}" must be "scheduled" before releasing (currently "${curStatus}")`);
      }
      if (!nextDate || nextDate > today) {
        throw new Error(`Release "${releaseId}" cannot be released before its scheduled date ${String(nextDate)}`);
      }
      nextStatus = 'released';
    }

    const prevHistory = Array.isArray(fm.release_history) ? (fm.release_history as ReleaseHistoryEntry[]) : [];
    const nextHistory: ReleaseHistoryEntry[] = [
      ...prevHistory,
      {
        fromStatus: curStatus,
        toStatus: nextStatus,
        releaseDate: nextDate,
        rightsCheckRunId: checkRunId,
        actor: input.actor ?? 'records-release-calendar',
        at: new Date().toISOString(),
        reason: `Calendar action: ${input.action}`,
      },
    ];

    const updatedContent = serializeFrontmatterDocument(
      {
        ...fm,
        status: nextStatus,
        release_date: nextDate,
        rights_check_run_id: checkRunId,
        release_history: nextHistory,
      },
      doc.body,
    );

    const updated = await this.#vault.update({
      vaultPath: doc.vaultPath,
      content: updatedContent,
      actor: input.actor ?? 'records-release-calendar',
      expectedSha256: doc.sha256,
      reason: `Transition release ${releaseId}: ${curStatus} -> ${nextStatus}`,
    });

    return {
      releaseId,
      fromStatus: curStatus,
      status: nextStatus,
      releaseDate: nextDate,
      historyLength: nextHistory.length,
      ...updated,
    };
  }

  // ─── 5. Legacy Export Parity Verification & Reconciliation Report ──────────

  reconcileLegacyExports(legacy: LegacyRecordsExport): LegacyReconciliationReport {
    const allRec = this.#db.listIndexEntries('06_RECORDS', 10_000);
    const allMusic = this.#db.listIndexEntries('09_X3LIUS_MUSIC', 10_000);
    const discrepancies: string[] = [];

    // 1. Songs
    const songEntries = allMusic.filter((e) => e.vaultPath.startsWith('09_X3LIUS_MUSIC/SONGS/SONG-'));
    let matchedSongs = 0;
    for (const ls of legacy.songs) {
      const m = songEntries.find((e) => e.frontmatter.id === ls.id);
      if (!m) discrepancies.push(`Missing song "${ls.id}" (${ls.title}) in Vault`);
      else matchedSongs += 1;
    }

    // 2. Lyrics + Creative Approvals
    const lyricEntries = allMusic.filter((e) => e.vaultPath.startsWith('09_X3LIUS_MUSIC/LYRICS/LYR-'));
    const apprEntries = allMusic.filter((e) => e.vaultPath.startsWith('09_X3LIUS_MUSIC/EVALUATION/APPR-'));
    let matchedLyrics = 0;
    for (const ll of legacy.lyricVersions) {
      const m = lyricEntries.find(
        (e) => e.frontmatter.lineage_id === ll.lineageId && Number(e.frontmatter.version) === ll.version,
      );
      if (!m) {
        discrepancies.push(`Missing lyric version ${ll.lineageId} v${ll.version}`);
      } else if (ll.approved && !apprEntries.some((a) => a.frontmatter.item_id === m.frontmatter.id && a.frontmatter.status === 'approved')) {
        discrepancies.push(`Missing creative approval record for approved lyric ${ll.lineageId} v${ll.version}`);
      } else {
        matchedLyrics += 1;
      }
    }

    // 3. Tracks + ISRCs
    const trackEntries = allRec.filter((e) => e.vaultPath.startsWith('06_RECORDS/TRACKS/TRK-'));
    let matchedTracks = 0;
    for (const lt of legacy.tracks) {
      const m = trackEntries.find((e) => e.frontmatter.id === lt.id);
      if (!m) discrepancies.push(`Missing track "${lt.id}"`);
      else if ((m.frontmatter.isrc ?? null) !== lt.isrc) {
        discrepancies.push(`ISRC mismatch on track "${lt.id}": legacy=${String(lt.isrc)}, migrated=${String(m.frontmatter.isrc)}`);
      } else {
        matchedTracks += 1;
      }
    }

    // 4. Releases + UPCs + Status
    const releaseEntries = allRec.filter((e) => e.vaultPath.startsWith('06_RECORDS/RELEASES/REL-'));
    let matchedReleases = 0;
    for (const lr of legacy.releases) {
      const m = releaseEntries.find((e) => e.frontmatter.id === lr.id);
      if (!m) discrepancies.push(`Missing release "${lr.id}"`);
      else if ((m.frontmatter.upc ?? null) !== lr.upc || m.frontmatter.status !== lr.status) {
        discrepancies.push(`Release mismatch on "${lr.id}": upc/status differs from legacy export`);
      } else {
        matchedReleases += 1;
      }
    }

    // 5. Rights Splits
    const splitEntries = allRec.filter((e) => e.vaultPath.startsWith('06_RECORDS/RIGHTS/SPLT-'));
    let matchedSplits = 0;
    for (const lsp of legacy.splits) {
      const m = splitEntries.find(
        (e) => e.frontmatter.track_id === lsp.trackId && Number(e.frontmatter.version) === lsp.version,
      );
      if (!m) discrepancies.push(`Missing rights split ${lsp.trackId} v${lsp.version}`);
      else if (Number(m.frontmatter.total_percentage) !== lsp.sum || Boolean(m.frontmatter.has_unassigned_share) !== lsp.hasUnassigned) {
        discrepancies.push(`Rights split mismatch on ${lsp.trackId} v${lsp.version}`);
      } else {
        matchedSplits += 1;
      }
    }

    // 6. AI Takes + Provenance
    const takeEntries = allMusic.filter((e) => e.vaultPath.startsWith('09_X3LIUS_MUSIC/TAKES/TAKE-'));
    let matchedTakes = 0;
    for (const ltk of legacy.takes) {
      const m = takeEntries.find((e) => e.frontmatter.id === ltk.id);
      if (!m) discrepancies.push(`Missing AI take "${ltk.id}"`);
      else if (m.frontmatter.suno_model !== ltk.sunoModel || !m.frontmatter.generation_attempt_id) {
        discrepancies.push(`Missing AI provenance on take "${ltk.id}"`);
      } else {
        matchedTakes += 1;
      }
    }

    return {
      ok: discrepancies.length === 0,
      checkedAt: new Date().toISOString(),
      counts: {
        songs: { legacy: legacy.songs.length, migrated: songEntries.length, matched: matchedSongs },
        lyricVersions: { legacy: legacy.lyricVersions.length, migrated: lyricEntries.length, matched: matchedLyrics },
        tracks: { legacy: legacy.tracks.length, migrated: trackEntries.length, matched: matchedTracks },
        releases: { legacy: legacy.releases.length, migrated: releaseEntries.length, matched: matchedReleases },
        splits: { legacy: legacy.splits.length, migrated: splitEntries.length, matched: matchedSplits },
        takes: { legacy: legacy.takes.length, migrated: takeEntries.length, matched: matchedTakes },
      },
      discrepancies,
    };
  }

  // ─── 6. Extended X3LIUS + Records Catalog Domains (Phase 20) ────────────────

  get #opsCtx() {
    return { vault: this.#vault, db: this.#db };
  }

  createMusicProject(input: MusicProjectInput) {
    return opsCreateMusicProject(this.#opsCtx, input);
  }

  getAlbumContinuity(releasePathOrId: string): AlbumContinuityReport {
    return opsGetAlbumContinuity(this.#opsCtx, releasePathOrId);
  }

  registerContributor(input: ContributorInput) {
    return opsRegisterContributor(this.#opsCtx, input);
  }

  addContributorAlias(input: ContributorAliasInput) {
    return opsAddContributorAlias(this.#opsCtx, input);
  }

  writeCredit(input: CreditInput) {
    return opsWriteCredit(this.#opsCtx, input);
  }

  retractCredit(input: CreditRetractionInput) {
    return opsRetractCredit(this.#opsCtx, input);
  }

  recordMixVersion(input: MixVersionInput) {
    return opsRecordMixVersion(this.#opsCtx, input);
  }

  recordMasterVersion(input: MasterVersionInput) {
    return opsRecordMasterVersion(this.#opsCtx, input);
  }

  requestMasterApproval(input: { readonly masterPathOrId: string; readonly proposer: string }) {
    return opsRequestMasterApproval(this.#opsCtx, input);
  }

  approveMasterVersion(input: {
    readonly masterPathOrId: string;
    readonly approvalId: string;
    readonly approver: string;
    readonly reason: string;
  }) {
    return opsApproveMasterVersion(this.#opsCtx, input);
  }

  proposeRightsSplitChange(input: SplitProposalInput) {
    return opsProposeRightsSplitChange(this.#opsCtx, input);
  }

  applyApprovedSplitProposal(input: { readonly proposalId: string; readonly approver: string; readonly reason: string }) {
    return opsApplyApprovedSplitProposal(this.#opsCtx, {
      ...input,
      writeSplitsFn: (args) => this.writeRightsSplits(args),
    });
  }

  writePlatformLink(input: PlatformLinkInput) {
    return opsWritePlatformLink(this.#opsCtx, input);
  }

  retractPlatformLink(input: PlatformLinkRetractionInput) {
    return opsRetractPlatformLink(this.#opsCtx, input);
  }

  setReleaseArtwork(input: ReleaseArtworkInput) {
    return opsSetReleaseArtwork(this.#opsCtx, input);
  }

  recordReleaseDelivery(input: ReleaseDeliveryInput) {
    return opsRecordReleaseDelivery(this.#opsCtx, input);
  }

  linkSongTarget(input: SongLinkInput) {
    return opsLinkSongTarget(this.#opsCtx, input);
  }

  retractSongLink(input: SongLinkRetractionInput) {
    return opsRetractSongLink(this.#opsCtx, input);
  }

  computeCatalogReadinessChecks(releasePathOrId?: string): CatalogReadinessReport {
    return opsComputeCatalogReadinessChecks(this.#opsCtx, releasePathOrId);
  }

  #listTracksForRelease(releaseId: string) {
    return this.#db
      .listIndexEntries('06_RECORDS', 5_000)
      .filter(
        (e) =>
          e.vaultPath.startsWith('06_RECORDS/TRACKS/TRK-') &&
          e.frontmatter.release_id === releaseId,
      )
      .sort((a, b) => Number(a.frontmatter.position ?? 0) - Number(b.frontmatter.position ?? 0));
  }

  #findByEntityId(entityId: string) {
    return this.#db
      .listIndexEntries(undefined, 10_000)
      .find((e) => e.frontmatter.id === entityId);
  }

  #findEntry(pathOrId: string, prefix: string) {
    const clean = pathOrId.trim();
    const direct = this.#db.getIndexEntry(clean);
    if (direct) return direct;
    return (
      this.#db
        .listIndexEntries(undefined, 10_000)
        .find(
          (e) =>
            e.vaultPath.startsWith(prefix) &&
            (e.vaultPath === clean || e.frontmatter.id === clean || e.frontmatter.lineage_id === clean),
        ) ?? null
    );
  }
}
