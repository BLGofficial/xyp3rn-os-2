import type { ReleaseStatus } from './ops/tools.ts';

/**
 * OS2-parity Music System roles (`public.credits.role` CHECK constraint).
 */
export const CREDIT_ROLES = [
  'writer',
  'composer',
  'lyricist',
  'producer',
  'vocalist',
  'featured_artist',
  'performer',
  'arranger',
  'recording_engineer',
  'mixing_engineer',
  'mastering_engineer',
  'artwork',
  'other',
] as const;

export type CreditRole = (typeof CREDIT_ROLES)[number];

/**
 * OS2-parity Streaming & Social Distribution Platforms (`public.platform_links.platform`).
 */
export const PLATFORM_NAMES = [
  'spotify',
  'apple_music',
  'youtube',
  'youtube_music',
  'soundcloud',
  'bandcamp',
  'tidal',
  'deezer',
  'amazon_music',
  'tiktok',
  'instagram',
  'other',
] as const;

export type PlatformName = (typeof PLATFORM_NAMES)[number];

/**
 * Exact OS2 host validation patterns matching `public.xyp_platform_url_ok(platform, url)`
 * from `supabase/migrations/20260925150000_command_center.sql`.
 */
export const PLATFORM_URL_PATTERNS: Readonly<Record<PlatformName, RegExp>> = {
  spotify: /^https?:\/\/([^/]+\.)?(spotify\.com|spoti\.fi)\//i,
  apple_music: /^https?:\/\/([^/]+\.)?(music\.apple\.com|itunes\.apple\.com)\//i,
  youtube: /^https?:\/\/([^/]+\.)?(youtube\.com|youtu\.be)\//i,
  youtube_music: /^https?:\/\/([^/]+\.)?music\.youtube\.com\//i,
  soundcloud: /^https?:\/\/([^/]+\.)?soundcloud\.com\//i,
  bandcamp: /^https?:\/\/[^/]*bandcamp\.com\//i,
  tidal: /^https?:\/\/([^/]+\.)?tidal\.com\//i,
  deezer: /^https?:\/\/([^/]+\.)?deezer\.com\//i,
  amazon_music: /^https?:\/\/([^/]+\.)?(music\.amazon\.[a-z.]+|amazon\.[a-z.]+\/music)\//i,
  tiktok: /^https?:\/\/([^/]+\.)?(tiktok\.com|vm\.tiktok\.com)\//i,
  instagram: /^https?:\/\/([^/]+\.)?(instagram\.com|instagr\.am)\//i,
  other: /^https?:\/\/.+/i,
};

export const isValidPlatformUrl = (platform: PlatformName, url: string): boolean => {
  const re = PLATFORM_URL_PATTERNS[platform];
  return re ? re.test(url.trim()) : false;
};

/**
 * OS2-parity Delivery Statuses (`public.release_deliveries.status`).
 */
