import { randomUUID } from 'node:crypto';
import { openRuntimeDb } from '../sqlite/client.ts';
import { Os3ContextEngine } from '../context-engine/os3-context-engine.ts';
import { FlStudio2025Adapter } from '../daw-adapters/fl-studio-2025/fl-studio-adapter.ts';
import { DefaultFlStudioHostProbe } from '../daw-adapters/fl-studio-2025/host-probe.ts';
import { ReaperAdapter } from '../daw-adapters/reaper/reaper-adapter.ts';
import { DefaultReaperHostProbe } from '../daw-adapters/reaper/host-probe.ts';
import type { FlHostEnvironment } from '../daw-adapters/fl-studio-2025/types.ts';
import type { ReaperHostEnvironment } from '../daw-adapters/reaper/types.ts';
import { DAW_AGENT_CATALOG } from '../daw-brain/agents/daw-agent-catalog.ts';
import { DawAgentTeam, type DawAgentExecutionMode, type DawAgentRunResult } from '../daw-brain/agents/daw-agent-team.ts';
import { AudioBrain } from '../daw-brain/audio-brain/audio-brain.ts';
import type { AudioBrainAnalysisReport } from '../daw-brain/audio-brain/types.ts';
import type { DawAdapter } from '../daw-brain/daw-adapter-sdk.ts';
import type { PreparedDawCommand } from '../daw-brain/daw-command-gateway.ts';
import { DawCore } from '../daw-brain/daw-core.ts';
import { DawEvaluationEngine } from '../daw-brain/evaluation/evaluation-engine.ts';
import type { DawEvaluationReport } from '../daw-brain/evaluation/types.ts';
import { PluginBrain } from '../daw-brain/plugin-brain/plugin-brain.ts';
import type { PluginChainAnalysisReport, PluginChainGraph, PluginProfile } from '../daw-brain/plugin-brain/types.ts';
import { DawSessionIntelligence } from '../daw-brain/session-intelligence/session-intelligence.ts';
import type { DawSessionAnalysisReport } from '../daw-brain/session-intelligence/types.ts';
import type {
  DawCapability,
  DawCommand,
  DawCommandResult,
  DawDryRunResult,
  DawExecutionReceipt,
  DawInstance,
  DawSession,
  DawStateDiffEntry,
} from '../daw-brain/types.ts';
import { DAW_PRODUCTION_WORKFLOWS } from '../daw-brain/workflows/daw-workflows.ts';
import { parse as parseYaml } from 'yaml';
import type { Os3JarvisRuntime } from './jarvis-runtime.ts';

const AGENT_OR_SYSTEM_ACTOR_RE =
  /^(agent:|system$|jarvis$|auto$|x3lius-|tech-|records-)|-(agent|researcher|orchestrator|curator|summarizer|retriever|checker|generator|editor|advisor|assessor|forecaster|advocate|engine)$/i;

export type DawHostProbeSummary = {
  readonly hostKind: 'fl_studio' | 'reaper';
  readonly hostName: string;
  readonly probedAt: string;
  readonly installed: boolean;
  readonly running: boolean;
  readonly detectedVersions: readonly string[];
  readonly discoveredProjectCount: number;
  readonly installedPluginCount: number;
  readonly missingPrerequisites: readonly string[];
  readonly warnings: readonly string[];
};

export type DawPreparedProposalView = {
  readonly approvalId: string;
  readonly prepareId: string;
  readonly sessionId: string;
  readonly capabilityId: string;
  readonly commandKind: string;
  readonly commandClass: string;
  readonly riskLevel: string;
  readonly approvalRequirement: string;
  readonly targetRef: string;
  readonly proposer: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly rollbackSupported: boolean;
  readonly wouldSucceed: boolean;
  readonly projectVerified: boolean;
  readonly fresh: boolean;
  readonly warnings: readonly string[];
  readonly postconditionExpectations: readonly string[];
  readonly diff: readonly DawStateDiffEntry[];
  readonly dryRun: DawDryRunResult;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly approver: string | null;
  readonly reason: string | null;
};

