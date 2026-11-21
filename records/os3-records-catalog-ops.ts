import { randomUUID } from 'node:crypto';
import type { SqliteRuntimeDb } from '../core/sqlite/client.ts';
import { serializeFrontmatterDocument } from '../core/vault-engine/frontmatter.ts';
import type { VaultEngine } from '../core/vault-engine/vault-engine.ts';
import {
  CREDIT_ROLES,
  DELIVERY_STATUSES,
  MUSIC_PROJECT_STATUSES,
  PLATFORM_NAMES,
  SONG_LINK_TYPES,
  isValidPlatformUrl,
  type AlbumContinuityReport,
  type CatalogReadinessCheck,
  type CatalogReadinessReport,
  type ContributorAliasInput,
  type ContributorInput,
  type CreditInput,
  type CreditRetractionInput,
  type MasterVersionInput,
  type MixVersionInput,
  type MusicProjectInput,
  type PlatformLinkInput,
  type PlatformLinkRetractionInput,
  type ReleaseArtworkInput,
  type ReleaseDeliveryInput,
  type SongLinkInput,
  type SongLinkRetractionInput,
  type SplitProposalInput,
} from './os3-records-types.ts';

export type CatalogOpsContext = {
  readonly vault: VaultEngine;
  readonly db: SqliteRuntimeDb;
};

export const milli = (n: number): number => Math.round(n * 1000);

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';

const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp)$/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

export const validateRightsSharesMilli = (
  shares: readonly { readonly payee: string | null; readonly role: string; readonly percentage: number }[],
): { readonly totalMilli: number; readonly unassignedMilli: number; readonly hasUnassigned: boolean } => {
  if (shares.length === 0) {
    throw new Error('Rights split set must contain at least one share');
  }
  const seenPayees = new Set<string>();
  let totalMilli = 0;
  let unassignedMilli = 0;
  for (const s of shares) {
    if (!Number.isFinite(s.percentage) || s.percentage <= 0 || s.percentage > 100) {
      throw new Error(`Invalid split percentage ${String(s.percentage)} (must be > 0 and <= 100)`);
    }
    if (!s.role || s.role.trim().length === 0) {
      throw new Error('Split share role must be a non-empty string');
    }
    const payeeKey = s.payee === null ? '__UNASSIGNED__' : s.payee.trim().toLowerCase();
    if (s.payee !== null && s.payee.trim().length === 0) {
      throw new Error('Split share payee must be non-empty string or null (unassigned)');
    }
    if (seenPayees.has(payeeKey)) {
      throw new Error(`Duplicate payee "${String(s.payee)}" inside same split set`);
    }
    seenPayees.add(payeeKey);
    const m = milli(s.percentage);
    totalMilli += m;
    if (s.payee === null) unassignedMilli += m;
  }
  if (totalMilli !== 100_000) {
    throw new Error(`Rights split total must equal exactly 100.000% (got ${totalMilli / 1000}%)`);
  }
  return { totalMilli, unassignedMilli, hasUnassigned: unassignedMilli > 0 };
};

export const assertSafeRelativeAssetPath = (rawPath: string): string => {
  const clean = rawPath.trim().replace(/\\/g, '/');
  if (!clean) throw new Error('Asset path must be non-empty');
  if (clean.startsWith('/') || WINDOWS_DRIVE_RE.test(rawPath.trim()) || clean.split('/').includes('..')) {
    throw new Error(`Unsafe asset path rejected: "${rawPath}" (must be relative without ".." traversal)`);
  }
  return clean;
};

const findByPrefixOrId = (db: SqliteRuntimeDb, pathOrId: string, prefixes: readonly string[]) => {
  const clean = pathOrId.trim();
  const direct = db.getIndexEntry(clean);
  if (direct && prefixes.some((p) => direct.vaultPath.startsWith(p))) return direct;
  return (
    db
      .listIndexEntries(undefined, 15_000)
      .find(
        (e) =>
          prefixes.some((p) => e.vaultPath.startsWith(p)) &&
          (e.vaultPath === clean || e.frontmatter.id === clean || e.frontmatter.lineage_id === clean),
      ) ?? null
  );
};

const findAnyEntityById = (db: SqliteRuntimeDb, entityId: string) =>
  db.listIndexEntries(undefined, 15_000).find((e) => e.frontmatter.id === entityId) ?? null;

const latestSplitForTrack = (db: SqliteRuntimeDb, trackId: string) => {
  const splits = db
    .listIndexEntries('06_RECORDS', 10_000)
    .filter((e) => e.vaultPath.startsWith('06_RECORDS/RIGHTS/SPLT-') && e.frontmatter.track_id === trackId)
    .sort((a, b) => Number(b.frontmatter.version ?? 0) - Number(a.frontmatter.version ?? 0));
  return splits[0] ?? null;
};

const isContributorNameTaken = (db: SqliteRuntimeDb, candidateName: string, excludePersonId?: string): boolean => {
  const needle = candidateName.trim().toLowerCase();
  const entries = db.listIndexEntries('06_RECORDS', 10_000);
  for (const e of entries) {
    if (e.vaultPath.startsWith('06_RECORDS/PEOPLE/PER-')) {
      if (excludePersonId && e.frontmatter.id === excludePersonId) continue;
      if (String(e.frontmatter.display_name ?? e.title).trim().toLowerCase() === needle) return true;
    }
    if (e.vaultPath.startsWith('06_RECORDS/PEOPLE/PALS-') && e.frontmatter.status !== 'superseded') {
      if (String(e.frontmatter.alias ?? '').trim().toLowerCase() === needle) return true;
    }
  }
  return false;
};

const writeEntitySupersession = async (input: {
  readonly ctx: CatalogOpsContext;
  readonly targetVaultPath: string;
  readonly expectedSha256: string;
  readonly targetFrontmatter: Readonly<Record<string, unknown>>;
  readonly targetBody: string;
  readonly supersededById: string;
  readonly actor: string;
  readonly reason: string;
}) => {
  const now = new Date().toISOString();
  const updatedContent = serializeFrontmatterDocument(
    {
      ...input.targetFrontmatter,
      status: 'superseded',
      superseded_by: input.supersededById,
      superseded_at: now,
      updated_at: now,
    },
    input.targetBody,
  );
  return input.ctx.vault.update({
    vaultPath: input.targetVaultPath,
    content: updatedContent,
    actor: input.actor,
    expectedSha256: input.expectedSha256,
    reason: input.reason,
  });
};

// ─── Music Projects ──────────────────────────────────────────────────────────

export const createMusicProject = async (ctx: CatalogOpsContext, input: MusicProjectInput) => {
  if (!input.title.trim()) throw new Error('Music project title is required');
  const status = input.status ?? 'active';
  if (!MUSIC_PROJECT_STATUSES.includes(status)) {
    throw new Error(`Invalid music project status "${status}"`);
  }
  const existingProjects = ctx.db
    .listIndexEntries('09_X3LIUS_MUSIC', 5_000)
    .filter((e) => e.vaultPath.startsWith('09_X3LIUS_MUSIC/PROJECTS/MPRJ-'));
  const projectId = input.projectId?.trim() || `mprj-${String(existingProjects.length + 1).padStart(4, '0')}-${slugify(input.title)}`;
  if (findAnyEntityById(ctx.db, projectId)) {
    throw new Error(`Duplicate music project id "${projectId}"`);
  }
  const now = new Date().toISOString();
  const vaultPath = `09_X3LIUS_MUSIC/PROJECTS/MPRJ-${slugify(projectId.replace(/^mprj-/, ''))}.md`;
  const content = serializeFrontmatterDocument(
    {
      schema: 'xyp3rn.entity/v3',
      id: projectId,
      type: 'music_project',
      title: input.title.trim(),
      artist: (input.artist ?? 'X3LIUS').trim(),
      release_kind: input.releaseKind ?? 'album',
      domain: 'RECORDS',
      sector: '09_X3LIUS_MUSIC',
      status,
      version: 1,
      target_release_date: input.targetReleaseDate ?? null,
      song_ids: [...(input.songIds ?? [])],
      release_ids: [...(input.releaseIds ?? [])],
      daw_project_paths: [...(input.dawProjectPaths ?? [])],
      provenance: input.provenance ?? 'os3-records-catalog',
      created_at: now,
      updated_at: now,
      tags: ['xyp3rn', 'os3', 'x3lius', 'music-project'],
    },
    [
      `# Music Project: ${input.title.trim()}`,
      '',
      input.description?.trim() ?? 'Studio & catalog production workspace.',
    ].join('\n'),
  );
  const written = await ctx.vault.write({
    vaultPath,
    content,
    actor: input.actor ?? 'x3lius-producer',
    writeMode: 'reject-overwrite',
    reason: `Create music production project ${projectId}`,
  });
  return { projectId, ...written };
};

