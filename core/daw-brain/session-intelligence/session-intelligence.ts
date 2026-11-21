import type { Os3ContextEngine } from '../../context-engine/os3-context-engine.ts';
import type { DawSession, DawStateSnapshot } from '../types.ts';
import { buildSessionKnowledgeIntegration } from './knowledge-bridge.ts';
import { analyzeSessionCore, sessionToMetadata } from './session-analyzer.ts';
import { compareDawSnapshots } from './snapshot-diff.ts';
import type {
  AnalyzeDawSessionOptions,
  DawKnowledgeIntegrationReport,
  DawSessionAnalysisMetadata,
  DawSessionAnalysisReport,
  DawSnapshotComparison,
} from './types.ts';

export const formatSessionAnalysisMarkdown = (report: DawSessionAnalysisReport): string => {
  const lines: string[] = [
    `# DAW Session Intelligence Report — ${report.projectName}`,
    '',
    `- **Report ID:** \`${report.reportId}\``,
    `- **Project / Session ID:** \`${report.projectId}\` / \`${report.sessionId}\``,
    `- **DAW & Version:** ${report.daw.hostName} \`${report.daw.version}\` (${report.daw.edition}) via \`${report.daw.adapterId}\``,
    `- **Observation Timestamp:** \`${report.observationTimestamp}\``,
    `- **Data Freshness:** \`${report.dataFreshness.stateFreshness}\` (live=${String(report.dataFreshness.isLive)}, stale=${String(report.dataFreshness.isStale)}, unsavedChanges=${String(report.dataFreshness.hasUnsavedLiveChanges)})`,
    `- **Confidence:** \`${report.confidence.level}\` (${report.confidence.score}) — ${report.confidence.rationale}`,
    '',
    '## Evidence',
    ...report.evidence.map((e) => `- ${e}`),
    '',
    '## Routing & Signal Flow',
    `- **Observability:** \`${report.routingGraph.observabilityStatus}\` — ${report.routingGraph.observabilityReason}`,
    `- **Nodes / Edges / Chains:** ${report.routingGraph.nodes.length} / ${report.routingGraph.edges.length} / ${report.routingGraph.signalFlowChains.length}`,
    ...(report.routingGraph.signalFlowChains.slice(0, 8).map((c) => `  - \`${c.join(' -> ')}\``)),
    '',
    '## Findings',
    ...report.findings.map((f) => `- **[${f.severity.toUpperCase()}] ${f.title}**: ${f.detail}`),
    '',
    '## Limitations (Inaccessible / Unsupported Data)',
    ...(report.limitations.length > 0
      ? report.limitations.map((l) => `- ${l}`)
      : ['- None reported; all core domains accessible']),
    '',
    '## Recommended Next Actions',
    ...report.recommendedNextActions.map(
      (a) => `- **[${a.priority.toUpperCase()}] ${a.title}** (\`${a.actionType}\`, approval=${String(a.requiresApproval)}): ${a.rationale}`,
    ),
  ];

  if (report.stateDiffFromPrevious) {
    lines.push(
      '',
      '## State Change Detection',
      `- ${report.stateDiffFromPrevious.summary} (\`${report.stateDiffFromPrevious.freshnessTransition}\`)`,
    );
  }

  return lines.join('\n');
};

/**
 * Vendor-independent DAW Session Intelligence engine layered over `DawCore` / adapters
 * and Phase 06 `Os3ContextEngine`. Interprets accessible session structure cleanly without
 * fabricating unsupported or unavailable fields.
 */
export class DawSessionIntelligence {
  readonly #contextEngine: Os3ContextEngine | null;
  readonly #lastSnapshotBySession = new Map<string, DawStateSnapshot>();
  readonly #lastReportBySession = new Map<string, DawSessionAnalysisReport>();

  constructor(options: { readonly contextEngine?: Os3ContextEngine | null | undefined } = {}) {
    this.#contextEngine = options.contextEngine ?? null;
  }

  async analyzeSession(
    session: DawSession,
    options: AnalyzeDawSessionOptions = {},
  ): Promise<DawSessionAnalysisReport> {
    const activeSnapshot = session.observed ?? session.cached ?? null;
    const meta = sessionToMetadata(session, {
      hostKind: options.hostKind,
      hostName: options.hostName,
      edition: options.edition,
    });
    return this.#runAnalysis(activeSnapshot, meta, options);
  }

  async analyzeSnapshot(
    snapshot: DawStateSnapshot | null,
    meta: DawSessionAnalysisMetadata,
    options: AnalyzeDawSessionOptions = {},
  ): Promise<DawSessionAnalysisReport> {
    return this.#runAnalysis(snapshot, meta, options);
  }

  compareSnapshots(before: DawStateSnapshot, after: DawStateSnapshot): DawSnapshotComparison {
    return compareDawSnapshots(before, after);
  }

  getLastReport(sessionId: string): DawSessionAnalysisReport | null {
    return this.#lastReportBySession.get(sessionId) ?? null;
  }

  formatMarkdownReport(report: DawSessionAnalysisReport): string {
    return formatSessionAnalysisMarkdown(report);
  }

  async #runAnalysis(
    snapshot: DawStateSnapshot | null,
    meta: DawSessionAnalysisMetadata,
    options: AnalyzeDawSessionOptions,
  ): Promise<DawSessionAnalysisReport> {
    const ctxEngine = options.contextEngine ?? this.#contextEngine;
    let knowledgeContext: DawKnowledgeIntegrationReport | null = null;
    if (ctxEngine) {
      knowledgeContext = await buildSessionKnowledgeIntegration({
        contextEngine: ctxEngine,
        snapshot,
        meta,
        projectVaultPath: options.projectVaultPath,
        actor: options.actor,
        tokenBudget: options.tokenBudget,
        queryHint: options.queryHint,
      });
    }

    const prevSnap = options.previousSnapshot ?? this.#lastSnapshotBySession.get(meta.sessionId);
    const prevReport = options.previousReport ?? this.#lastReportBySession.get(meta.sessionId);

    const report = analyzeSessionCore({
      snapshot,
      meta,
      knowledgeContext,
      previousSnapshot: prevSnap,
      previousReport: prevReport,
    });

    if (snapshot) {
      this.#lastSnapshotBySession.set(meta.sessionId, snapshot);
    }
    this.#lastReportBySession.set(meta.sessionId, report);
    return report;
  }
}