export type DawOverviewPayload = {
  readonly ok: true;
  readonly generatedAt: string;
  readonly dataSource: 'os3-gateway-live';
  readonly isDemoFixture: false;
  readonly connectionSummary: {
    readonly state: 'connected' | 'disconnected' | 'degraded';
    readonly connectedSessions: number;
    readonly totalSessions: number;
    readonly activeSessionId: string | null;
    readonly currentDaw: string | null;
    readonly currentVersion: string | null;
    readonly currentProject: string | null;
    readonly lastObservedAt: string | null;
    readonly freshness: string;
    readonly stale: boolean;
    readonly adaptersRegistered: number;
    readonly reachableInstances: number;
  };
  readonly hostProbes: readonly DawHostProbeSummary[];
  readonly adapters: ReadonlyArray<{
    readonly adapterId: string;
    readonly hostKind: string;
    readonly hostName: string;
    readonly supportedVersions: readonly string[];
    readonly transportProtocol: string;
    readonly readOnlyDefault: boolean;
    readonly capabilities: readonly DawCapability[];
  }>;
  readonly discoveredInstances: readonly DawInstance[];
  readonly sessions: readonly DawSession[];
  readonly capabilities: {
    readonly available: readonly DawCapability[];
    readonly unsupported: readonly DawCapability[];
    readonly readOnlyCount: number;
    readonly mutableCount: number;
  };
  readonly activeOperations: ReadonlyArray<{
    readonly id: string;
    readonly kind: 'lease' | 'prepared_command';
    readonly sessionId: string;
    readonly actor: string;
    readonly label: string;
    readonly tierOrRisk: string;
    readonly expiresOrCreatedAt: string;
  }>;
  readonly pendingApprovals: readonly DawPreparedProposalView[];
  readonly executionHistory: readonly DawExecutionReceipt[];
  readonly sessionIntelligence: DawSessionAnalysisReport | null;
  readonly pluginBrain: {
    readonly profiles: readonly PluginProfile[];
    readonly chainGraphs: readonly PluginChainGraph[];
    readonly chainReports: readonly PluginChainAnalysisReport[];
  };
  readonly audioBrain: {
    readonly recentAnalyses: readonly AudioBrainAnalysisReport[];
  };
  readonly agents: ReadonlyArray<{
    readonly name: string;
    readonly class: string;
    readonly domain: string;
    readonly role: string;
    readonly permissions: string;
    readonly tools: readonly string[];
    readonly refuses: string;
    readonly escalatesTo: string;
  }>;
  readonly workflows: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly title: string;
    readonly domain: string;
    readonly description: string;
    readonly requiredInputs: readonly string[];
    readonly stepCount: number;
    readonly steps: ReadonlyArray<{ readonly id: string; readonly agent: string; readonly tool: string; readonly dependsOn: readonly string[] }>;
  }>;
  readonly evaluation: DawEvaluationReport | null;
  readonly events: readonly Record<string, unknown>[];
};

export type DawGatewayControllerOptions = {
  readonly registerDefaultAdapters?: boolean | undefined;
  readonly adapters?: readonly DawAdapter[] | undefined;
  readonly flHostProbe?: { probeHost(): Promise<FlHostEnvironment>; discoverProjects(limit?: number): readonly string[]; scanInstalledPlugins(): readonly unknown[] } | undefined;
  readonly reaperHostProbe?: { probeHost(): Promise<ReaperHostEnvironment>; discoverProjects(limit?: number): readonly string[]; scanInstalledPlugins(): readonly unknown[] } | undefined;
};

/**
 * Coordinates real OS3 DAW Brain subsystems behind `/api/daw/*` HTTP routes.
 * Never fabricates live DAW connections or telemetry: when FL Studio 2025 or REAPER
 * are offline, reports honest disconnected/unsupported states cleanly.
 */
export class DawGatewayController {
  readonly #runtime: Os3JarvisRuntime;
  readonly core: DawCore;
  readonly sessionIntelligence: DawSessionIntelligence;
  readonly pluginBrain: PluginBrain;
  readonly audioBrain: AudioBrain;
  readonly contextEngine: Os3ContextEngine;
  readonly agentTeam: DawAgentTeam;
  readonly evaluationEngine: DawEvaluationEngine;