// ─── Contributors, Aliases & Credits ─────────────────────────────────────────

export const registerContributor = async (ctx: CatalogOpsContext, input: ContributorInput) => {
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error('Contributor displayName must be non-empty');
  if (isContributorNameTaken(ctx.db, displayName)) {
    throw new Error(`Contributor displayName collision: "${displayName}" already exists in people or person_aliases`);
  }
  const existingPeople = ctx.db
    .listIndexEntries('06_RECORDS', 5_000)
    .filter((e) => e.vaultPath.startsWith('06_RECORDS/PEOPLE/PER-'));
  const personId = input.personId?.trim() || `per-${String(existingPeople.length + 1).padStart(4, '0')}-${slugify(displayName)}`;
  if (findAnyEntityById(ctx.db, personId)) {
    throw new Error(`Duplicate contributor id "${personId}"`);
  }
  const now = new Date().toISOString();
  const vaultPath = `06_RECORDS/PEOPLE/PER-${slugify(personId.replace(/^per-/, ''))}.md`;
  const content = serializeFrontmatterDocument(
    {
      schema: 'xyp3rn.entity/v3',
      id: personId,
      type: 'person',
      title: displayName,
      display_name: displayName,
      kind: input.kind ?? 'human',
      domain: 'RECORDS',
      sector: '06_RECORDS',
      status: 'active',
      version: 1,
      ipi: input.ipi ?? null,
      pro: input.pro ?? null,
      isni: input.isni ?? null,
      email: input.email ?? null,
      provenance: input.provenance ?? 'os3-records-catalog',
      created_at: now,
      updated_at: now,
      tags: ['xyp3rn', 'os3', 'records', 'contributor'],
    },
    `# Contributor: ${displayName}\n\n${input.bio?.trim() || '- Catalog contributor & rights party.'}`,
  );
  const written = await ctx.vault.write({
    vaultPath,
    content,
    actor: input.actor ?? 'records-catalog',
    writeMode: 'reject-overwrite',
    reason: `Register contributor ${personId} (${displayName})`,
  });

  const aliasRecords = [];
  for (const alias of input.aliases ?? []) {
    aliasRecords.push(
      await addContributorAlias(ctx, {
        personPathOrId: personId,
        alias,
        provenance: input.provenance,
        actor: input.actor,
      }),
    );
  }
  return { personId, displayName, aliases: aliasRecords, ...written };
};

export const addContributorAlias = async (ctx: CatalogOpsContext, input: ContributorAliasInput) => {
  const alias = input.alias.trim();
  if (!alias) throw new Error('Contributor alias must be non-empty');
  const person = findByPrefixOrId(ctx.db, input.personPathOrId, ['06_RECORDS/PEOPLE/PER-']);
  if (!person) throw new Error(`Contributor not found: "${input.personPathOrId}"`);
  if (isContributorNameTaken(ctx.db, alias)) {
    throw new Error(`Contributor alias collision: "${alias}" already exists in people or person_aliases`);
  }
  const personId = String(person.frontmatter.id);
  const aliasId = input.aliasId?.trim() || `pals-${slugify(personId.replace(/^per-/, ''))}-${slugify(alias)}`;
  if (findAnyEntityById(ctx.db, aliasId)) {
    throw new Error(`Duplicate alias id "${aliasId}"`);
  }
  const now = new Date().toISOString();
  const vaultPath = `06_RECORDS/PEOPLE/PALS-${slugify(aliasId.replace(/^pals-/, ''))}.md`;
  const content = serializeFrontmatterDocument(
    {
      schema: 'xyp3rn.entity/v3',
      id: aliasId,
      type: 'person_alias',
      title: `Alias: ${alias} -> ${person.title}`,
      person_id: personId,
      person_ref: person.vaultPath,
      alias,
      domain: 'RECORDS',
      sector: '06_RECORDS',
      status: 'active',
      version: 1,
      provenance: input.provenance ?? 'os3-records-catalog',
      created_at: now,
      updated_at: now,
      tags: ['xyp3rn', 'os3', 'records', 'person-alias'],
    },
    `# Alias: ${alias}\n\n- **Person:** [[${person.vaultPath.replace(/\.md$/, '')}|${person.title}]]`,
  );
  const written = await ctx.vault.write({
    vaultPath,
    content,
    actor: input.actor ?? 'records-catalog',
    writeMode: 'reject-overwrite',
    reason: `Add contributor alias "${alias}" for ${personId}`,
  });
  return { aliasId, personId, alias, ...written };
};

export const writeCredit = async (ctx: CatalogOpsContext, input: CreditInput) => {
  if (!CREDIT_ROLES.includes(input.role)) {
    throw new Error(`Invalid credit role "${input.role}"`);
  }
  const targetPrefix = input.targetType === 'song' ? '09_X3LIUS_MUSIC/SONGS/SONG-' : '06_RECORDS/TRACKS/TRK-';
  const target = findByPrefixOrId(ctx.db, input.targetPathOrId, [targetPrefix]);
  if (!target) throw new Error(`Credit target ${input.targetType} not found: "${input.targetPathOrId}"`);
  const person = findByPrefixOrId(ctx.db, input.personPathOrId, ['06_RECORDS/PEOPLE/PER-']);
  if (!person) throw new Error(`Contributor not found: "${input.personPathOrId}"`);

  const targetId = String(target.frontmatter.id);
  const personId = String(person.frontmatter.id);
  const duplicateLive = ctx.db
    .listIndexEntries('06_RECORDS', 10_000)
    .find(
      (e) =>
        e.vaultPath.startsWith('06_RECORDS/CREDITS/CRED-') &&
        e.frontmatter.status !== 'superseded' &&
        e.frontmatter.target_type === input.targetType &&
        e.frontmatter.target_id === targetId &&
        e.frontmatter.person_id === personId &&
        e.frontmatter.role === input.role,
    );
  if (duplicateLive) {
    throw new Error(`Duplicate live credit: "${personId}" already credited as "${input.role}" on ${targetId}`);
  }

  const count = ctx.db
    .listIndexEntries('06_RECORDS', 10_000)
    .filter((e) => e.vaultPath.startsWith('06_RECORDS/CREDITS/CRED-')).length;
  const creditId = input.creditId?.trim() || `cred-${String(count + 1).padStart(4, '0')}-${slugify(personId)}-${input.role}`;
  if (findAnyEntityById(ctx.db, creditId)) {
    throw new Error(`Duplicate credit id "${creditId}"`);
  }
  const now = new Date().toISOString();
  const vaultPath = `06_RECORDS/CREDITS/CRED-${slugify(creditId.replace(/^cred-/, ''))}.md`;
  const content = serializeFrontmatterDocument(
    {
      schema: 'xyp3rn.entity/v3',
      id: creditId,
      type: 'credit',
      title: `Credit: ${person.title} (${input.role}) on ${target.title}`,
      target_type: input.targetType,
      target_id: targetId,
      target_ref: target.vaultPath,
      person_id: personId,
      person_ref: person.vaultPath,
      role: input.role,
      domain: 'RECORDS',
      sector: '06_RECORDS',
      status: 'active',
      version: 1,
      provenance: input.provenance ?? 'os3-records-catalog',
      created_at: now,
      updated_at: now,
      tags: ['xyp3rn', 'os3', 'records', 'credit', input.role],
    },
    [
      `# Credit: ${person.title} (${input.role})`,
      '',
      `- **Target (${input.targetType}):** [[${target.vaultPath.replace(/\.md$/, '')}|${target.title}]]`,
      `- **Contributor:** [[${person.vaultPath.replace(/\.md$/, '')}|${person.title}]]`,
      ...(input.notes?.trim() ? [`- **Notes:** ${input.notes.trim()}`] : []),
    ].join('\n'),
  );
  const written = await ctx.vault.write({
    vaultPath,
    content,
    actor: input.actor ?? 'records-catalog',
    writeMode: 'reject-overwrite',
    reason: `Record credit ${creditId} (${input.role})`,
  });
  return { creditId, targetId, personId, role: input.role, ...written };
};

