import type { Os3ContextEngine, Os3RetrievedContextItem } from '../../context-engine/os3-context-engine.ts';
import type { DawStateSnapshot } from '../types.ts';
import type { DawKnowledgeIntegrationReport, DawSessionAnalysisMetadata } from './types.ts';

const isX3liusRecordItem = (item: Os3RetrievedContextItem): boolean =>
  item.sector === '09_X3LIUS_MUSIC' ||
  item.sector === '06_RECORDS' ||
  item.docType === 'song' ||
  item.docType === 'release' ||
  item.docType === 'production_session';

const dedupByPath = (items: readonly Os3RetrievedContextItem[]): readonly Os3RetrievedContextItem[] => {
  const seen = new Set<string>();
  const out: Os3RetrievedContextItem[] = [];
  for (const item of items) {
    if (!seen.has(item.filePath)) {
      seen.add(item.filePath);
      out.push(item);
    }
  }
  return out;
};

/**
 * Connects ephemeral DAW session observations with Phase 06 Context Engine,
 * matching X3LIUS Music records, production knowledge, plugin docs, strictly
 * user-approved preferences, and historical session records without conflating them.
 */
export const buildSessionKnowledgeIntegration = async (input: {
  readonly contextEngine: Os3ContextEngine;
  readonly snapshot: DawStateSnapshot | null;
  readonly meta: DawSessionAnalysisMetadata;
  readonly projectVaultPath?: string | undefined;
  readonly actor?: string | undefined;
  readonly tokenBudget?: number | undefined;
  readonly queryHint?: string | undefined;
}): Promise<DawKnowledgeIntegrationReport> => {
  const pluginNames =
    input.snapshot?.plugins.status === 'available'
      ? [...new Set(input.snapshot.plugins.value.map((p) => p.name.trim()).filter(Boolean))]
      : [];

  const activeTrackLabel =
    input.snapshot?.mixerChannels.status === 'available'
      ? input.snapshot.mixerChannels.value.find((m) => !m.isMaster)?.name
      : undefined;

  const queryParts = [
    input.meta.project.name,
    input.queryHint,
    pluginNames.slice(0, 6).join(' '),
  ].filter((x): x is string => Boolean(x && x.trim()));

  const query = queryParts.join(' ').trim() || input.meta.adapterId;

  const pkg = await input.contextEngine.retrieveDawContext({
    query,
    sessionId: input.meta.sessionId,
    adapterId: input.meta.adapterId,
    projectVaultPath: input.projectVaultPath,
    activePlugins: pluginNames,
    actor: input.actor ?? 'daw-session-intelligence',
    tokenBudget: input.tokenBudget ?? 3_200,
    liveObservation: input.snapshot
      ? {
          sessionId: input.meta.sessionId,
          adapterId: input.meta.adapterId,
          hostVersion: input.meta.hostVersion,
          observedAt: input.snapshot.provenance.observedAt,
          projectPath: input.meta.project.projectPath,
          transportState: input.snapshot.transport.playing ? 'playing' : 'stopped',
          tempoBpm: Number.isFinite(input.snapshot.transport.tempo.bpm)
            ? input.snapshot.transport.tempo.bpm
            : undefined,
          timeSignature: `${input.snapshot.transport.timeSignature.numerator}/${input.snapshot.transport.timeSignature.denominator}`,
          activeTrack: activeTrackLabel,
          activePlugins: pluginNames,
          matchesSavedProject: !input.meta.hasUnsavedLiveChanges,
        }
      : undefined,
  });

  const x3liusMusicRecords = dedupByPath(
    [...pkg.projectMetadata.projectNotes, ...pkg.historicalRecords.vaultRecords].filter(isX3liusRecordItem),
  );

  const loadedPluginsMatched: string[] = [];
  const loadedPluginsMissingKnowledge: string[] = [];
  for (const plName of pluginNames) {
    const lower = plName.toLowerCase();
    const hit = pkg.pluginDocumentation.some(
      (doc) =>
        doc.title.toLowerCase().includes(lower) ||
        doc.relevantExcerpt.toLowerCase().includes(lower),
    );
    if (hit) loadedPluginsMatched.push(plName);
    else loadedPluginsMissingKnowledge.push(plName);
  }

  const historicalSessionDeltas: string[] = [];
  if (pkg.historicalRecords.recentAudioAnalyses.length > 0) {
    const latestAudio = pkg.historicalRecords.recentAudioAnalyses[0]!;
    const score = latestAudio.traceReport.score ?? latestAudio.traceAnalysis.integrated_lufs ?? 'n/a';
    const verdict = String(latestAudio.traceReport.verdict ?? latestAudio.traceReport.status ?? 'recorded');
    historicalSessionDeltas.push(
      `Latest stored Audio Brain analysis (${latestAudio.createdAt}, ${latestAudio.sourceKind}) reported score=${String(score)}, verdict=${verdict}`,
    );
  }
  if (pkg.historicalRecords.recentCommands.length > 0) {
    historicalSessionDeltas.push(
      `${pkg.historicalRecords.recentCommands.length} historical DAW command journal entry/entries recorded for session`,
    );
  }

  return {
    query,
    contextAssembledAt: pkg.assembledAt,
    epistemicSeparationNotice: pkg.epistemicSeparationNotice,
    x3liusMusicRecords,
    productionKnowledge: pkg.productionKnowledge,
    pluginKnowledge: pkg.pluginDocumentation,
    userApprovedPreferences: pkg.userApprovedPreferences,
    historicalVaultRecords: pkg.historicalRecords.vaultRecords,
    recentCommands: pkg.historicalRecords.recentCommands,
    recentAudioAnalyses: pkg.historicalRecords.recentAudioAnalyses,
    loadedPluginsMatched,
    loadedPluginsMissingKnowledge,
    historicalSessionDeltas,
    contextPackage: pkg,
  };
};