export const DELIVERY_STATUSES = [
  'submitted',
  'in_review',
  'approved',
  'live',
  'rejected',
  'takedown_requested',
  'taken_down',
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const SONG_LINK_TYPES = [
  'artifact_lineage',
  'source',
  'take',
  'track',
  'research_question',
  'daw_session',
  'daw_project',
  'mix_version',
  'master_version',
] as const;

export type SongLinkType = (typeof SONG_LINK_TYPES)[number];

export const MUSIC_PROJECT_STATUSES = ['draft', 'active', 'in-development', 'paused', 'complete', 'archived'] as const;
export type MusicProjectStatus = (typeof MUSIC_PROJECT_STATUSES)[number];

export const CONTRIBUTOR_KINDS = ['human', 'ai_persona', 'collective', 'label', 'other'] as const;
export type ContributorKind = (typeof CONTRIBUTOR_KINDS)[number];

export type MusicProjectInput = {
  readonly projectId?: string | undefined;
  readonly title: string;
  readonly artist?: string | undefined;
  readonly releaseKind?: 'single' | 'ep' | 'album' | undefined;
  readonly status?: MusicProjectStatus | undefined;
  readonly description?: string | undefined;
  readonly targetReleaseDate?: string | null | undefined;
  readonly songIds?: readonly string[] | undefined;
  readonly releaseIds?: readonly string[] | undefined;
  readonly dawProjectPaths?: readonly string[] | undefined;
  readonly provenance?: string | undefined;
  readonly actor?: string | undefined;
};

export type ContributorInput = {
  readonly personId?: string | undefined;
  readonly displayName: string;
  readonly kind?: ContributorKind | undefined;
  readonly ipi?: string | null | undefined;
  readonly pro?: string | null | undefined;
  readonly isni?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly bio?: string | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly provenance?: string | undefined;
  readonly actor?: string | undefined;
};

export type ContributorAliasInput = {
  readonly aliasId?: string | undefined;
  readonly personPathOrId: string;
  readonly alias: string;
  readonly provenance?: string | undefined;
  readonly actor?: string | undefined;
};

export type CreditInput = {
  readonly creditId?: string | undefined;
  readonly targetType: 'song' | 'track';
  readonly targetPathOrId: string;
  readonly personPathOrId: string;
  readonly role: CreditRole;
  readonly notes?: string | undefined;
  readonly provenance?: string | undefined;
  readonly actor?: string | undefined;
};

export type CreditRetractionInput = {
  readonly creditId: string;
  readonly reason: string;
  readonly actor?: string | undefined;
};

export type MixVersionInput = {
  readonly mixId?: string | undefined;
  readonly songPathOrId: string;
  readonly projectId?: string | undefined;
  readonly version?: number | undefined;
  readonly title?: string | undefined;
  readonly engineerPersonId?: string | undefined;
  readonly audioFilePath?: string | null | undefined;
  readonly audioSha256: string;
  readonly sampleRateHz?: number | undefined;
  readonly bitDepth?: number | undefined;
  readonly integratedLufs?: number | null | undefined;
  readonly truePeakDbtp?: number | null | undefined;
  readonly dawSessionId?: string | null | undefined;
  readonly audioAnalysisId?: string | null | undefined;
  readonly pluginChainId?: string | null | undefined;
  readonly notes?: string | undefined;
  readonly provenance?: string | undefined;
  readonly actor?: string | undefined;
};

export type MasterVersionInput = {
  readonly masterId?: string | undefined;
  readonly songPathOrId: string;
  readonly trackPathOrId?: string | undefined;
  readonly mixVersionId?: string | undefined;
  readonly releaseId?: string | undefined;
  readonly version?: number | undefined;
  readonly title?: string | undefined;
  readonly engineerPersonId?: string | undefined;
  readonly audioFilePath?: string | null | undefined;
  readonly audioSha256: string;
  readonly sampleRateHz?: number | undefined;
  readonly bitDepth?: number | undefined;
  readonly integratedLufs?: number | null | undefined;
  readonly truePeakDbtp?: number | null | undefined;
  readonly isrc?: string | null | undefined;
  readonly dawSessionId?: string | null | undefined;
  readonly audioAnalysisId?: string | null | undefined;
  readonly pluginChainId?: string | null | undefined;
  readonly notes?: string | undefined;
  readonly provenance?: string | undefined;
  readonly actor?: string | undefined;
};

export type SplitProposalInput = {
  readonly proposalId?: string | undefined;
  readonly trackPathOrId: string;
  readonly currentVersion: number;
  readonly shares: readonly {
    readonly payee: string | null;
    readonly role: string;
    readonly percentage: number;
  }[];
  readonly proposer: string;
  readonly reason: string;
  readonly provenance?: string | undefined;
};

export type PlatformLinkInput = {
  readonly linkId?: string | undefined;
  readonly targetType: 'song' | 'release' | 'track';
  readonly targetPathOrId: string;
  readonly platform: PlatformName;
  readonly url: string;
  readonly handle?: string | null | undefined;
  readonly provenance?: string | undefined;
  readonly actor?: string | undefined;
};

export type PlatformLinkRetractionInput = {
  readonly linkId: string;
  readonly reason: string;
  readonly actor?: string | undefined;
};

export type ReleaseArtworkInput = {
  readonly artworkId?: string | undefined;
  readonly releasePathOrId: string;
  readonly assetPath: string;
  readonly sha256: string;
  readonly widthPx?: number | undefined;
  readonly heightPx?: number | undefined;
  readonly format?: 'png' | 'jpg' | 'jpeg' | 'webp' | undefined;
  readonly notes?: string | undefined;
  readonly provenance?: string | undefined;
  readonly actor?: string | undefined;
};

export type ReleaseDeliveryInput = {
  readonly deliveryId?: string | undefined;
  readonly releasePathOrId: string;
  readonly distributor: string;
  readonly status: DeliveryStatus;
  readonly deliveryDate?: string | null | undefined;
  readonly externalRef?: string | null | undefined;
  readonly notes?: string | undefined;
  readonly provenance?: string | undefined;
  readonly actor?: string | undefined;
};

export type SongLinkInput = {
  readonly linkId?: string | undefined;
  readonly songPathOrId: string;
  readonly linkType: SongLinkType;
  readonly targetId: string;
  readonly targetVaultPath?: string | undefined;
  readonly notes?: string | undefined;
  readonly provenance?: string | undefined;
  readonly actor?: string | undefined;
};

export type SongLinkRetractionInput = {
  readonly linkId: string;
  readonly reason: string;
  readonly actor?: string | undefined;
};

export type CatalogCheckSeverity = 'blocker' | 'warning';

export type CatalogReadinessCheck = {
  readonly checkId: string;
  readonly ruleCode:
    | 'SONG_MISSING_APPROVED_LYRIC'
    | 'SONG_MISSING_WRITER_CREDIT'
    | 'RELEASE_NO_TRACKS'
    | 'RELEASE_MISSING_UPC'
    | 'RELEASE_NON_CONTIGUOUS_POSITIONS'
    | 'RELEASE_MISSING_ARTWORK'
    | 'TRACK_MISSING_ISRC'
    | 'TRACK_MISSING_SPLITS'
    | 'TRACK_UNASSIGNED_SHARE'
    | 'TRACK_SPLIT_SUM_INVALID'
    | 'TRACK_NO_SOURCE_OR_MASTER'
    | 'TRACK_UNAPPROVED_AUDIO_SOURCE'
    | 'DAW_SESSION_DRIFT_OR_CRITICAL_AUDIO';
  readonly severity: CatalogCheckSeverity;
  readonly entityType: 'song' | 'release' | 'track' | 'daw_link';
  readonly entityId: string;
  readonly vaultPath: string;
  readonly message: string;
};

export type CatalogReadinessReport = {
  readonly computedAt: string;
  readonly readyForRelease: boolean;
  readonly blockerCount: number;
  readonly warningCount: number;
  readonly checks: readonly CatalogReadinessCheck[];
};

export type AlbumContinuityReport = {
  readonly releaseId: string;
  readonly title: string;
  readonly kind: string;
  readonly upc: string | null;
  readonly status: ReleaseStatus;
  readonly trackCount: number;
  readonly contiguousPositions: boolean;
  readonly tracks: ReadonlyArray<{
    readonly trackId: string;
    readonly title: string;
    readonly position: number;
    readonly isrc: string | null;
    readonly splitVersion: number | null;
    readonly hasUnassignedShare: boolean;
    readonly masterVersionIds: readonly string[];
    readonly dawLinkIds: readonly string[];
  }>;
  readonly artworkCount: number;
  readonly latestArtworkId: string | null;
  readonly deliveryCount: number;
  readonly latestDeliveryStatus: DeliveryStatus | null;
  readonly blockers: readonly CatalogReadinessCheck[];
  readonly warnings: readonly CatalogReadinessCheck[];
};

export type DawCatalogTargetKind =
  | 'song'
  | 'music_project'
  | 'album'
  | 'release'
  | 'mix_version'
  | 'master_version';

export type DawCatalogLinkInput = {
  readonly linkId?: string | undefined;
  readonly targetKind: DawCatalogTargetKind;
  readonly targetPathOrId: string;
  readonly dawHost: 'fl_studio' | 'reaper' | 'simulated' | 'generic_daw';
  readonly dawProjectPath: string;
  readonly dawSessionId?: string | undefined;
  readonly dawSnapshotId?: string | undefined;
  readonly hasUnsavedLiveChanges?: boolean | undefined;
  readonly audioAnalysisId?: string | undefined;
  readonly audioAnalysisVerdict?: 'PASS' | 'WARN' | 'CRITICAL' | undefined;
  readonly audioSha256?: string | undefined;
  readonly pluginChainId?: string | undefined;
  readonly workflowIds?: readonly string[] | undefined;
  readonly treatDawProjectAsAuthoritativeCatalog?: boolean | undefined;
  readonly provenance: string;
  readonly actor?: string | undefined;
};

export type DawCatalogLinkRecord = {
  readonly linkId: string;
  readonly vaultPath: string;
  readonly targetKind: DawCatalogTargetKind;
  readonly targetId: string;
  readonly dawHost: string;
  readonly dawProjectPath: string;
  readonly dawSessionId: string | null;
  readonly audioAnalysisId: string | null;
  readonly audioAnalysisVerdict: string | null;
  readonly pluginChainId: string | null;
  readonly workflowIds: readonly string[];
  readonly hasUnsavedLiveChanges: boolean;
  readonly authoritativeCatalogRecord: false;
  readonly createdAt: string;
};

export type DawPromotionGuardReport = {
  readonly targetId: string;
  readonly allowed: boolean;
  readonly linkedSessions: number;
  readonly reasons: readonly string[];
};

export type RecordsMigrationDisposition =
  | 'migrated'
  | 'skipped_idempotent'
  | 'rejected'
  | 'conflicting'
  | 'incomplete';

export type RecordsMigrationEntityType =
  | 'music_project'
  | 'contributor'
  | 'contributor_alias'
  | 'song'
  | 'song_revision'
  | 'lyric_version'
  | 'creative_approval'
  | 'suno_submission'
  | 'suno_take'
  | 'critique'
  | 'release'
  | 'track'
  | 'rights_split'
  | 'split_proposal'
  | 'credit'
  | 'credit_retraction'
  | 'mix_version'
  | 'master_version'
  | 'platform_link'
  | 'platform_link_retraction'
  | 'release_artwork'
  | 'release_delivery'
  | 'song_link'
  | 'song_link_retraction'
  | 'daw_catalog_link';

export type RecordsMigrationItemResult = {
  readonly entityType: RecordsMigrationEntityType;
  readonly legacyId: string;
  readonly os3Id: string | null;
  readonly disposition: RecordsMigrationDisposition;
  readonly vaultPath: string | null;
  readonly reason: string;
  readonly sourceTable: string;
};

export type RecordsLegacyScanItem = {
  readonly relativePath: string;
  readonly directoryGroup: '06_RECORDS' | '09_X3LIUS_MUSIC';
  readonly hasOs3Schema: boolean;
  readonly schema: string | null;
  readonly entityId: string | null;
  readonly title: string | null;
  readonly missingOs3Fields: readonly string[];
  readonly disposition: 'valid_os3' | 'idempotent_existing' | 'incomplete_legacy' | 'invalid_frontmatter';
};

export type TransactionalBoundaryAssessment = {
  readonly os2Mechanism: string;
  readonly os3Guarantee: string;
  readonly status: 'preserved_via_sqlite_and_vault_cas' | 'retained_read_only_in_os2_postgres';
  readonly notes: string;
};

export type Os2FullRecordsMusicExport = {
  readonly exportedAt: string;
  readonly sourceSystem: string;
  readonly musicProjects?: readonly {
    readonly id: string;
    readonly title: string;
    readonly artist?: string | undefined;
    readonly releaseKind?: 'single' | 'ep' | 'album' | undefined;
    readonly status?: MusicProjectStatus | undefined;
    readonly description?: string | undefined;
    readonly songIds?: readonly string[] | undefined;
    readonly releaseIds?: readonly string[] | undefined;
    readonly dawProjectPaths?: readonly string[] | undefined;
  }[] | undefined;
  readonly people?: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly kind?: ContributorKind | undefined;
    readonly ipi?: string | null | undefined;
    readonly pro?: string | null | undefined;
    readonly isni?: string | null | undefined;
    readonly bio?: string | undefined;
  }[] | undefined;
  readonly personAliases?: readonly {
    readonly id: string;
    readonly personId: string;
    readonly alias: string;
  }[] | undefined;
  readonly songs: readonly {
    readonly id: string;
    readonly title: string;
    readonly artist: string;
    readonly language: string;
    readonly status?: string | undefined;
    readonly createdAt?: string | undefined;
  }[];
  readonly songRevisions?: readonly {
    readonly songId: string;
    readonly revision: number;
    readonly field: 'brief' | 'tags' | 'style' | 'lyrics_ref' | 'notes';
    readonly content: string;
    readonly author?: string | undefined;
    readonly summary?: string | undefined;
  }[] | undefined;
  readonly lyricVersions: readonly {
    readonly id?: string | undefined;
    readonly lineageId: string;
    readonly songId?: string | undefined;
    readonly title: string;
    readonly language: string;
    readonly version: number;
    readonly sections: Readonly<Record<string, string>>;
    readonly approved?: boolean | undefined;
    readonly proposer?: string | undefined;
    readonly approver?: string | undefined;
    readonly reason?: string | undefined;
  }[];
  readonly takes?: readonly {
    readonly id: string;
    readonly submissionId: string;
    readonly songId: string;
    readonly sunoModel: string;
    readonly stylePrompt: string;
    readonly durationSec: number;
    readonly audioSha256: string;
    readonly isSelected?: boolean | undefined;
    readonly critiques?: readonly {
      readonly dimension: string;
      readonly verdict: 'pass' | 'needs_revision' | 'fail';
      readonly notes: string;
      readonly actor?: string | undefined;
    }[] | undefined;
  }[] | undefined;
  readonly mixVersions?: readonly {
    readonly id: string;
    readonly songId: string;
    readonly projectId?: string | undefined;
    readonly version: number;
    readonly title?: string | undefined;
    readonly audioSha256: string;
    readonly integratedLufs?: number | null | undefined;
    readonly truePeakDbtp?: number | null | undefined;
    readonly dawSessionId?: string | null | undefined;
    readonly audioAnalysisId?: string | null | undefined;
    readonly notes?: string | undefined;
  }[] | undefined;
  readonly masterVersions?: readonly {
    readonly id: string;
    readonly songId: string;
    readonly trackId?: string | undefined;
    readonly mixVersionId?: string | undefined;
    readonly version: number;
    readonly title?: string | undefined;
    readonly audioSha256: string;
    readonly integratedLufs?: number | null | undefined;
    readonly truePeakDbtp?: number | null | undefined;
    readonly isrc?: string | null | undefined;
    readonly approved?: boolean | undefined;
    readonly proposer?: string | undefined;
    readonly approver?: string | undefined;
    readonly reason?: string | undefined;
  }[] | undefined;
  readonly releases: readonly {
    readonly id: string;
    readonly title: string;
    readonly artist: string;
    readonly kind: 'single' | 'ep' | 'album';
    readonly upc: string | null;
    readonly releaseDate: string | null;
    readonly status: 'draft' | 'scheduled' | 'released';
    readonly approvedBy?: string | undefined;
  }[];
  readonly tracks: readonly {
    readonly id: string;
    readonly releaseId: string;
    readonly position: number;
    readonly title: string;
    readonly songId?: string | undefined;
    readonly takeId?: string | undefined;
    readonly sourcePath?: string | undefined;
    readonly isrc: string | null;
  }[];
  readonly splits: readonly {
    readonly id?: string | undefined;
    readonly trackId: string;
    readonly version: number;
    readonly shares: readonly {
      readonly payee: string | null;
      readonly role: string;
      readonly percentage: number;
    }[];
  }[];
  readonly splitProposals?: readonly {
    readonly id: string;
    readonly trackId: string;
    readonly expectedVersion: number;
    readonly shares: readonly {
      readonly payee: string | null;
      readonly role: string;
      readonly percentage: number;
    }[];
    readonly proposer: string;
    readonly reason: string;
    readonly status?: 'pending' | 'approved' | 'rejected' | undefined;
    readonly approver?: string | undefined;
    readonly decisionReason?: string | undefined;
  }[] | undefined;
  readonly credits?: readonly {
    readonly id: string;
    readonly targetType: 'song' | 'track';
    readonly targetId: string;
    readonly personId: string;
    readonly role: CreditRole;
    readonly notes?: string | undefined;
  }[] | undefined;
  readonly creditRetractions?: readonly {
    readonly id?: string | undefined;
    readonly creditId: string;
    readonly reason: string;
    readonly actor?: string | undefined;
  }[] | undefined;
  readonly platformLinks?: readonly {
    readonly id: string;
    readonly targetType: 'song' | 'release' | 'track';
    readonly targetId: string;
    readonly platform: PlatformName;
    readonly url: string;
    readonly handle?: string | null | undefined;
  }[] | undefined;
  readonly platformLinkRetractions?: readonly {
    readonly id?: string | undefined;
    readonly linkId: string;
    readonly reason: string;
    readonly actor?: string | undefined;
  }[] | undefined;
  readonly releaseArtwork?: readonly {
    readonly id: string;
    readonly releaseId: string;
    readonly assetPath: string;
    readonly sha256: string;
    readonly widthPx?: number | undefined;
    readonly heightPx?: number | undefined;
    readonly format?: 'png' | 'jpg' | 'jpeg' | 'webp' | undefined;
    readonly notes?: string | undefined;
  }[] | undefined;
  readonly releaseDeliveries?: readonly {
    readonly id: string;
    readonly releaseId: string;
    readonly distributor: string;
    readonly status: DeliveryStatus;
    readonly deliveryDate?: string | null | undefined;
    readonly externalRef?: string | null | undefined;
    readonly notes?: string | undefined;
  }[] | undefined;
  readonly songLinks?: readonly {
    readonly id: string;
    readonly songId: string;
    readonly linkType: SongLinkType;
    readonly targetId: string;
    readonly notes?: string | undefined;
  }[] | undefined;
  readonly songLinkRetractions?: readonly {
    readonly id?: string | undefined;
    readonly linkId: string;
    readonly reason: string;
    readonly actor?: string | undefined;
  }[] | undefined;
  readonly dawLinks?: readonly {
    readonly id: string;
    readonly targetKind: DawCatalogTargetKind;
    readonly targetId: string;
    readonly dawHost: 'fl_studio' | 'reaper' | 'simulated' | 'generic_daw';
    readonly dawProjectPath: string;
    readonly dawSessionId?: string | undefined;
    readonly audioAnalysisId?: string | undefined;
    readonly audioAnalysisVerdict?: 'PASS' | 'WARN' | 'CRITICAL' | undefined;
    readonly pluginChainId?: string | undefined;
    readonly workflowIds?: readonly string[] | undefined;
    readonly hasUnsavedLiveChanges?: boolean | undefined;
  }[] | undefined;
};