export const retractCredit = async (ctx: CatalogOpsContext, input: CreditRetractionInput) => {
  if (!input.reason.trim()) throw new Error('Credit retraction requires a non-empty reason');
  const credit = findByPrefixOrId(ctx.db, input.creditId, ['06_RECORDS/CREDITS/CRED-']);
  if (!credit) throw new Error(`Credit not found: "${input.creditId}"`);
  if (credit.frontmatter.status === 'superseded') {
    throw new Error(`Credit "${input.creditId}" is already retracted`);
  }
  const creditDoc = await ctx.vault.read(credit.vaultPath, input.actor ?? 'records-catalog');
  const cretId = `cret-${slugify(String(credit.frontmatter.id).replace(/^cred-/, ''))}`;
  const now = new Date().toISOString();
  const retPath = `06_RECORDS/CREDITS/CRET-${slugify(String(credit.frontmatter.id).replace(/^cred-/, ''))}.md`;
  const retContent = serializeFrontmatterDocument(
    {
      schema: 'xyp3rn.entity/v3',
      id: cretId,
      type: 'credit_retraction',
      title: `Retraction of ${String(credit.frontmatter.id)}`,
      credit_id: String(credit.frontmatter.id),
      credit_ref: credit.vaultPath,
      reason: input.reason.trim(),
      domain: 'RECORDS',
      sector: '06_RECORDS',
      status: 'complete',
      version: 1,
      provenance: 'os3-records-catalog-retraction',
      created_at: now,
      updated_at: now,
      tags: ['xyp3rn', 'os3', 'records', 'credit-retraction'],
    },
    `# Credit Retraction\n\n- **Credit:** ${String(credit.frontmatter.id)}\n- **Reason:** ${input.reason.trim()}`,
  );
  const retWritten = await ctx.vault.write({
    vaultPath: retPath,
    content: retContent,
    actor: input.actor ?? 'records-catalog',
    writeMode: 'reject-overwrite',
    reason: `Append credit retraction ${cretId}`,
  });
  await writeEntitySupersession({
    ctx,
    targetVaultPath: credit.vaultPath,
    expectedSha256: creditDoc.sha256,
    targetFrontmatter: creditDoc.frontmatter,
    targetBody: creditDoc.body,
    supersededById: cretId,
    actor: input.actor ?? 'records-catalog',
    reason: `Retract credit ${String(credit.frontmatter.id)}: ${input.reason.trim()}`,
  });
  return { retractionId: cretId, creditId: String(credit.frontmatter.id), ...retWritten };
};

// ─── Mix Versions & Master Versions ──────────────────────────────────────────

export const recordMixVersion = async (ctx: CatalogOpsContext, input: MixVersionInput) => {
  if (!input.audioSha256.trim()) throw new Error('Mix version requires audioSha256');
  if (input.audioFilePath) assertSafeRelativeAssetPath(input.audioFilePath);
  const song = findByPrefixOrId(ctx.db, input.songPathOrId, ['09_X3LIUS_MUSIC/SONGS/SONG-']);
  if (!song) throw new Error(`Song not found for mix version: "${input.songPathOrId}"`);
  const songId = String(song.frontmatter.id);
  const existing = ctx.db
    .listIndexEntries('09_X3LIUS_MUSIC', 10_000)
    .filter((e) => e.vaultPath.startsWith('09_X3LIUS_MUSIC/EVALUATION/MIX-') && e.frontmatter.song_id === songId);
  const nextVer = input.version ?? (existing.length === 0 ? 1 : Math.max(...existing.map((e) => Number(e.frontmatter.version ?? 0))) + 1);
  const mixId = input.mixId?.trim() || `mix-${slugify(songId.replace(/^song-/, ''))}-v${nextVer}`;
  if (findAnyEntityById(ctx.db, mixId)) throw new Error(`Duplicate mix id "${mixId}"`);
  const now = new Date().toISOString();
  const vaultPath = `09_X3LIUS_MUSIC/EVALUATION/MIX-${slugify(mixId.replace(/^mix-/, ''))}.md`;
  const title = input.title?.trim() || `${song.title} Mix v${nextVer}`;
  const content = serializeFrontmatterDocument(
    {
      schema: 'xyp3rn.entity/v3',
      id: mixId,
      type: 'mix_version',
      title,
      song_id: songId,
      song_ref: song.vaultPath,
      project_id: input.projectId ?? null,
      engineer_person_id: input.engineerPersonId ?? null,
      version: nextVer,
      audio_file_path: input.audioFilePath ?? null,
      audio_sha256: input.audioSha256.trim(),
      sample_rate_hz: input.sampleRateHz ?? null,
      bit_depth: input.bitDepth ?? null,
      integrated_lufs: input.integratedLufs ?? null,
      true_peak_dbtp: input.truePeakDbtp ?? null,
      daw_session_id: input.dawSessionId ?? null,
      audio_analysis_id: input.audioAnalysisId ?? null,
      plugin_chain_id: input.pluginChainId ?? null,
      domain: 'RECORDS',
      sector: '09_X3LIUS_MUSIC',
      status: 'complete',
      provenance: input.provenance ?? 'os3-x3lius-mix',
      created_at: now,
      updated_at: now,
      tags: ['xyp3rn', 'os3', 'x3lius', 'mix-version'],
    },
    [
      `# ${title}`,
      '',
      `- **Song:** [[${song.vaultPath.replace(/\.md$/, '')}|${song.title}]]`,
      `- **Audio SHA-256:** \`${input.audioSha256.trim()}\``,
      `- **LUFS / True Peak:** ${input.integratedLufs ?? 'n/a'} LUFS / ${input.truePeakDbtp ?? 'n/a'} dBTP`,
      ...(input.notes?.trim() ? ['', input.notes.trim()] : []),
    ].join('\n'),
  );
  const written = await ctx.vault.write({
    vaultPath,
    content,
    actor: input.actor ?? 'x3lius-mix-master',
    writeMode: 'reject-overwrite',
    reason: `Record mix version ${mixId}`,
  });
  return { mixId, songId, version: nextVer, ...written };
};

export const recordMasterVersion = async (ctx: CatalogOpsContext, input: MasterVersionInput) => {
  if (!input.audioSha256.trim()) throw new Error('Master version requires audioSha256');
  if (input.audioFilePath) assertSafeRelativeAssetPath(input.audioFilePath);
  if (input.truePeakDbtp !== undefined && input.truePeakDbtp !== null && input.truePeakDbtp > 0.0) {
    throw new Error(`Master true peak ${input.truePeakDbtp} dBTP exceeds digital full scale (0.0 dBTP)`);
  }
  if (input.isrc && !ISRC_RE.test(input.isrc.trim())) {
    throw new Error(`Invalid ISRC "${input.isrc}" on master version`);
  }
  const song = findByPrefixOrId(ctx.db, input.songPathOrId, ['09_X3LIUS_MUSIC/SONGS/SONG-']);
  if (!song) throw new Error(`Song not found for master version: "${input.songPathOrId}"`);
  const songId = String(song.frontmatter.id);
  const track = input.trackPathOrId
    ? findByPrefixOrId(ctx.db, input.trackPathOrId, ['06_RECORDS/TRACKS/TRK-'])
    : null;
  if (input.trackPathOrId && !track) throw new Error(`Track not found: "${input.trackPathOrId}"`);

  const existing = ctx.db
    .listIndexEntries('09_X3LIUS_MUSIC', 10_000)
    .filter((e) => e.vaultPath.startsWith('09_X3LIUS_MUSIC/EVALUATION/MSTR-') && e.frontmatter.song_id === songId);
  const nextVer = input.version ?? (existing.length === 0 ? 1 : Math.max(...existing.map((e) => Number(e.frontmatter.version ?? 0))) + 1);
  const masterId = input.masterId?.trim() || `mstr-${slugify(songId.replace(/^song-/, ''))}-v${nextVer}`;
  if (findAnyEntityById(ctx.db, masterId)) throw new Error(`Duplicate master id "${masterId}"`);
  const now = new Date().toISOString();
  const vaultPath = `09_X3LIUS_MUSIC/EVALUATION/MSTR-${slugify(masterId.replace(/^mstr-/, ''))}.md`;
  const title = input.title?.trim() || `${song.title} Master v${nextVer}`;
  const content = serializeFrontmatterDocument(
    {
      schema: 'xyp3rn.entity/v3',
      id: masterId,
      type: 'master_version',
      title,
      song_id: songId,
      song_ref: song.vaultPath,
      track_id: track ? String(track.frontmatter.id) : null,
      release_id: input.releaseId ?? (track ? track.frontmatter.release_id ?? null : null),
      mix_version_id: input.mixVersionId ?? null,
      engineer_person_id: input.engineerPersonId ?? null,
      version: nextVer,
      audio_file_path: input.audioFilePath ?? null,
      audio_sha256: input.audioSha256.trim(),
      sample_rate_hz: input.sampleRateHz ?? null,
      bit_depth: input.bitDepth ?? null,
      integrated_lufs: input.integratedLufs ?? null,
      true_peak_dbtp: input.truePeakDbtp ?? null,
      isrc: input.isrc?.trim() ?? null,
      daw_session_id: input.dawSessionId ?? null,
      audio_analysis_id: input.audioAnalysisId ?? null,
      plugin_chain_id: input.pluginChainId ?? null,
      domain: 'RECORDS',
      sector: '09_X3LIUS_MUSIC',
      status: 'pending_approval',
      provenance: input.provenance ?? 'os3-x3lius-master',
      created_at: now,
      updated_at: now,
      tags: ['xyp3rn', 'os3', 'x3lius', 'master-version'],
    },
    [
      `# ${title}`,
      '',
      `- **Song:** [[${song.vaultPath.replace(/\.md$/, '')}|${song.title}]]`,
      ...(track ? [`- **Track:** [[${track.vaultPath.replace(/\.md$/, '')}|${track.title}]]`] : []),
      `- **Audio SHA-256:** \`${input.audioSha256.trim()}\``,
      `- **LUFS / True Peak:** ${input.integratedLufs ?? 'n/a'} LUFS / ${input.truePeakDbtp ?? 'n/a'} dBTP`,
      ...(input.notes?.trim() ? ['', input.notes.trim()] : []),
    ].join('\n'),
  );
  const written = await ctx.vault.write({
    vaultPath,
    content,
    actor: input.actor ?? 'x3lius-mix-master',
    writeMode: 'reject-overwrite',
    reason: `Record master version ${masterId}`,
  });
  return { masterId, songId, version: nextVer, ...written };
};