  readonly #flProbe: DawGatewayControllerOptions['flHostProbe'];
  readonly #reaperProbe: DawGatewayControllerOptions['reaperHostProbe'];
  readonly #preparedByApprovalId = new Map<string, PreparedDawCommand>();
  readonly #audioReports: AudioBrainAnalysisReport[] = [];
  #lastHostProbes: DawHostProbeSummary[] = [];
  #lastDiscoveredInstances: DawInstance[] = [];
  #lastEvaluation: DawEvaluationReport | null = null;

  constructor(runtime: Os3JarvisRuntime, options: DawGatewayControllerOptions = {}) {
    this.#runtime = runtime;
    this.core = new DawCore({ db: runtime.db, staleThresholdMs: 30_000 });
    this.contextEngine = new Os3ContextEngine({ vault: runtime.vault, db: runtime.db });
    this.sessionIntelligence = new DawSessionIntelligence({ contextEngine: this.contextEngine });
    this.pluginBrain = new PluginBrain();
    this.audioBrain = new AudioBrain();
    this.agentTeam = new DawAgentTeam({
      vault: runtime.vault,
      db: runtime.db,
      core: this.core,
      sessionIntelligence: this.sessionIntelligence,
      pluginBrain: this.pluginBrain,
      audioBrain: this.audioBrain,
      contextEngine: this.contextEngine,
    });
    this.evaluationEngine = new DawEvaluationEngine();
    this.#flProbe = options.flHostProbe ?? new DefaultFlStudioHostProbe();
    this.#reaperProbe = options.reaperHostProbe ?? new DefaultReaperHostProbe();

    if (options.adapters) {
      for (const adapter of options.adapters) {
        this.core.registerAdapter(adapter);
      }
    } else if (options.registerDefaultAdapters !== false) {
      this.core.registerAdapter(new FlStudio2025Adapter());
      this.core.registerAdapter(new ReaperAdapter());
    }
  }