export type RecordsMigrationReport = {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sourceSystem: string;
  readonly dryRun: boolean;
  readonly legacyDataUntouched: true;
  readonly totals: {
    readonly totalEvaluated: number;
    readonly migrated: number;
    readonly skippedIdempotent: number;
    readonly rejected: number;
    readonly conflicting: number;
    readonly incomplete: number;
  };
  readonly items: readonly RecordsMigrationItemResult[];
  readonly legacyMarkdownScan: {
    readonly scannedDirs: readonly string[];
    readonly totalMarkdownFiles: number;
    readonly validOs3Count: number;
    readonly idempotentExistingCount: number;
    readonly incompleteLegacyCount: number;
    readonly invalidFrontmatterCount: number;
    readonly files: readonly RecordsLegacyScanItem[];
  };
  readonly transactionalBoundaries: readonly TransactionalBoundaryAssessment[];
};

export type RecordsParityDomainStats = {
  readonly sourceCount: number;
  readonly validSourceCount: number;
  readonly migratedCount: number;
  readonly skippedIdempotentCount: number;
  readonly presentInOs3Count: number;
  readonly missingIds: readonly string[];
};

export type RecordsParityReport = {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly vaultEntityCount: number;
  readonly sqliteIndexCount: number;
  readonly byDomain: Readonly<Record<string, RecordsParityDomainStats>>;
  readonly readinessChecks: CatalogReadinessReport;
  readonly discrepancies: readonly string[];
};