export const requestMasterApproval = (ctx: CatalogOpsContext, input: { readonly masterPathOrId: string; readonly proposer: string }) => {
  const entry = findByPrefixOrId(ctx.db, input.masterPathOrId, ['09_X3LIUS_MUSIC/EVALUATION/MSTR-']);
  if (!entry) throw new Error(`Master version not found: "${input.masterPathOrId}"`);
  const masterId = String(entry.frontmatter.id);
  return ctx.db.queueApproval({
    itemType: 'artifact_version',
    itemId: masterId,
    proposer: input.proposer,
    request: {
      masterId,
      vaultPath: entry.vaultPath,
      songId: entry.frontmatter.song_id ?? null,
      version: entry.frontmatter.version ?? 1,
    },
  });
};

export const approveMasterVersion = async (
  ctx: CatalogOpsContext,
  input: { readonly masterPathOrId: string; readonly approvalId: string; readonly approver: string; readonly reason: string },
) => {
  const approval = ctx.db.getApproval(input.approvalId);
  if (!approval) throw new Error(`Approval not found: "${input.approvalId}"`);
  if (input.approver.trim().toLowerCase() === approval.proposer.trim().toLowerCase()) {
    throw new Error(`Security violation: proposer "${approval.proposer}" cannot approve own master version`);
  }
  const entry = findByPrefixOrId(ctx.db, input.masterPathOrId, ['09_X3LIUS_MUSIC/EVALUATION/MSTR-']);
  if (!entry) throw new Error(`Master version not found: "${input.masterPathOrId}"`);
  const decided =
    approval.status === 'pending'
      ? ctx.db.decideApproval({
          approvalId: approval.id,
          decision: 'approved',
          approver: input.approver,
          reason: input.reason,
        })
      : approval;
  if (decided.status !== 'approved') {
    throw new Error(`Master approval "${approval.id}" has status "${decided.status}", not approved`);
  }
  const doc = await ctx.vault.read(entry.vaultPath, input.approver);
  const now = new Date().toISOString();
  const updatedContent = serializeFrontmatterDocument(
    {
      ...doc.frontmatter,
      status: 'approved',
      approval_id: decided.id,
      approved_by: decided.approver,
      approved_at: now,
      updated_at: now,
    },
    doc.body,
  );
  const updated = await ctx.vault.update({
    vaultPath: entry.vaultPath,
    content: updatedContent,
    actor: input.approver,
    expectedSha256: doc.sha256,
    reason: `Approve master version ${String(entry.frontmatter.id)}: ${input.reason}`,
  });
  return { masterId: String(entry.frontmatter.id), approvalId: decided.id, approver: decided.approver, ...updated };
};

// ─── Split Proposals (`xyp_queue_split_proposal` version-pinning) ────────────

export const proposeRightsSplitChange = async (ctx: CatalogOpsContext, input: SplitProposalInput) => {
  if (!input.proposer.trim() || !input.reason.trim()) {
    throw new Error('Split proposal requires non-empty proposer and reason');
  }
  const track = findByPrefixOrId(ctx.db, input.trackPathOrId, ['06_RECORDS/TRACKS/TRK-']);
  if (!track) throw new Error(`Track not found: "${input.trackPathOrId}"`);
  const trackId = String(track.frontmatter.id);
  const { unassignedMilli, hasUnassigned } = validateRightsSharesMilli(input.shares);

  const lockKey = `records:track-splits:${trackId}`;
  const owner = `propose-${randomUUID()}`;
  if (!ctx.db.acquireLock(lockKey, owner, 10_000)) {
    throw new Error(`Concurrent split modification lock held on track "${trackId}"`);
  }
  try {
    const syncPrecheck = ctx.db.transaction(() => {
      const latest = latestSplitForTrack(ctx.db, trackId);
      const actualCurrentVer = latest ? Number(latest.frontmatter.version ?? 0) : 0;
      if (actualCurrentVer !== input.currentVersion) {
        throw new Error(
          `STALE_SPLIT_VERSION: proposal pinned v${input.currentVersion} on "${trackId}", but live version is v${actualCurrentVer}`,
        );
      }
      const nextVersion = actualCurrentVer + 1;
      const proposalId =
        input.proposalId?.trim() ||
        `sprp-${slugify(trackId.replace(/^trk-/, ''))}-v${nextVersion}-${randomUUID().slice(0, 6)}`;
      const approval = ctx.db.queueApproval({
        id: proposalId,
        itemType: 'split_proposal',
        itemId: proposalId,
        proposer: input.proposer.trim(),
        request: {
          trackId,
          trackPath: track.vaultPath,
          expectedVersion: input.currentVersion,
          proposedVersion: nextVersion,
          shares: input.shares,
          hasUnassigned,
          unassignedMilli,
          reason: input.reason.trim(),
        },
      });
      return { proposalId, approval, nextVersion };
    });

    const vaultPath = `06_RECORDS/RIGHTS/SPRP-${slugify(syncPrecheck.proposalId.replace(/^sprp-/, ''))}.md`;
    const now = new Date().toISOString();
    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.approval/v3',
        id: syncPrecheck.proposalId,
        type: 'split_proposal',
        title: `Split Proposal: ${track.title} (v${input.currentVersion} -> v${syncPrecheck.nextVersion})`,
        domain: 'RECORDS',
        sector: '06_RECORDS',
        status: 'pending',
        version: syncPrecheck.nextVersion,
        item_type: 'split_proposal',
        item_id: syncPrecheck.proposalId,
        track_id: trackId,
        expected_version: input.currentVersion,
        proposed_version: syncPrecheck.nextVersion,
        proposer: input.proposer.trim(),
        reason: input.reason.trim(),
        shares: input.shares,
        has_unassigned_share: hasUnassigned,
        provenance: input.provenance ?? 'os3-records-split-proposal',
        created_at: now,
        updated_at: now,
        tags: ['xyp3rn', 'os3', 'records', 'split-proposal'],
      },
      `# Split Proposal (${syncPrecheck.proposalId})\n\n- **Track:** ${trackId}\n- **Pinned Base Version:** v${input.currentVersion}\n- **Reason:** ${input.reason.trim()}`,
    );
    const written = await ctx.vault.write({
      vaultPath,
      content,
      actor: input.proposer.trim(),
      writeMode: 'reject-overwrite',
      reason: `Queue split proposal ${syncPrecheck.proposalId} for ${trackId}`,
    });
    return {
      proposalId: syncPrecheck.proposalId,
      approvalId: syncPrecheck.approval.id,
      trackId,
      expectedVersion: input.currentVersion,
      proposedVersion: syncPrecheck.nextVersion,
      ...written,
    };
  } finally {
    ctx.db.releaseLock(lockKey, owner);
  }
};

