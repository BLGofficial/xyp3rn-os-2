import type {
  DawAudioAnalysisRecord,
  DawCommandJournalRecord,
  DawSessionRecord,
  IndexEntryRecord,
  SqliteRuntimeDb,
} from '../sqlite/client.ts';
import type { VaultEngine } from '../vault-engine/vault-engine.ts';
import type {
  Os3ContextEngine,
  Os3RetrievedContextItem,
  RetrieveContextOptions,
} from './os3-context-engine.ts';

export type DawObservationSourceTier = 'liveObserved' | 'cached_stale' | 'none';

export type DawLiveObservationInput = {
  readonly sessionId?: string | undefined;
  readonly adapterId?: string | undefined;
  readonly hostVersion?: string | undefined;
  readonly observedAt?: string | undefined;
  readonly projectPath?: string | null | undefined;
  readonly transportState?: string | undefined;
  readonly tempoBpm?: number | undefined;
  readonly timeSignature?: string | undefined;
  readonly activeTrack?: string | undefined;
  readonly activePlugins?: readonly string[] | undefined;
  readonly activeCapabilities?: readonly string[] | undefined;
  readonly telemetry?: Readonly<Record<string, unknown>> | undefined;
  readonly matchesSavedProject?: boolean | undefined;
};

export type DawContextRequest = {
  readonly query: string;
  readonly sessionId?: string | undefined;
  readonly adapterId?: string | undefined;
  readonly projectVaultPath?: string | undefined;
  readonly liveObservation?: DawLiveObservationInput | undefined;
  readonly activePlugins?: readonly string[] | undefined;
  readonly tokenBudget?: number | undefined;
  readonly maxItemsPerSection?: number | undefined;
  readonly actor?: string | undefined;
  readonly bypassCache?: boolean | undefined;
};

/**
 * Ephemeral live or cached DAW state snapshot.
 * Explicitly quarantined from stored canonical/draft Obsidian knowledge.
 */
export type DawLiveObservationPackage = {
  readonly sourceTier: DawObservationSourceTier;
  readonly isLiveEphemeral: true;
  readonly authoritativeForKnowledge: false;
  readonly persistedInVault: false;
  readonly sessionId: string | null;
  readonly adapterId: string | null;
  readonly hostVersion: string | null;
  readonly observedAt: string | null;
  readonly summary: string;
  readonly telemetry: Readonly<Record<string, unknown>> | null;
  readonly estimatedTokens: number;
};

export type DawProjectMetadataSection = {
  readonly sessionId: string | null;
  readonly adapterId: string | null;
  readonly hostVersion: string | null;
  readonly projectPath: string | null;
  readonly savedSha256: string | null;
  readonly matchesLiveState: boolean | null;
  readonly sessionStatus: string | null;
  readonly projectNotes: readonly Os3RetrievedContextItem[];
};

export type DawHistoricalRecordsSection = {
  readonly vaultRecords: readonly Os3RetrievedContextItem[];
  readonly recentCommands: readonly DawCommandJournalRecord[];
  readonly recentAudioAnalyses: readonly DawAudioAnalysisRecord[];
};

export type DawContextPackage = {
  readonly query: string;
  readonly assembledAt: string;
  readonly epistemicSeparationNotice: string;
  readonly liveObservation: DawLiveObservationPackage;
  readonly projectMetadata: DawProjectMetadataSection;
  readonly pluginDocumentation: readonly Os3RetrievedContextItem[];
  readonly productionKnowledge: readonly Os3RetrievedContextItem[];
  readonly userApprovedPreferences: readonly Os3RetrievedContextItem[];
  readonly historicalRecords: DawHistoricalRecordsSection;
  readonly totalTokens: number;
  readonly tokenBudget: number;
  readonly truncatedByBudget: boolean;
};

export type DawContextDependencies = {
  readonly vault: VaultEngine;
  readonly db: SqliteRuntimeDb;
  readonly contextEngine: Os3ContextEngine;
};

const estimateTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.trim().length / 4));

const normalizeList = (values: readonly string[] | undefined): readonly string[] => {
  if (!values || values.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const val of values) {
    const clean = val.trim();
    if (clean && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase());
      out.push(clean);
    }
  }
  return out;
};

const extractPluginsFromTelemetry = (snapshot: Readonly<Record<string, unknown>> | null): readonly string[] => {
  if (!snapshot) return [];
  const raw = snapshot.activePlugins ?? snapshot.plugins;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
};

const buildLiveObservationPackage = (
  liveInput: DawLiveObservationInput | undefined,
  sqliteSession: DawSessionRecord | null,
): DawLiveObservationPackage => {
  if (liveInput) {
    const telemetry: Record<string, unknown> = {
      ...(liveInput.telemetry ?? {}),
    };
    if (liveInput.transportState !== undefined) telemetry.transportState = liveInput.transportState;
    if (liveInput.tempoBpm !== undefined) telemetry.tempoBpm = liveInput.tempoBpm;
    if (liveInput.timeSignature !== undefined) telemetry.timeSignature = liveInput.timeSignature;
    if (liveInput.activeTrack !== undefined) telemetry.activeTrack = liveInput.activeTrack;
    if (liveInput.activePlugins !== undefined) telemetry.activePlugins = liveInput.activePlugins;
    if (liveInput.activeCapabilities !== undefined) telemetry.activeCapabilities = liveInput.activeCapabilities;

    const adapterId = liveInput.adapterId ?? sqliteSession?.adapterId ?? null;
    const hostVersion = liveInput.hostVersion ?? sqliteSession?.hostVersion ?? null;
    const parts = [
      'EPHEMERAL LIVE OBSERVATION (NOT CANONICAL KNOWLEDGE)',
      adapterId ? `adapter=${adapterId}` : null,
      hostVersion ? `host=${hostVersion}` : null,
      liveInput.transportState ? `transport=${liveInput.transportState}` : null,
      liveInput.tempoBpm !== undefined ? `bpm=${liveInput.tempoBpm}` : null,
      liveInput.activeTrack ? `track="${liveInput.activeTrack}"` : null,
      liveInput.activePlugins && liveInput.activePlugins.length > 0
        ? `plugins=[${liveInput.activePlugins.join(', ')}]`
        : null,
    ].filter((part): part is string => Boolean(part));

    const summary = parts.join(' | ');
    return {
      sourceTier: 'liveObserved',
      isLiveEphemeral: true,
      authoritativeForKnowledge: false,
      persistedInVault: false,
      sessionId: liveInput.sessionId ?? sqliteSession?.id ?? null,
      adapterId,
      hostVersion,
      observedAt: liveInput.observedAt ?? new Date().toISOString(),
      summary,
      telemetry: Object.keys(telemetry).length > 0 ? telemetry : null,
      estimatedTokens: estimateTokens(summary + JSON.stringify(telemetry)),
    };
  }

  if (sqliteSession?.cachedSnapshot) {
    const summary = [
      'STALE CACHED RUNTIME SNAPSHOT (NOT CURRENT LIVE STATE, NOT CANONICAL KNOWLEDGE)',
      `adapter=${sqliteSession.adapterId}`,
      `host=${sqliteSession.hostVersion}`,
      sqliteSession.cachedAt ? `cachedAt=${sqliteSession.cachedAt}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' | ');
    return {
      sourceTier: 'cached_stale',
      isLiveEphemeral: true,
      authoritativeForKnowledge: false,
      persistedInVault: false,
      sessionId: sqliteSession.id,
      adapterId: sqliteSession.adapterId,
      hostVersion: sqliteSession.hostVersion,
      observedAt: sqliteSession.cachedAt,
      summary,
      telemetry: sqliteSession.cachedSnapshot,
      estimatedTokens: estimateTokens(summary + JSON.stringify(sqliteSession.cachedSnapshot)),
    };
  }

  const summary = 'No live DAW telemetry or cached runtime snapshot available (read-only idle).';
  return {
    sourceTier: 'none',
    isLiveEphemeral: true,
    authoritativeForKnowledge: false,
    persistedInVault: false,
    sessionId: sqliteSession?.id ?? null,
    adapterId: sqliteSession?.adapterId ?? null,
    hostVersion: sqliteSession?.hostVersion ?? null,
    observedAt: null,
    summary,
    telemetry: null,
    estimatedTokens: estimateTokens(summary),
  };
};

const isVerifiedApprovedRecord = (
  item: Os3RetrievedContextItem,
  indexEntry: IndexEntryRecord | null,
): boolean => {
  const status = (item.status ?? indexEntry?.status ?? '').toLowerCase();
  if (status !== 'canonical' && status !== 'approved') {
    return false;
  }
  const fm = indexEntry?.frontmatter;
  if (!fm) return status === 'canonical' || status === 'approved';
  const rejectedStatuses = new Set(['draft', 'pending', 'pending_approval', 'rejected', 'archived', 'superseded']);
  const fmStatus = typeof fm.status === 'string' ? fm.status.toLowerCase() : '';
  if (rejectedStatuses.has(fmStatus)) {
    return false;
  }
  return true;
};

const isPreferenceCandidate = (
  item: Os3RetrievedContextItem,
  indexEntry: IndexEntryRecord | null,
): boolean => {
  const docType = (item.docType ?? indexEntry?.docType ?? '').toLowerCase();
  if (docType === 'mix_reference' || docType === 'preference' || docType === 'canonical_prompt') {
    return true;
  }
  const tags = indexEntry?.tags.map((t) => t.toLowerCase()) ?? [];
  if (
    tags.some((tag) =>
      tag.includes('preference') || tag.includes('house-style') || tag.includes('mastering-target') || tag.includes('mix-reference'),
    )
  ) {
    return true;
  }
  const pathLower = item.filePath.toLowerCase();
  if (pathLower.includes('preference') || pathLower.includes('mix_ref') || pathLower.includes('mix-ref')) {
    return true;
  }
  const fm = indexEntry?.frontmatter;
  const cat = typeof fm?.category === 'string' ? fm.category.toLowerCase() : '';
  return cat === 'preference' || cat === 'user_preference' || cat === 'mix_reference';
};

const selectSectionWithinBudget = (
  candidates: readonly Os3RetrievedContextItem[],
  seenPaths: Set<string>,
  maxItems: number,
  remainingBudget: number,
  onBudgetExceeded: () => void,
): { readonly items: readonly Os3RetrievedContextItem[]; readonly tokensUsed: number } => {
  const items: Os3RetrievedContextItem[] = [];
  let tokensUsed = 0;

  for (const item of candidates) {
    if (items.length >= maxItems) break;
    if (seenPaths.has(item.filePath)) continue;

    if (tokensUsed + item.estimatedTokens > remainingBudget) {
      onBudgetExceeded();
      continue;
    }

    seenPaths.add(item.filePath);
    items.push(item);
    tokensUsed += item.estimatedTokens;
  }

  return { items, tokensUsed };
};

/**
 * Assembles a bounded DAW Brain Context Package combining ephemeral DAW telemetry,
 * saved project/session metadata, plugin documentation, production knowledge,
 * strictly verified user-approved preferences, and historical Vault/SQLite records,
 * while guaranteeing strict epistemic separation between live observations and stored knowledge.
 */
export const buildDawContextPackage = async (
  deps: DawContextDependencies,
  req: DawContextRequest,
): Promise<DawContextPackage> => {
  const tokenBudget = Math.max(100, req.tokenBudget ?? 3_000);
  const maxPerSection = Math.max(1, req.maxItemsPerSection ?? 5);
  const actor = req.actor ?? 'system';

  const sqliteSession = req.sessionId
    ? deps.db.getDawSession(req.sessionId)
    : (deps.db.listDawSessions('connected', 1)[0] ?? deps.db.listDawSessions(undefined, 1)[0] ?? null);

  const liveObservation = buildLiveObservationPackage(req.liveObservation, sqliteSession);
  const pluginNames = normalizeList([
    ...(req.activePlugins ?? []),
    ...(req.liveObservation?.activePlugins ?? []),
    ...extractPluginsFromTelemetry(liveObservation.telemetry),
  ]);

  const commonOpts: Pick<RetrieveContextOptions, 'actor' | 'bypassCache' | 'expandRelationships' | 'tokenBudget'> = {
    actor,
    bypassCache: req.bypassCache,
    expandRelationships: true,
    tokenBudget,
  };

  const projectPath = req.liveObservation?.projectPath ?? sqliteSession?.projectPath ?? null;
  const projectHint = projectPath ? projectPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? '' : '';
  const projectQuery = [req.query, projectHint, req.projectVaultPath].filter((v) => v && v.trim()).join(' ');
  const pluginQuery = pluginNames.length > 0 ? `${req.query} ${pluginNames.join(' ')}` : `${req.query} plugin chain adapter`;

  const [projectPkg, pluginPkg, productionPkg, prefPkg, historyPkg] = await Promise.all([
    deps.contextEngine.retrieveContext(projectQuery || req.query, {
      ...commonOpts,
      docTypes: ['production_session', 'daw_session_report', 'song', 'release'],
      maxItems: maxPerSection * 2,
    }),
    deps.contextEngine.retrieveContext(pluginQuery, {
      ...commonOpts,
      docTypes: ['plugin', 'daw_plugin', 'plugin_chain', 'daw_plugin_chain', 'daw_adapter', 'daw_capability'],
      maxItems: maxPerSection * 2,
    }),
    deps.contextEngine.retrieveContext(req.query, {
      ...commonOpts,
      docTypes: ['dsp_concept', 'production_workflow', 'knowledge', 'canonical_prompt'],
      maxItems: maxPerSection * 2,
    }),
    deps.contextEngine.retrieveContext(`${req.query} preference mix-reference mastering target`, {
      ...commonOpts,
      maxItems: maxPerSection * 4,
    }),
    deps.contextEngine.retrieveContext(req.query, {
      ...commonOpts,
      docTypes: ['production_session', 'audio_analysis', 'daw_session_report', 'song', 'release'],
      sortBy: 'recency',
      maxItems: maxPerSection * 2,
    }),
  ]);

  // Also explicitly verify direct projectVaultPath when provided
  let directProjectItems = projectPkg.items;
  if (req.projectVaultPath && !directProjectItems.some((item) => item.filePath === req.projectVaultPath)) {
    const exactPkg = await deps.contextEngine.retrieveContext(req.projectVaultPath, {
      ...commonOpts,
      maxItems: maxPerSection,
    });
    const matched = exactPkg.items.filter((item) => item.filePath === req.projectVaultPath);
    if (matched.length > 0) {
      directProjectItems = [...matched, ...directProjectItems];
    }
  }

  // Strictly filter user-approved preferences so unapproved drafts NEVER appear as approved preferences
  const approvedPrefCandidates = prefPkg.items.filter((item) => {
    const entry = deps.db.getIndexEntry(item.filePath);
    return isVerifiedApprovedRecord(item, entry) && isPreferenceCandidate(item, entry);
  });

  // Fallback direct index lookup in case approved preference notes exist with lower keyword overlap
  if (approvedPrefCandidates.length < maxPerSection) {
    const extraPrefPkg = await deps.contextEngine.retrieveContext('preference approved canonical mix mastering', {
      ...commonOpts,
      maxItems: maxPerSection * 4,
    });
    const existing = new Set(approvedPrefCandidates.map((item) => item.filePath));
    for (const item of extraPrefPkg.items) {
      if (existing.has(item.filePath)) continue;
      const entry = deps.db.getIndexEntry(item.filePath);
      if (isVerifiedApprovedRecord(item, entry) && isPreferenceCandidate(item, entry)) {
        approvedPrefCandidates.push(item);
        existing.add(item.filePath);
      }
    }
  }

  const recentCommands = sqliteSession ? deps.db.listDawCommandsBySession(sqliteSession.id, maxPerSection) : [];
  const sessionAudioAnalyses = sqliteSession
    ? deps.db.listDawAudioAnalyses({ sessionId: sqliteSession.id, limit: maxPerSection })
    : [];
  const recentAudioAnalyses =
    sessionAudioAnalyses.length > 0
      ? sessionAudioAnalyses
      : deps.db.listDawAudioAnalyses({ limit: maxPerSection });

  const sqlRecordsTokens =
    (recentCommands.length > 0 ? estimateTokens(JSON.stringify(recentCommands)) : 0) +
    (recentAudioAnalyses.length > 0 ? estimateTokens(JSON.stringify(recentAudioAnalyses)) : 0);

  let remainingBudget = Math.max(0, tokenBudget - liveObservation.estimatedTokens - sqlRecordsTokens);
  let totalTokens = liveObservation.estimatedTokens + sqlRecordsTokens;
  let truncatedByBudget = false;
  const markTruncated = (): void => {
    truncatedByBudget = true;
  };
  const seenPaths = new Set<string>();

  const projectSelected = selectSectionWithinBudget(
    directProjectItems,
    seenPaths,
    maxPerSection,
    remainingBudget,
    markTruncated,
  );
  remainingBudget -= projectSelected.tokensUsed;
  totalTokens += projectSelected.tokensUsed;

  const pluginSelected = selectSectionWithinBudget(
    pluginPkg.items,
    seenPaths,
    maxPerSection,
    remainingBudget,
    markTruncated,
  );
  remainingBudget -= pluginSelected.tokensUsed;
  totalTokens += pluginSelected.tokensUsed;

  const prefSelected = selectSectionWithinBudget(
    approvedPrefCandidates,
    seenPaths,
    maxPerSection,
    remainingBudget,
    markTruncated,
  );
  remainingBudget -= prefSelected.tokensUsed;
  totalTokens += prefSelected.tokensUsed;

  const prodSelected = selectSectionWithinBudget(
    productionPkg.items,
    seenPaths,
    maxPerSection,
    remainingBudget,
    markTruncated,
  );
  remainingBudget -= prodSelected.tokensUsed;
  totalTokens += prodSelected.tokensUsed;

  const histSelected = selectSectionWithinBudget(
    historyPkg.items,
    seenPaths,
    maxPerSection,
    remainingBudget,
    markTruncated,
  );
  remainingBudget -= histSelected.tokensUsed;
  totalTokens += histSelected.tokensUsed;

  return {
    query: req.query,
    assembledAt: new Date().toISOString(),
    epistemicSeparationNotice:
      'liveObservation is ephemeral DAW telemetry/cache and is NOT canonical Obsidian knowledge; savedProject metadata and Vault sections represent persisted state and vetted records.',
    liveObservation,
    projectMetadata: {
      sessionId: sqliteSession?.id ?? req.liveObservation?.sessionId ?? null,
      adapterId: sqliteSession?.adapterId ?? req.liveObservation?.adapterId ?? req.adapterId ?? null,
      hostVersion: sqliteSession?.hostVersion ?? req.liveObservation?.hostVersion ?? null,
      projectPath,
      savedSha256: sqliteSession?.savedSha256 ?? null,
      matchesLiveState: req.liveObservation?.matchesSavedProject ?? null,
      sessionStatus: sqliteSession?.status ?? null,
      projectNotes: projectSelected.items,
    },
    pluginDocumentation: pluginSelected.items,
    productionKnowledge: prodSelected.items,
    userApprovedPreferences: prefSelected.items,
    historicalRecords: {
      vaultRecords: histSelected.items,
      recentCommands,
      recentAudioAnalyses,
    },
    totalTokens,
    tokenBudget,
    truncatedByBudget,
  };
};