  recordAudioReport(report: AudioBrainAnalysisReport): void {
    this.#audioReports.unshift(report);
    if (this.#audioReports.length > 20) this.#audioReports.length = 20;
  }

  async probeHostsAndInstances(): Promise<{
    readonly hostProbes: readonly DawHostProbeSummary[];
    readonly discoveredInstances: readonly DawInstance[];
  }> {
    const probes: DawHostProbeSummary[] = [];

    if (this.#flProbe) {
      try {
        const flEnv = await this.#flProbe.probeHost();
        const flVersions = flEnv.installations
          .filter((i) => i.exists)
          .map((i) => i.productVersion || i.fileVersion || i.label);
        probes.push({
          hostKind: 'fl_studio',
          hostName: 'FL Studio 2025',
          probedAt: flEnv.probedAt,
          installed: flVersions.length > 0,
          running: flEnv.runningProcesses.length > 0,
          detectedVersions: flVersions,
          discoveredProjectCount: this.#flProbe.discoverProjects(50).length,
          installedPluginCount: this.#flProbe.scanInstalledPlugins().length,
          missingPrerequisites: flEnv.missingPrerequisites,
          warnings: flEnv.warnings,
        });
      } catch (err) {
        probes.push({
          hostKind: 'fl_studio',
          hostName: 'FL Studio 2025',
          probedAt: new Date().toISOString(),
          installed: false,
          running: false,
          detectedVersions: [],
          discoveredProjectCount: 0,
          installedPluginCount: 0,
          missingPrerequisites: ['probe_failed'],
          warnings: [(err as Error).message],
        });
      }
    }

    if (this.#reaperProbe) {
      try {
        const rEnv = await this.#reaperProbe.probeHost();
        const rVersions = rEnv.installations
          .filter((i) => i.exists)
          .map((i) => i.productVersion || i.fileVersion || i.label);
        probes.push({
          hostKind: 'reaper',
          hostName: 'Cockos REAPER',
          probedAt: rEnv.probedAt,
          installed: rVersions.length > 0,
          running: rEnv.runningProcesses.length > 0,
          detectedVersions: rVersions,
          discoveredProjectCount: this.#reaperProbe.discoverProjects(50).length,
          installedPluginCount: this.#reaperProbe.scanInstalledPlugins().length,
          missingPrerequisites: rEnv.missingPrerequisites,
          warnings: rEnv.warnings,
        });
      } catch (err) {
        probes.push({
          hostKind: 'reaper',
          hostName: 'Cockos REAPER',
          probedAt: new Date().toISOString(),
          installed: false,
          running: false,
          detectedVersions: [],
          discoveredProjectCount: 0,
          installedPluginCount: 0,
          missingPrerequisites: ['probe_failed'],
          warnings: [(err as Error).message],
        });
      }
    }

    this.#lastHostProbes = probes;
    this.#lastDiscoveredInstances = [...(await this.core.discoverInstances())];
    return { hostProbes: probes, discoveredInstances: this.#lastDiscoveredInstances };
  }

  async connectSession(input: {
    readonly adapterId: string;
    readonly instanceId?: string | undefined;
    readonly projectPath?: string | undefined;
    readonly actor?: string | undefined;
  }): Promise<DawSession> {
    const sess = await this.core.connectSession(input.adapterId, {
      instanceId: input.instanceId,
      projectPath: input.projectPath,
      actor: input.actor ?? 'operator',
    });
    const snap = await this.core.refreshSession(sess.sessionId).catch(() => null);
    if (snap) {
      const adapter = this.core.connections.getAdapter(sess.adapterId);
      const hostKind = adapter?.manifest.hostKind ?? 'generic_daw';
      this.pluginBrain.ingestDawSnapshot(snap, hostKind, 'Unknown');
      const liveSess = this.core.sessions.getSession(sess.sessionId);
      if (liveSess) {
        await this.sessionIntelligence.analyzeSession(liveSess, { hostKind }).catch(() => undefined);
      }
    }
    return this.core.sessions.getSession(sess.sessionId) ?? sess;
  }

  async refreshSession(sessionId: string): Promise<{
    readonly session: DawSession;
    readonly analysis: DawSessionAnalysisReport | null;
  }> {
    const existing = this.core.sessions.getSession(sessionId);
    if (!existing) {
      throw new Error(`DAW session not found or disconnected: "${sessionId}"`);
    }
    const snap = await this.core.refreshSession(sessionId);
    const liveSess = this.core.sessions.getSession(sessionId) ?? existing;
    const adapter = this.core.connections.getAdapter(liveSess.adapterId);
    const hostKind = adapter?.manifest.hostKind ?? 'generic_daw';
    if (snap) {
      this.pluginBrain.ingestDawSnapshot(snap, hostKind, 'Unknown');
    }
    const analysis = await this.sessionIntelligence.analyzeSession(liveSess, { hostKind }).catch(() => null);
    return { session: liveSess, analysis };
  }

  async proposeCommand(input: {
    readonly sessionId: string;
    readonly kind: DawCommand['kind'];
    readonly capabilityId: string;
    readonly targetRef: string;
    readonly params: Record<string, unknown>;
    readonly proposer: string;
    readonly leaseId?: string | undefined;
  }): Promise<{ readonly approvalId: string; readonly prepared: PreparedDawCommand }> {
    const sess = this.core.sessions.getSession(input.sessionId);
    if (!sess) {
      throw new Error(`DAW session not found: "${input.sessionId}"`);
    }
    const command: DawCommand = {
      commandId: `dawcmd-${randomUUID().slice(0, 8)}`,
      sessionId: input.sessionId,
      kind: input.kind,
      capabilityId: input.capabilityId,
      targetRef: input.targetRef,
      params: input.params,
      expectedProjectId: sess.project.projectId,
      expectedProjectPath: sess.project.projectPath ?? undefined,
      requestedBy: input.proposer,
      requestedClass: 'Execution',
      correlationId: `corr-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
    };
    const prepared = await this.core.prepareCommand(command, {
      leaseId: input.leaseId,
      queueApproval: true,
    });
    const approvalId = prepared.approvalId ?? prepared.prepareId;
    this.#preparedByApprovalId.set(approvalId, prepared);
    return { approvalId, prepared };
  }

  async decideCommandApproval(input: {
    readonly approvalId: string;
    readonly decision: 'approved' | 'rejected';
    readonly approver: string;
    readonly reason: string;
    readonly confirmDangerous?: boolean | undefined;
  }): Promise<{
    readonly ok: true;
    readonly approvalId: string;
    readonly decision: 'approved' | 'rejected';
    readonly executionResult: DawCommandResult | null;
  }> {
    const approver = input.approver.trim();
    if (!approver || !input.reason.trim()) {
      throw new Error('approver and reason are required');
    }
    if (input.decision === 'approved' && AGENT_OR_SYSTEM_ACTOR_RE.test(approver)) {
      throw new Error(`SELF_APPROVAL_FORBIDDEN: Agent/system identity "${approver}" cannot approve mutable DAW commands`);
    }

    const row = this.#runtime.db.getApproval(input.approvalId);
    const prepared = this.#preparedByApprovalId.get(input.approvalId) ?? null;
    if (row && row.proposer.trim().toLowerCase() === approver.toLowerCase() && input.decision === 'approved') {
      throw new Error(`SELF_APPROVAL_FORBIDDEN: Proposer "${row.proposer}" cannot approve own command`);
    }

    if (input.decision === 'rejected') {
      if (prepared) {
        this.core.cancelCommand(prepared.prepareId, approver, input.reason);
      }
      if (row && row.status === 'pending') {
        this.#runtime.db.decideApproval({
          approvalId: row.id,
          decision: 'rejected',
          approver,
          reason: input.reason,
        });
      }
      return { ok: true, approvalId: input.approvalId, decision: 'rejected', executionResult: null };
    }

    if (!prepared) {
      throw new Error(`Prepared command for approval "${input.approvalId}" is no longer staged in gateway memory`);
    }
    const isHighRisk =
      prepared.assessment.riskLevel === 'high' ||
      prepared.assessment.riskLevel === 'critical' ||
      prepared.assessment.commandClass === 'potentially_destructive' ||
      prepared.assessment.commandClass === 'irreversible';
    if (isHighRisk && input.confirmDangerous !== true) {
      throw new Error(
        `DANGEROUS_ACTION_CONFIRMATION_REQUIRED: Explicit confirmDangerous=true is required for "${prepared.command.capabilityId}" (${prepared.assessment.riskLevel})`,
      );
    }

    // Ensure session has a scoped execution lease granted by the human approver for this target
    const lease = this.core.grantSessionLease({
      sessionId: prepared.command.sessionId,
      maxPermission: 'execute',
      grantedBy: approver,
      allowedTargets: [prepared.command.targetRef],
      ttlMs: 30_000,
    });

    if (row && row.status === 'pending') {
      this.#runtime.db.decideApproval({
        approvalId: row.id,
        decision: 'approved',
        approver,
        reason: input.reason,
      });
    }

    const executionResult = await this.core.executeCommand(prepared.prepareId, {
      actor: approver,
      approvalId: row ? row.id : input.approvalId,
      leaseId: lease.id,
      strongApprovalConfirmed: isHighRisk,
    });
    return { ok: true, approvalId: input.approvalId, decision: 'approved', executionResult };
  }

  async rollbackReceipt(input: {
    readonly receiptId: string;
    readonly actor: string;
    readonly reason: string;
  }): Promise<DawCommandResult> {
    const actor = input.actor.trim();
    if (!actor || AGENT_OR_SYSTEM_ACTOR_RE.test(actor) || !input.reason.trim()) {
      throw new Error('Human operator actor and non-empty reason are required for DAW rollback');
    }
    const receipt = this.core.getCommandReceipt(input.receiptId);
    if (!receipt) {
      throw new Error(`Execution receipt not found: "${input.receiptId}"`);
    }
    if (!receipt.rollbackSupported) {
      throw new Error(`DAW_ROLLBACK_UNSUPPORTED: Receipt "${input.receiptId}" does not support rollback`);
    }
    const lease = this.core.grantSessionLease({
      sessionId: receipt.sessionId,
      maxPermission: 'rollback',
      grantedBy: actor,
      ttlMs: 30_000,
    });
    const rollbackApproval = this.#runtime.db.queueApproval({
      itemType: 'critique_escalation',
      itemId: `rollback-${receipt.receiptId}-${Date.now()}`,
      proposer: 'daw-gateway-rollback-request',
      request: { receiptId: receipt.receiptId, reason: input.reason },
    });
    this.#runtime.db.decideApproval({
      approvalId: rollbackApproval.id,
      decision: 'approved',
      approver: actor,
      reason: input.reason,
    });
    return this.core.rollbackCommand(input.receiptId, {
      actor,
      approvalId: rollbackApproval.id,
      leaseId: lease.id,
    });
  }

  grantPrepareLease(input: {
    readonly sessionId: string;
    readonly grantedBy: string;
    readonly allowedTargets?: readonly string[] | undefined;
    readonly ttlMs?: number | undefined;
  }) {
    return this.core.grantSessionLease({
      sessionId: input.sessionId,
      maxPermission: 'prepare',
      grantedBy: input.grantedBy,
      allowedTargets: input.allowedTargets,
      ttlMs: input.ttlMs ?? 120_000,
    });
  }

  async runAgent(input: {
    readonly agentName: string;
    readonly goal: string;
    readonly mode?: DawAgentExecutionMode | undefined;
    readonly sessionId?: string | undefined;
    readonly hostKind?: DawInstance['hostKind'] | undefined;
    readonly hostEdition?: string | undefined;
    readonly pluginName?: string | undefined;
    readonly compareWithPlugin?: string | undefined;
  }): Promise<DawAgentRunResult> {
    const mode: DawAgentExecutionMode = input.mode ?? 'analyze';
    if (mode === 'execute_with_approval') {
      throw new Error('Direct execute_with_approval from Agent Console blocked; queue via Command Approval Queue');
    }
    return this.agentTeam.runTask({
      agentName: input.agentName,
      goal: input.goal,
      mode,
      sessionId: input.sessionId,
      hostKind: input.hostKind,
      hostEdition: input.hostEdition,
      pluginName: input.pluginName,
      compareWithPlugin: input.compareWithPlugin,
    });
  }

  async runWorkflow(input: {
    readonly workflowId: string;
    readonly sessionId?: string | undefined;
    readonly hostEdition?: string | undefined;
  }) {
    const spec = DAW_PRODUCTION_WORKFLOWS.find((w) => w.id === input.workflowId || w.name === input.workflowId);
    if (!spec) {
      throw new Error(`DAW workflow not found: "${input.workflowId}"`);
    }
    const sess =
      (input.sessionId ? this.core.sessions.getSession(input.sessionId) : this.core.sessions.listSessions()[0]) ?? null;
    if (!sess) {
      throw new Error(`No active DAW session connected to execute workflow "${spec.name}"`);
    }
    const parsed = (parseYaml(spec.yaml) ?? {}) as Record<string, unknown>;
    const rawSteps = Array.isArray(parsed.steps)
      ? parsed.steps.filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
      : [];
    const stepResults: Array<{
      readonly stepId: string;
      readonly agent: string;
      readonly tool: string;
      readonly ok: boolean;
      readonly findings: readonly string[];
      readonly error?: string | undefined;
    }> = [];
    for (const s of rawSteps) {
      const stepId = String(s.id ?? 'step');
      const agent = String(s.agent ?? 'daw-session-analyst');
      const tool = String(s.tool ?? '');
      const res = await this.agentTeam.runTask({
        agentName: agent,
        goal: `Execute workflow step "${stepId}" (${spec.name})${tool ? ` via ${tool}` : ''}`,
        mode: 'analyze',
        sessionId: sess.sessionId,
        hostEdition: input.hostEdition ?? 'Producer Edition',
      });
      stepResults.push({
        stepId,
        agent,
        tool,
        ok: res.ok,
        findings: res.findings,
        error: res.error?.message,
      });
    }
    return {
      workflowId: spec.id,
      workflowName: spec.name,
      sessionId: sess.sessionId,
      status: stepResults.every((r) => r.ok) ? 'success' : 'failed',
      steps: stepResults,
      executedAt: new Date().toISOString(),
    };
  }

  async runBenchmarkEvaluation(): Promise<DawEvaluationReport> {
    const report = await this.evaluationEngine.runEvaluation({
      dbFactory: (filePath) => openRuntimeDb(filePath),
    });
    this.#lastEvaluation = report;
    return report;
  }

  async buildOverview(): Promise<DawOverviewPayload> {
    if (this.#lastHostProbes.length === 0) {
      await this.probeHostsAndInstances();
    }
    const adapters = this.core.connections.listAdapters().map((a) => ({
      adapterId: a.manifest.adapterId,
      hostKind: a.manifest.hostKind,
      hostName: a.manifest.displayName,
      supportedVersions: [a.manifest.minSupportedHostVersion, a.manifest.maxTestedHostVersion],
      transportProtocol: a.manifest.transportKind,
      readOnlyDefault: true,
      capabilities: a.getCapabilities(),
    }));
    const sessions = this.core.sessions.listSessions();
    const activeSession =
      sessions.find((s) => s.connection.status !== 'closed' && s.connection.status !== 'disconnected') ?? sessions[0] ?? null;

    const allCaps = adapters.flatMap((a) => a.capabilities);
    const availableCaps = allCaps.filter((c) => c.supportLevel !== 'UNSUPPORTED');
    const unsupportedCaps = allCaps.filter((c) => c.supportLevel === 'UNSUPPORTED');

    const connStatus = activeSession?.connection.status;
    const connState: DawOverviewPayload['connectionSummary']['state'] =
      connStatus === 'connected_read_only' || connStatus === 'leased_mutable'
        ? 'connected'
        : connStatus === 'degraded_cached'
          ? 'degraded'
          : 'disconnected';

    const activeSnapshot = activeSession?.observed ?? activeSession?.cached ?? null;
    if (activeSnapshot && activeSession) {
      const adapter = this.core.connections.getAdapter(activeSession.adapterId);
      this.pluginBrain.ingestDawSnapshot(activeSnapshot, adapter?.manifest.hostKind ?? 'generic_daw', 'Producer Edition');
      if (!this.sessionIntelligence.getLastReport(activeSession.sessionId)) {
        await this.sessionIntelligence.analyzeSession(activeSession, {
          hostKind: adapter?.manifest.hostKind,
        }).catch(() => undefined);
      }
    }

    const sessionIntel = activeSession ? this.sessionIntelligence.getLastReport(activeSession.sessionId) : null;
    const activeHostKind = activeSession
      ? (this.core.connections.getAdapter(activeSession.adapterId)?.manifest.hostKind ?? 'generic_daw')
      : 'generic_daw';
    const chainGraphs = activeSnapshot
      ? this.pluginBrain.extractActualChains(activeSnapshot, { hostKind: activeHostKind, hostEdition: 'Producer Edition' })
      : [];
    const chainReports = chainGraphs.map((g) => this.pluginBrain.analyzeChain(g));

    const activeOperations: DawOverviewPayload['activeOperations'][number][] = [];
    for (const sess of sessions) {
      const lease = this.core.capabilities.getActiveLease(sess.sessionId);
      if (lease) {
        activeOperations.push({
          id: lease.id,
          kind: 'lease',
          sessionId: sess.sessionId,
          actor: lease.grantedBy,
          label: `Mutable Lease (${lease.maxPermission})`,
          tierOrRisk: lease.maxPermission,
          expiresOrCreatedAt: lease.expiresAt,
        });
      }
    }

    const pendingApprovals: DawPreparedProposalView[] = [];
    for (const [approvalId, prep] of this.#preparedByApprovalId.entries()) {
      const row = this.#runtime.db.getApproval(approvalId);
      const status = row?.status ?? 'pending';
      if (status === 'pending') {
        activeOperations.push({
          id: prep.prepareId,
          kind: 'prepared_command',
          sessionId: prep.command.sessionId,
          actor: prep.command.requestedBy,
          label: `Prepared: ${prep.command.capabilityId}`,
          tierOrRisk: prep.assessment.riskLevel,
          expiresOrCreatedAt: prep.command.createdAt,
        });
      }
      pendingApprovals.push({
        approvalId,
        prepareId: prep.prepareId,
        sessionId: prep.command.sessionId,
        capabilityId: prep.command.capabilityId,
        commandKind: prep.command.kind,
        commandClass: prep.assessment.commandClass,
        riskLevel: prep.assessment.riskLevel,
        approvalRequirement: prep.assessment.approvalRequirement,
        targetRef: prep.command.targetRef,
        proposer: row?.proposer ?? prep.command.requestedBy,
        status,
        rollbackSupported: prep.dryRun.rollbackSupported,
        wouldSucceed: prep.dryRun.wouldSucceed,
        projectVerified: prep.dryRun.projectIdentity.verified,
        fresh: prep.dryRun.stateFreshnessCheck.fresh,
        warnings: prep.dryRun.warnings,
        postconditionExpectations: prep.dryRun.postconditionExpectations,
        diff: prep.dryRun.diff,
        dryRun: prep.dryRun,
        createdAt: prep.command.createdAt,
        decidedAt: row?.decidedAt ?? null,
        approver: row?.approver ?? null,
        reason: row?.reason ?? null,
      });
    }

    const workflows = DAW_PRODUCTION_WORKFLOWS.map((w) => {
      const parsed = (parseYaml(w.yaml) ?? {}) as Record<string, unknown>;
      const inputObj = (parsed.input ?? {}) as Record<string, unknown>;
      const requiredInputs = Array.isArray(inputObj.required)
        ? inputObj.required.filter((x): x is string => typeof x === 'string')
        : [];
      const steps = Array.isArray(parsed.steps)
        ? parsed.steps
            .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
            .map((s) => ({
              id: String(s.id ?? 'step'),
              agent: String(s.agent ?? 'unknown'),
              tool: String(s.tool ?? ''),
              dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
            }))
        : [];
      return {
        id: w.id,
        name: w.name,
        title: w.title,
        domain: w.domain,
        description: w.description,
        requiredInputs,
        stepCount: steps.length,
        steps,
      };
    });

    const dawEvents = this.#runtime.db
      .listEvents({ limit: 80 })
      .filter((e) => e.eventType.startsWith('daw.'))
      .slice(0, 30);

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      dataSource: 'os3-gateway-live',
      isDemoFixture: false,
      connectionSummary: {
        state: connState,
        connectedSessions: sessions.filter((s) => s.connection.status !== 'closed' && s.connection.status !== 'disconnected').length,
        totalSessions: sessions.length,
        activeSessionId: activeSession?.sessionId ?? null,
        currentDaw: activeSession ? activeSession.dawId : null,
        currentVersion: activeSession ? activeSession.hostVersion : null,
        currentProject: activeSession ? activeSession.project.name : null,
        lastObservedAt: activeSession?.observed?.provenance.observedAt ?? activeSession?.updatedAt ?? null,
        freshness: activeSession?.stateFreshness ?? 'unknown',
        stale: activeSession?.stale ?? false,
        adaptersRegistered: adapters.length,
        reachableInstances: this.#lastDiscoveredInstances.filter((i) => i.reachable).length,
      },
      hostProbes: this.#lastHostProbes,
      adapters,
      discoveredInstances: this.#lastDiscoveredInstances,
      sessions,
      capabilities: {
        available: availableCaps,
        unsupported: unsupportedCaps,
        readOnlyCount: availableCaps.filter((c) => c.supportLevel === 'READ_ONLY').length,
        mutableCount: availableCaps.filter((c) => c.requiredTier === 'execute').length,
      },
      activeOperations,
      pendingApprovals: pendingApprovals.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      executionHistory: this.core.listCommandReceipts(),
      sessionIntelligence: sessionIntel,
      pluginBrain: {
        profiles: this.pluginBrain.listProfiles(),
        chainGraphs,
        chainReports,
      },
      audioBrain: {
        recentAnalyses: this.#audioReports,
      },
      agents: DAW_AGENT_CATALOG.map((a) => ({
        name: a.name,
        class: a.class,
        domain: a.domain,
        role: a.role,
        permissions: `${a.readPermissions} | WRITE: ${a.writePermissions}`,
        tools: a.tools,
        refuses: a.refuses,
        escalatesTo: a.escalation,
      })),
      workflows,
      evaluation: this.#lastEvaluation,
      events: dawEvents,
    };
  }
}

const DAW_CONTROLLERS = new WeakMap<Os3JarvisRuntime, DawGatewayController>();

export const setDawGatewayController = (
  runtime: Os3JarvisRuntime,
  controller: DawGatewayController,
): DawGatewayController => {
  DAW_CONTROLLERS.set(runtime, controller);
  return controller;
};

export const getOrCreateDawGateway = (runtime: Os3JarvisRuntime): DawGatewayController => {
  let controller = DAW_CONTROLLERS.get(runtime);
  if (!controller) {
    controller = new DawGatewayController(runtime);
    DAW_CONTROLLERS.set(runtime, controller);
  }
  return controller;
};