export const applyApprovedSplitProposal = async (
  ctx: CatalogOpsContext,
  input: {
    readonly proposalId: string;
    readonly approver: string;
    readonly reason: string;
    readonly writeSplitsFn: (args: {
      readonly trackPathOrId: string;
      readonly shares: readonly { readonly payee: string | null; readonly role: string; readonly percentage: number }[];
      readonly actor?: string | undefined;
    }) => Promise<{ readonly id: string; readonly trackId: string; readonly version: number; readonly hasUnassigned: boolean; readonly vaultPath: string; readonly sha256: string }>;
  },
) => {
  const approval = ctx.db.getApproval(input.proposalId);
  if (!approval || approval.itemType !== 'split_proposal') {
    throw new Error(`Split proposal approval not found: "${input.proposalId}"`);
  }
  if (input.approver.trim().toLowerCase() === approval.proposer.trim().toLowerCase()) {
    throw new Error(`Security violation: proposer "${approval.proposer}" cannot approve own split proposal`);
  }
  const req = approval.request as {
    trackId: string;
    expectedVersion: number;
    shares: readonly { readonly payee: string | null; readonly role: string; readonly percentage: number }[];
  };
  const lockKey = `records:track-splits:${req.trackId}`;
  const owner = `apply-${randomUUID()}`;
  if (!ctx.db.acquireLock(lockKey, owner, 10_000)) {
    throw new Error(`Concurrent split modification lock held on track "${req.trackId}"`);
  }
  try {
    const latest = latestSplitForTrack(ctx.db, req.trackId);
    const liveVer = latest ? Number(latest.frontmatter.version ?? 0) : 0;
    if (liveVer !== req.expectedVersion) {
      throw new Error(
        `CONCURRENT_SPLIT_MODIFICATION: split proposal expected base v${req.expectedVersion}, but "${req.trackId}" is now at v${liveVer}`,
      );
    }
    const decided =
      approval.status === 'pending'
        ? ctx.db.decideApproval({
            approvalId: approval.id,
            decision: 'approved',
            approver: input.approver,
            reason: input.reason,
          })
        : approval;
    if (decided.status !== 'approved') {
      throw new Error(`Split proposal "${approval.id}" has status "${decided.status}"`);
    }
    const splitWritten = await input.writeSplitsFn({
      trackPathOrId: req.trackId,
      shares: req.shares,
      actor: input.approver,
    });
    const proposalEntry = findByPrefixOrId(ctx.db, approval.id, ['06_RECORDS/RIGHTS/SPRP-']);
    if (proposalEntry) {
      const pDoc = await ctx.vault.read(proposalEntry.vaultPath, input.approver);
      await ctx.vault.update({
        vaultPath: proposalEntry.vaultPath,
        content: serializeFrontmatterDocument(
          {
            ...pDoc.frontmatter,
            status: 'approved',
            approver: decided.approver,
            decision_reason: input.reason,
            applied_split_id: splitWritten.id,
            updated_at: new Date().toISOString(),
          },
          pDoc.body,
        ),
        actor: input.approver,
        expectedSha256: pDoc.sha256,
        reason: `Apply split proposal ${approval.id}`,
      });
    }
    return { proposalId: approval.id, appliedSplit: splitWritten };
  } finally {
    ctx.db.releaseLock(lockKey, owner);
  }
};

// ─── Distribution: Platform Links, Artwork & Deliveries ──────────────────────

export const writePlatformLink = async (ctx: CatalogOpsContext, input: PlatformLinkInput) => {
  if (!PLATFORM_NAMES.includes(input.platform)) {
    throw new Error(`Unsupported platform "${input.platform}"`);
  }
  if (!isValidPlatformUrl(input.platform, input.url)) {
    throw new Error(`URL "${input.url}" failed host validation for platform "${input.platform}"`);
  }
  const targetPrefix =
    input.targetType === 'song'
      ? '09_X3LIUS_MUSIC/SONGS/SONG-'
      : input.targetType === 'release'
        ? '06_RECORDS/RELEASES/REL-'
        : '06_RECORDS/TRACKS/TRK-';
  const target = findByPrefixOrId(ctx.db, input.targetPathOrId, [targetPrefix]);
  if (!target) throw new Error(`Platform link target ${input.targetType} not found: "${input.targetPathOrId}"`);
  const targetId = String(target.frontmatter.id);

  const duplicateLive = ctx.db
    .listIndexEntries('06_RECORDS', 10_000)
    .find(
      (e) =>
        e.vaultPath.startsWith('06_RECORDS/DISTRIBUTION/PLNK-') &&
        e.frontmatter.status !== 'superseded' &&
        e.frontmatter.target_type === input.targetType &&
        e.frontmatter.target_id === targetId &&
        e.frontmatter.platform === input.platform,
    );
  if (duplicateLive) {
    throw new Error(
      `Duplicate live platform link: "${input.platform}" already linked to ${input.targetType} "${targetId}" (retract first)`,
    );
  }

  const linkId = input.linkId?.trim() || `plnk-${slugify(targetId)}-${input.platform}`;
  if (findAnyEntityById(ctx.db, linkId)) throw new Error(`Duplicate platform link id "${linkId}"`);
  const now = new Date().toISOString();
  const vaultPath = `06_RECORDS/DISTRIBUTION/PLNK-${slugify(linkId.replace(/^plnk-/, ''))}.md`;
  const content = serializeFrontmatterDocument(
    {
      schema: 'xyp3rn.entity/v3',
      id: linkId,
      type: 'platform_link',
      title: `${input.platform}: ${target.title}`,
      target_type: input.targetType,
      target_id: targetId,
      target_ref: target.vaultPath,
      platform: input.platform,
      url: input.url.trim(),
      handle: input.handle ?? null,
      domain: 'RECORDS',
      sector: '06_RECORDS',
      status: 'live',
      version: 1,
      provenance: input.provenance ?? 'os3-records-distribution',
      created_at: now,
      updated_at: now,
      tags: ['xyp3rn', 'os3', 'records', 'platform-link', input.platform],
    },
    `# Platform Link (${input.platform})\n\n- **Target:** ${targetId}\n- **URL:** ${input.url.trim()}`,
  );
  const written = await ctx.vault.write({
    vaultPath,
    content,
    actor: input.actor ?? 'records-distribution',
    writeMode: 'reject-overwrite',
    reason: `Record platform link ${linkId} (${input.platform})`,
  });
  return { linkId, targetId, platform: input.platform, url: input.url.trim(), ...written };
};

export const retractPlatformLink = async (ctx: CatalogOpsContext, input: PlatformLinkRetractionInput) => {
  if (!input.reason.trim()) throw new Error('Platform link retraction requires a reason');
  const link = findByPrefixOrId(ctx.db, input.linkId, ['06_RECORDS/DISTRIBUTION/PLNK-']);
  if (!link) throw new Error(`Platform link not found: "${input.linkId}"`);
  if (link.frontmatter.status === 'superseded') throw new Error(`Platform link "${input.linkId}" is already retracted`);
  const doc = await ctx.vault.read(link.vaultPath, input.actor ?? 'records-distribution');
  const retId = `plrt-${slugify(String(link.frontmatter.id).replace(/^plnk-/, ''))}`;
  const now = new Date().toISOString();
  const retPath = `06_RECORDS/DISTRIBUTION/PLRT-${slugify(String(link.frontmatter.id).replace(/^plnk-/, ''))}.md`;
  const retWritten = await ctx.vault.write({
    vaultPath: retPath,
    content: serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id: retId,
        type: 'platform_link_retraction',
        title: `Retract Platform Link: ${String(link.frontmatter.id)}`,
        link_id: String(link.frontmatter.id),
        reason: input.reason.trim(),
        domain: 'RECORDS',
        sector: '06_RECORDS',
        status: 'complete',
        version: 1,
        provenance: 'os3-records-distribution',
        created_at: now,
        updated_at: now,
        tags: ['xyp3rn', 'os3', 'records', 'platform-retraction'],
      },
      `# Platform Link Retraction\n\n- **Link:** ${String(link.frontmatter.id)}\n- **Reason:** ${input.reason.trim()}`,
    ),
    actor: input.actor ?? 'records-distribution',
    writeMode: 'reject-overwrite',
    reason: `Retract platform link ${String(link.frontmatter.id)}`,
  });
  await writeEntitySupersession({
    ctx,
    targetVaultPath: link.vaultPath,
    expectedSha256: doc.sha256,
    targetFrontmatter: doc.frontmatter,
    targetBody: doc.body,
    supersededById: retId,
    actor: input.actor ?? 'records-distribution',
    reason: input.reason.trim(),
  });
  return { retractionId: retId, linkId: String(link.frontmatter.id), ...retWritten };
};

export const setReleaseArtwork = async (ctx: CatalogOpsContext, input: ReleaseArtworkInput) => {
  const relAsset = assertSafeRelativeAssetPath(input.assetPath);
  if (!IMAGE_EXT_RE.test(relAsset)) {
    throw new Error(`Release artwork asset "${relAsset}" must be .png, .jpg, .jpeg, or .webp`);
  }
  if (!input.sha256.trim()) throw new Error('Release artwork requires sha256');
  const release = findByPrefixOrId(ctx.db, input.releasePathOrId, ['06_RECORDS/RELEASES/REL-']);
  if (!release) throw new Error(`Release not found for artwork: "${input.releasePathOrId}"`);
  const releaseId = String(release.frontmatter.id);
  const existing = ctx.db
    .listIndexEntries('06_RECORDS', 10_000)
    .filter((e) => e.vaultPath.startsWith('06_RECORDS/ARTWORK/ARTW-') && e.frontmatter.release_id === releaseId);
  const nextVer = existing.length === 0 ? 1 : Math.max(...existing.map((e) => Number(e.frontmatter.version ?? 0))) + 1;
  const artworkId = input.artworkId?.trim() || `artw-${slugify(releaseId.replace(/^rel-/, ''))}-v${nextVer}`;
  if (findAnyEntityById(ctx.db, artworkId)) throw new Error(`Duplicate artwork id "${artworkId}"`);
  const now = new Date().toISOString();
  const vaultPath = `06_RECORDS/ARTWORK/ARTW-${slugify(artworkId.replace(/^artw-/, ''))}.md`;
  const format = input.format ?? (relAsset.split('.').pop()?.toLowerCase() as 'png' | 'jpg' | 'jpeg' | 'webp');
  const written = await ctx.vault.write({
    vaultPath,
    content: serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id: artworkId,
        type: 'release_artwork',
        title: `Artwork: ${release.title} (v${nextVer})`,
        release_id: releaseId,
        release_ref: release.vaultPath,
        asset_path: relAsset,
        sha256: input.sha256.trim(),
        width_px: input.widthPx ?? null,
        height_px: input.heightPx ?? null,
        format,
        domain: 'RECORDS',
        sector: '06_RECORDS',
        status: 'active',
        version: nextVer,
        provenance: input.provenance ?? 'os3-records-artwork',
        created_at: now,
        updated_at: now,
        tags: ['xyp3rn', 'os3', 'records', 'artwork'],
      },
      `# Release Artwork (v${nextVer})\n\n- **Release:** ${releaseId}\n- **Asset:** \`${relAsset}\`\n- **SHA-256:** \`${input.sha256.trim()}\``,
    ),
    actor: input.actor ?? 'records-catalog',
    writeMode: 'reject-overwrite',
    reason: `Append release artwork v${nextVer} for ${releaseId}`,
  });
  return { artworkId, releaseId, version: nextVer, assetPath: relAsset, ...written };
};

export const recordReleaseDelivery = async (ctx: CatalogOpsContext, input: ReleaseDeliveryInput) => {
  if (!input.distributor.trim()) throw new Error('Distributor name is required');
  if (!DELIVERY_STATUSES.includes(input.status)) {
    throw new Error(`Invalid delivery status "${input.status}"`);
  }
  const release = findByPrefixOrId(ctx.db, input.releasePathOrId, ['06_RECORDS/RELEASES/REL-']);
  if (!release) throw new Error(`Release not found for delivery: "${input.releasePathOrId}"`);
  const releaseId = String(release.frontmatter.id);
  const existing = ctx.db
    .listIndexEntries('06_RECORDS', 10_000)
    .filter((e) => e.vaultPath.startsWith('06_RECORDS/DISTRIBUTION/DLVR-') && e.frontmatter.release_id === releaseId);
  const nextSeq = existing.length + 1;
  const deliveryId = input.deliveryId?.trim() || `dlvr-${slugify(releaseId.replace(/^rel-/, ''))}-${nextSeq}`;
  if (findAnyEntityById(ctx.db, deliveryId)) throw new Error(`Duplicate delivery id "${deliveryId}"`);
  const now = new Date().toISOString();
  const vaultPath = `06_RECORDS/DISTRIBUTION/DLVR-${slugify(deliveryId.replace(/^dlvr-/, ''))}.md`;
  const written = await ctx.vault.write({
    vaultPath,
    content: serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id: deliveryId,
        type: 'release_delivery',
        title: `Delivery #${nextSeq} (${input.distributor.trim()}): ${release.title}`,
        release_id: releaseId,
        release_ref: release.vaultPath,
        distributor: input.distributor.trim(),
        delivery_status: input.status,
        delivery_date: input.deliveryDate ?? null,
        external_ref: input.externalRef ?? null,
        domain: 'RECORDS',
        sector: '06_RECORDS',
        status: 'complete',
        version: nextSeq,
        provenance: input.provenance ?? 'os3-records-distribution',
        created_at: now,
        updated_at: now,
        tags: ['xyp3rn', 'os3', 'records', 'release-delivery'],
      },
      [
        `# Release Delivery: ${input.distributor.trim()}`,
        '',
        `- **Release:** ${releaseId}`,
        `- **Status:** \`${input.status}\``,
        ...(input.externalRef ? [`- **External Ref:** \`${input.externalRef}\``] : []),
        ...(input.notes?.trim() ? [`- **Notes:** ${input.notes.trim()}`] : []),
      ].join('\n'),
    ),
    actor: input.actor ?? 'records-distribution',
    writeMode: 'reject-overwrite',
    reason: `Record distributor delivery ${deliveryId} (${input.status})`,
  });
  return { deliveryId, releaseId, status: input.status, sequence: nextSeq, ...written };
};

// ─── Song Links (`A1` + Retractions) ─────────────────────────────────────────

export const linkSongTarget = async (ctx: CatalogOpsContext, input: SongLinkInput) => {
  if (!SONG_LINK_TYPES.includes(input.linkType)) {
    throw new Error(`Invalid song link type "${input.linkType}"`);
  }
  const song = findByPrefixOrId(ctx.db, input.songPathOrId, ['09_X3LIUS_MUSIC/SONGS/SONG-']);
  if (!song) throw new Error(`Song not found: "${input.songPathOrId}"`);
  const songId = String(song.frontmatter.id);
  const dup = ctx.db
    .listIndexEntries('09_X3LIUS_MUSIC', 10_000)
    .find(
      (e) =>
        e.vaultPath.startsWith('09_X3LIUS_MUSIC/SONGS/SLNK-') &&
        e.frontmatter.status !== 'superseded' &&
        e.frontmatter.song_id === songId &&
        e.frontmatter.link_type === input.linkType &&
        e.frontmatter.target_id === input.targetId.trim(),
    );
  if (dup) {
    throw new Error(`Duplicate live song link: ${songId} -> ${input.linkType}:${input.targetId.trim()}`);
  }
  const linkId = input.linkId?.trim() || `slnk-${slugify(songId.replace(/^song-/, ''))}-${input.linkType}-${slugify(input.targetId)}`;
  if (findAnyEntityById(ctx.db, linkId)) throw new Error(`Duplicate song link id "${linkId}"`);
  const now = new Date().toISOString();
  const vaultPath = `09_X3LIUS_MUSIC/SONGS/SLNK-${slugify(linkId.replace(/^slnk-/, ''))}.md`;
  const written = await ctx.vault.write({
    vaultPath,
    content: serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id: linkId,
        type: 'song_link',
        title: `Song Link (${input.linkType}): ${song.title} -> ${input.targetId.trim()}`,
        song_id: songId,
        song_ref: song.vaultPath,
        link_type: input.linkType,
        target_id: input.targetId.trim(),
        target_vault_path: input.targetVaultPath ?? null,
        domain: 'RECORDS',
        sector: '09_X3LIUS_MUSIC',
        status: 'active',
        version: 1,
        provenance: input.provenance ?? 'os3-x3lius-song-links',
        created_at: now,
        updated_at: now,
        tags: ['xyp3rn', 'os3', 'x3lius', 'song-link'],
      },
      `# Song Link\n\n- **Song:** ${songId}\n- **Type:** \`${input.linkType}\`\n- **Target:** \`${input.targetId.trim()}\``,
    ),
    actor: input.actor ?? 'x3lius-songs',
    writeMode: 'reject-overwrite',
    reason: `Link song ${songId} to ${input.linkType}:${input.targetId.trim()}`,
  });
  return { linkId, songId, linkType: input.linkType, targetId: input.targetId.trim(), ...written };
};

export const retractSongLink = async (ctx: CatalogOpsContext, input: SongLinkRetractionInput) => {
  if (!input.reason.trim()) throw new Error('Song link retraction requires a reason');
  const link = findByPrefixOrId(ctx.db, input.linkId, ['09_X3LIUS_MUSIC/SONGS/SLNK-']);
  if (!link) throw new Error(`Song link not found: "${input.linkId}"`);
  if (link.frontmatter.status === 'superseded') throw new Error(`Song link "${input.linkId}" already retracted`);
  const doc = await ctx.vault.read(link.vaultPath, input.actor ?? 'x3lius-songs');
  const retId = `slrt-${slugify(String(link.frontmatter.id).replace(/^slnk-/, ''))}`;
  const now = new Date().toISOString();
  const retPath = `09_X3LIUS_MUSIC/SONGS/SLRT-${slugify(String(link.frontmatter.id).replace(/^slnk-/, ''))}.md`;
  const retWritten = await ctx.vault.write({
    vaultPath: retPath,
    content: serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id: retId,
        type: 'song_link_retraction',
        title: `Retract Song Link: ${String(link.frontmatter.id)}`,
        link_id: String(link.frontmatter.id),
        reason: input.reason.trim(),
        domain: 'RECORDS',
        sector: '09_X3LIUS_MUSIC',
        status: 'complete',
        version: 1,
        provenance: 'os3-x3lius-song-links',
        created_at: now,
        updated_at: now,
        tags: ['xyp3rn', 'os3', 'x3lius', 'song-link-retraction'],
      },
      `# Song Link Retraction\n\n- **Link:** ${String(link.frontmatter.id)}\n- **Reason:** ${input.reason.trim()}`,
    ),
    actor: input.actor ?? 'x3lius-songs',
    writeMode: 'reject-overwrite',
    reason: `Retract song link ${String(link.frontmatter.id)}`,
  });
  await writeEntitySupersession({
    ctx,
    targetVaultPath: link.vaultPath,
    expectedSha256: doc.sha256,
    targetFrontmatter: doc.frontmatter,
    targetBody: doc.body,
    supersededById: retId,
    actor: input.actor ?? 'x3lius-songs',
    reason: input.reason.trim(),
  });
  return { retractionId: retId, linkId: String(link.frontmatter.id), ...retWritten };
};

// ─── Computed Catalog Readiness Checks & Album Continuity ────────────────────

export const computeCatalogReadinessChecks = (
  ctx: CatalogOpsContext,
  releasePathOrId?: string,
): CatalogReadinessReport => {
  const recEntries = ctx.db.listIndexEntries('06_RECORDS', 15_000);
  const musicEntries = ctx.db.listIndexEntries('09_X3LIUS_MUSIC', 15_000);

  const releasesAll = recEntries.filter((e) => e.vaultPath.startsWith('06_RECORDS/RELEASES/REL-'));
  const targetRelease = releasePathOrId ? findByPrefixOrId(ctx.db, releasePathOrId, ['06_RECORDS/RELEASES/REL-']) : null;
  if (releasePathOrId && !targetRelease) throw new Error(`Release not found: "${releasePathOrId}"`);
  const releases = targetRelease ? [targetRelease] : releasesAll;
  const targetReleaseId = targetRelease ? String(targetRelease.frontmatter.id) : null;

  const tracksAll = recEntries.filter((e) => e.vaultPath.startsWith('06_RECORDS/TRACKS/TRK-'));
  const tracks = targetReleaseId ? tracksAll.filter((t) => t.frontmatter.release_id === targetReleaseId) : tracksAll;
  const songsAll = musicEntries.filter((e) => e.vaultPath.startsWith('09_X3LIUS_MUSIC/SONGS/SONG-'));
  const linkedSongIds = new Set(tracks.map((t) => String(t.frontmatter.song_id ?? '')).filter(Boolean));
  const songs = targetReleaseId ? songsAll.filter((s) => linkedSongIds.has(String(s.frontmatter.id))) : songsAll;

  const lyrics = musicEntries.filter((e) => e.vaultPath.startsWith('09_X3LIUS_MUSIC/LYRICS/LYR-'));
  const approvals = musicEntries.filter((e) => e.vaultPath.startsWith('09_X3LIUS_MUSIC/EVALUATION/APPR-'));
  const credits = recEntries.filter((e) => e.vaultPath.startsWith('06_RECORDS/CREDITS/CRED-') && e.frontmatter.status !== 'superseded');
  const artwork = recEntries.filter((e) => e.vaultPath.startsWith('06_RECORDS/ARTWORK/ARTW-'));
  const masters = musicEntries.filter((e) => e.vaultPath.startsWith('09_X3LIUS_MUSIC/EVALUATION/MSTR-'));
  const takes = musicEntries.filter((e) => e.vaultPath.startsWith('09_X3LIUS_MUSIC/TAKES/TAKE-'));
  const dawLinks = recEntries.filter((e) => e.vaultPath.startsWith('06_RECORDS/CATALOG_LINKS/DWLK-'));

  const checks: CatalogReadinessCheck[] = [];

  for (const song of songs) {
    const songId = String(song.frontmatter.id);
    const songLyrics = lyrics.filter((l) => l.frontmatter.song_id === songId);
    const hasApprovedLyric = songLyrics.some((l) =>
      approvals.some((a) => a.frontmatter.item_id === l.frontmatter.id && a.frontmatter.status === 'approved'),
    );
    if (songLyrics.length > 0 && !hasApprovedLyric) {
      checks.push({
        checkId: `chk-lyric-${songId}`,
        ruleCode: 'SONG_MISSING_APPROVED_LYRIC',
        severity: 'warning',
        entityType: 'song',
        entityId: songId,
        vaultPath: song.vaultPath,
        message: `Song "${songId}" has lyric versions but none approved`,
      });
    }
    const hasWriterOrComposer = credits.some(
      (c) => c.frontmatter.target_id === songId && (c.frontmatter.role === 'writer' || c.frontmatter.role === 'composer' || c.frontmatter.role === 'lyricist'),
    );
    if (!hasWriterOrComposer) {
      checks.push({
        checkId: `chk-credit-${songId}`,
        ruleCode: 'SONG_MISSING_WRITER_CREDIT',
        severity: 'warning',
        entityType: 'song',
        entityId: songId,
        vaultPath: song.vaultPath,
        message: `Song "${songId}" has no live writer/composer/lyricist credit`,
      });
    }
  }

  for (const rel of releases) {
    const relId = String(rel.frontmatter.id);
    const relTracks = tracksAll
      .filter((t) => t.frontmatter.release_id === relId)
      .sort((a, b) => Number(a.frontmatter.position ?? 0) - Number(b.frontmatter.position ?? 0));
    if (relTracks.length === 0) {
      checks.push({
        checkId: `chk-rel-tracks-${relId}`,
        ruleCode: 'RELEASE_NO_TRACKS',
        severity: 'blocker',
        entityType: 'release',
        entityId: relId,
        vaultPath: rel.vaultPath,
        message: `Release "${relId}" has 0 registered tracks`,
      });
    } else {
      const positions = relTracks.map((t) => Number(t.frontmatter.position ?? 0));
      const contiguous = positions.every((pos, idx) => pos === idx + 1);
      if (!contiguous) {
        checks.push({
          checkId: `chk-rel-pos-${relId}`,
          ruleCode: 'RELEASE_NON_CONTIGUOUS_POSITIONS',
          severity: 'blocker',
          entityType: 'release',
          entityId: relId,
          vaultPath: rel.vaultPath,
          message: `Release "${relId}" track positions [${positions.join(', ')}] are not contiguous 1..${relTracks.length}`,
        });
      }
    }
    if (!rel.frontmatter.upc) {
      checks.push({
        checkId: `chk-rel-upc-${relId}`,
        ruleCode: 'RELEASE_MISSING_UPC',
        severity: 'blocker',
        entityType: 'release',
        entityId: relId,
        vaultPath: rel.vaultPath,
        message: `Release "${relId}" is missing a GS1 UPC code`,
      });
    }
    const relArt = artwork.filter((a) => a.frontmatter.release_id === relId);
    if (relArt.length === 0) {
      checks.push({
        checkId: `chk-rel-art-${relId}`,
        ruleCode: 'RELEASE_MISSING_ARTWORK',
        severity: rel.frontmatter.status === 'draft' ? 'warning' : 'blocker',
        entityType: 'release',
        entityId: relId,
        vaultPath: rel.vaultPath,
        message: `Release "${relId}" has no registered cover artwork`,
      });
    }
  }

  for (const trk of tracks) {
    const trackId = String(trk.frontmatter.id);
    if (!trk.frontmatter.isrc) {
      checks.push({
        checkId: `chk-trk-isrc-${trackId}`,
        ruleCode: 'TRACK_MISSING_ISRC',
        severity: 'blocker',
        entityType: 'track',
        entityId: trackId,
        vaultPath: trk.vaultPath,
        message: `Track "${trackId}" is missing an ISRC`,
      });
    }
    const latestSplit = latestSplitForTrack(ctx.db, trackId);
    if (!latestSplit) {
      checks.push({
        checkId: `chk-trk-splt-${trackId}`,
        ruleCode: 'TRACK_MISSING_SPLITS',
        severity: 'blocker',
        entityType: 'track',
        entityId: trackId,
        vaultPath: trk.vaultPath,
        message: `Track "${trackId}" has no rights split set`,
      });
    } else {
      if (Boolean(latestSplit.frontmatter.has_unassigned_share)) {
        checks.push({
          checkId: `chk-trk-unassigned-${trackId}`,
          ruleCode: 'TRACK_UNASSIGNED_SHARE',
          severity: 'blocker',
          entityType: 'track',
          entityId: trackId,
          vaultPath: latestSplit.vaultPath,
          message: `Track "${trackId}" rights split v${String(latestSplit.frontmatter.version ?? 1)} contains UNASSIGNED share`,
        });
      }
      if (Math.abs(Number(latestSplit.frontmatter.total_percentage ?? 0) - 100) > 0.001) {
        checks.push({
          checkId: `chk-trk-sum-${trackId}`,
          ruleCode: 'TRACK_SPLIT_SUM_INVALID',
          severity: 'blocker',
          entityType: 'track',
          entityId: trackId,
          vaultPath: latestSplit.vaultPath,
          message: `Track "${trackId}" split sum is ${String(latestSplit.frontmatter.total_percentage)}%, expected 100%`,
        });
      }
    }
    const trackMasters = masters.filter((m) => m.frontmatter.track_id === trackId || (trk.frontmatter.song_id && m.frontmatter.song_id === trk.frontmatter.song_id));
    const hasSourceOrTake = Boolean(trk.frontmatter.take_id) || Boolean(trk.frontmatter.source_path) || trackMasters.length > 0;
    if (!hasSourceOrTake) {
      checks.push({
        checkId: `chk-trk-audio-${trackId}`,
        ruleCode: 'TRACK_NO_SOURCE_OR_MASTER',
        severity: 'blocker',
        entityType: 'track',
        entityId: trackId,
        vaultPath: trk.vaultPath,
        message: `Track "${trackId}" has no linked Take, Source audio, or Master version`,
      });
    } else if (trackMasters.length > 0 && !trackMasters.some((m) => m.frontmatter.status === 'approved')) {
      checks.push({
        checkId: `chk-trk-mstr-appr-${trackId}`,
        ruleCode: 'TRACK_UNAPPROVED_AUDIO_SOURCE',
        severity: 'warning',
        entityType: 'track',
        entityId: trackId,
        vaultPath: trk.vaultPath,
        message: `Track "${trackId}" has master version(s) pending approval`,
      });
    } else if (trk.frontmatter.take_id && !takes.some((tk) => tk.frontmatter.id === trk.frontmatter.take_id)) {
      checks.push({
        checkId: `chk-trk-take-ref-${trackId}`,
        ruleCode: 'TRACK_NO_SOURCE_OR_MASTER',
        severity: 'blocker',
        entityType: 'track',
        entityId: trackId,
        vaultPath: trk.vaultPath,
        message: `Track "${trackId}" references missing take "${String(trk.frontmatter.take_id)}"`,
      });
    }
  }

  for (const link of dawLinks) {
    const linkTarget = String(link.frontmatter.target_id ?? '');
    if (targetReleaseId && linkTarget !== targetReleaseId && !linkedSongIds.has(linkTarget)) continue;
    if (link.frontmatter.has_unsaved_live_changes === true || link.frontmatter.audio_analysis_verdict === 'CRITICAL') {
      checks.push({
        checkId: `chk-daw-${String(link.frontmatter.id)}`,
        ruleCode: 'DAW_SESSION_DRIFT_OR_CRITICAL_AUDIO',
        severity: 'blocker',
        entityType: 'daw_link',
        entityId: String(link.frontmatter.id),
        vaultPath: link.vaultPath,
        message: `Linked DAW session "${String(link.frontmatter.daw_session_id ?? link.frontmatter.daw_project_path)}" has unsaved live drift or CRITICAL audio analysis verdict`,
      });
    }
  }

  const blockerCount = checks.filter((c) => c.severity === 'blocker').length;
  const warningCount = checks.filter((c) => c.severity === 'warning').length;
  return {
    computedAt: new Date().toISOString(),
    readyForRelease: blockerCount === 0,
    blockerCount,
    warningCount,
    checks,
  };
};

export const getAlbumContinuity = (ctx: CatalogOpsContext, releasePathOrId: string): AlbumContinuityReport => {
  const release = findByPrefixOrId(ctx.db, releasePathOrId, ['06_RECORDS/RELEASES/REL-']);
  if (!release) throw new Error(`Release not found: "${releasePathOrId}"`);
  const releaseId = String(release.frontmatter.id);
  const recEntries = ctx.db.listIndexEntries('06_RECORDS', 15_000);
  const musicEntries = ctx.db.listIndexEntries('09_X3LIUS_MUSIC', 15_000);
  const relTracks = recEntries
    .filter((e) => e.vaultPath.startsWith('06_RECORDS/TRACKS/TRK-') && e.frontmatter.release_id === releaseId)
    .sort((a, b) => Number(a.frontmatter.position ?? 0) - Number(b.frontmatter.position ?? 0));
  const masters = musicEntries.filter((e) => e.vaultPath.startsWith('09_X3LIUS_MUSIC/EVALUATION/MSTR-'));
  const dawLinks = recEntries.filter((e) => e.vaultPath.startsWith('06_RECORDS/CATALOG_LINKS/DWLK-'));
  const artwork = recEntries
    .filter((e) => e.vaultPath.startsWith('06_RECORDS/ARTWORK/ARTW-') && e.frontmatter.release_id === releaseId)
    .sort((a, b) => Number(b.frontmatter.version ?? 0) - Number(a.frontmatter.version ?? 0));
  const deliveries = recEntries
    .filter((e) => e.vaultPath.startsWith('06_RECORDS/DISTRIBUTION/DLVR-') && e.frontmatter.release_id === releaseId)
    .sort((a, b) => Number(b.frontmatter.version ?? 0) - Number(a.frontmatter.version ?? 0));

  const positions = relTracks.map((t) => Number(t.frontmatter.position ?? 0));
  const contiguousPositions = relTracks.length > 0 && positions.every((pos, idx) => pos === idx + 1);
  const readiness = computeCatalogReadinessChecks(ctx, releaseId);

  return {
    releaseId,
    title: release.title,
    kind: String(release.frontmatter.kind ?? 'album'),
    upc: release.frontmatter.upc ? String(release.frontmatter.upc) : null,
    status: String(release.frontmatter.status ?? 'draft') as AlbumContinuityReport['status'],
    trackCount: relTracks.length,
    contiguousPositions,
    tracks: relTracks.map((t) => {
      const tid = String(t.frontmatter.id);
      const songId = t.frontmatter.song_id ? String(t.frontmatter.song_id) : null;
      const latestSplit = latestSplitForTrack(ctx.db, tid);
      return {
        trackId: tid,
        title: t.title,
        position: Number(t.frontmatter.position ?? 0),
        isrc: t.frontmatter.isrc ? String(t.frontmatter.isrc) : null,
        splitVersion: latestSplit ? Number(latestSplit.frontmatter.version ?? 1) : null,
        hasUnassignedShare: latestSplit ? Boolean(latestSplit.frontmatter.has_unassigned_share) : true,
        masterVersionIds: masters
          .filter((m) => m.frontmatter.track_id === tid || (songId !== null && m.frontmatter.song_id === songId))
          .map((m) => String(m.frontmatter.id)),
        dawLinkIds: dawLinks
          .filter((d) => d.frontmatter.target_id === releaseId || (songId !== null && d.frontmatter.target_id === songId))
          .map((d) => String(d.frontmatter.id)),
      };
    }),
    artworkCount: artwork.length,
    latestArtworkId: artwork[0] ? String(artwork[0].frontmatter.id) : null,
    deliveryCount: deliveries.length,
    latestDeliveryStatus: deliveries[0] ? (String(deliveries[0].frontmatter.delivery_status) as AlbumContinuityReport['latestDeliveryStatus']) : null,
    blockers: readiness.checks.filter((c) => c.severity === 'blocker'),
    warnings: readiness.checks.filter((c) => c.severity === 'warning'),
  };
};
