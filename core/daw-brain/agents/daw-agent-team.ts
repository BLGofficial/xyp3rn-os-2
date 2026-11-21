import { Os3VaultAgentRegistry, parseOs3AgentFile, type Os3AgentDefinition } from '../../agent-registry/os3-agent-registry.ts';
import type { Os3ContextEngine } from '../../context-engine/os3-context-engine.ts';
import type { SqliteRuntimeDb } from '../../sqlite/client.ts';
import { Os3ToolExecutionError, type Os3ToolRegistry } from '../../tool-registry/os3-tool-registry.ts';
import type { VaultEngine } from '../../vault-engine/vault-engine.ts';
import type { AudioBrain } from '../audio-brain/audio-brain.ts';
import type { DawCore } from '../daw-core.ts';
import type { PluginBrain } from '../plugin-brain/plugin-brain.ts';
import type { DawSessionIntelligence } from '../session-intelligence/session-intelligence.ts';
import { DawBrainError, type DawCommand, type DawHostKind } from '../types.ts';
import { DAW_AGENT_CATALOG, renderDawAgentMarkdown, type DawAgentSpecInput } from './daw-agent-catalog.ts';
import { createDawBrainToolRegistry } from './daw-agent-tools.ts';

export type DawAgentExecutionMode = 'analyze' | 'recommend' | 'prepare' | 'execute_with_approval';

export type DawAgentRunRequest = {
  readonly agentName?: string | undefined;
  readonly goal: string;
  readonly mode?: DawAgentExecutionMode | undefined;
  readonly sessionId?: string | undefined;
  readonly audioFilePath?: string | undefined;
  readonly traceAnalysis?: unknown;
  readonly projectVaultPath?: string | undefined;
  readonly hostKind?: DawHostKind | undefined;
  readonly hostEdition?: string | undefined;
  readonly pluginName?: string | undefined;
  readonly compareWithPlugin?: string | undefined;
  readonly workflowKind?: string | undefined;
  readonly command?: DawCommand | undefined;
  readonly prepareId?: string | undefined;
  readonly approvalId?: string | undefined;
  readonly leaseId?: string | undefined;
};

export type DawAgentRunResult = {
  readonly ok: boolean;
  readonly selectedAgent: string;
  readonly agentClass: string;
  readonly domain: string;
  readonly mode: DawAgentExecutionMode;
  readonly toolsInvoked: readonly string[];
  readonly findings: readonly string[];
  readonly recommendations: readonly string[];
  readonly evidence: readonly string[];
  readonly limitations: readonly string[];
  readonly data: Readonly<Record<string, unknown>>;
  readonly escalatedTo?: string | undefined;
  readonly error?: { readonly code: string; readonly message: string } | undefined;
};

/**
 * Runtime coordinator for the 12-agent XYP3RN DAW Brain team.
 * Enforces default `analyze` mode, single-class tool authorization via `Os3ToolRegistry`,
 * Command Gateway confinement for all `prepare`/`execute_with_approval` paths,
 * explicit refusal + escalation, and evidence grounding across Session/Plugin/Audio/Context Brains.
 */
export class DawAgentTeam {
  readonly #toolRegistry: Os3ToolRegistry;
  readonly #agentRegistry = new Map<string, Os3AgentDefinition>();
  readonly #vaultAgentRegistry: Os3VaultAgentRegistry | null = null;

  constructor(deps: {
    readonly vault: VaultEngine;
    readonly db: SqliteRuntimeDb;
    readonly core?: DawCore | undefined;
    readonly sessionIntelligence?: DawSessionIntelligence | undefined;
    readonly pluginBrain?: PluginBrain | undefined;
    readonly audioBrain?: AudioBrain | undefined;
    readonly contextEngine?: Os3ContextEngine | undefined;
    readonly agentsDir?: string | undefined;
  }) {
    this.#toolRegistry = createDawBrainToolRegistry(deps);

    for (const spec of DAW_AGENT_CATALOG) {
      const md = renderDawAgentMarkdown(spec);
      const parsed = parseOs3AgentFile(`/virtual/daw-agents/${spec.name}.md`, md, {
        toolRegistry: this.#toolRegistry,
        requireV3Schema: true,
      });
      if (!parsed.ok) {
        throw new Error(`Invalid built-in DAW agent "${spec.name}": ${parsed.errors.join('; ')}`);
      }
      this.#agentRegistry.set(spec.name, parsed.agent);
    }

    if (deps.agentsDir) {
      this.#vaultAgentRegistry = new Os3VaultAgentRegistry({
        agentsDir: deps.agentsDir,
        toolRegistry: this.#toolRegistry,
      });
    }
  }

  get toolRegistry(): Os3ToolRegistry {
    return this.#toolRegistry;
  }

  get vaultRegistry(): Os3VaultAgentRegistry | null {
    return this.#vaultAgentRegistry;
  }

  listAgents(): readonly Os3AgentDefinition[] {
    return [...this.#agentRegistry.values()];
  }

  getAgent(name: string): Os3AgentDefinition | null {
    return this.#agentRegistry.get(name) ?? null;
  }

  selectAgentForTask(goal: string, preferredMode: DawAgentExecutionMode = 'analyze'): Os3AgentDefinition {
    if (preferredMode === 'execute_with_approval' || preferredMode === 'prepare') {
      return this.#agentRegistry.get('daw-operator')!;
    }
    const lower = goal.toLowerCase();
    let bestSpec = DAW_AGENT_CATALOG[1]!; // default daw-session-analyst
    let bestScore = -1;

    for (const spec of DAW_AGENT_CATALOG) {
      let score = 0;
      for (const kw of spec.keywords) {
        if (lower.includes(kw)) score += 10;
      }
      if (spec.name === 'daw-operator' && !/\b(execute|prepare|rollback|apply|patch)\b/i.test(lower)) {
        score = Math.min(score, 2);
      }
      if (score > bestScore) {
        bestScore = score;
        bestSpec = spec;
      }
    }
    return this.#agentRegistry.get(bestSpec.name)!;
  }

  async runTask(req: DawAgentRunRequest): Promise<DawAgentRunResult> {
    const mode: DawAgentExecutionMode = req.mode ?? 'analyze';
    const agent = req.agentName
      ? this.#agentRegistry.get(req.agentName)
      : this.selectAgentForTask(req.goal, mode);

    if (!agent) {
      return {
        ok: false,
        selectedAgent: req.agentName ?? 'unknown',
        agentClass: 'unknown',
        domain: 'TECH',
        mode,
        toolsInvoked: [],
        findings: [],
        recommendations: [],
        evidence: [],
        limitations: [],
        data: {},
        error: {
          code: 'AGENT_NOT_FOUND',
          message: `Unknown DAW agent: "${String(req.agentName)}"`,
        },
      };
    }

    // Strict execution-mode vs agent-class authorization
    if ((mode === 'prepare' || mode === 'execute_with_approval') && agent.class !== 'Execution') {
      return {
        ok: false,
        selectedAgent: agent.name,
        agentClass: agent.class,
        domain: agent.domain,
        mode,
        toolsInvoked: [],
        findings: [],
        recommendations: [
          `Escalate "${mode}" action to daw-operator (Execution) with valid Command Gateway approval and lease.`,
        ],
        evidence: [`Agent "${agent.name}" holds class="${agent.class}"; mutating modes forbidden by contract`],
        limitations: [`Refused "${mode}" outside Execution class`],
        data: {},
        escalatedTo: 'daw-operator',
        error: {
          code: 'DAW_PERMISSION_DENIED',
          message: `Agent "${agent.name}" (${agent.class}) refused mode "${mode}"; must escalate to daw-operator`,
        },
      };
    }

    const runId = `dawrun-${Date.now().toString(36)}`;
    const toolsInvoked: string[] = [];
    const findings: string[] = [];
    const recommendations: string[] = [];
    const evidence: string[] = [];
    const limitations: string[] = [];
    const data: Record<string, unknown> = {};

    const invoke = async (toolName: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
      toolsInvoked.push(toolName);
      if (!agent.tools.includes(toolName)) {
        throw new Os3ToolExecutionError({
          code: 'UNAUTHORIZED_TOOL',
          toolName,
          agentName: agent.name,
          runId,
          attempts: 0,
          message: `Agent "${agent.name}" does not declare tool "${toolName}"`,
        });
      }
      const res = await this.#toolRegistry.execute(
        { agentName: agent.name, agentClass: agent.class, runId, log: () => {} },
        toolName,
        input,
      );
      return (res.output ?? {}) as Record<string, unknown>;
    };

    try {
      // Handle Command Gateway modes exclusively for Execution class
      if (mode === 'prepare' && req.command) {
        const out = await invoke('daw_gateway_prepare', {
          command: req.command,
          leaseId: req.leaseId,
          queueApproval: true,
        });
        data.prepared = out.prepared;
        evidence.push(`Prepared command via DawCommandGateway (${req.command.capabilityId})`);
        return {
          ok: true,
          selectedAgent: agent.name,
          agentClass: agent.class,
          domain: agent.domain,
          mode,
          toolsInvoked,
          findings: ['Command staged cleanly via DawCommandGateway'],
          recommendations: ['Await human approval decision before execute_with_approval'],
          evidence,
          limitations,
          data,
        };
      }

      if (mode === 'execute_with_approval') {
        if (!req.prepareId || !req.approvalId || !req.leaseId) {
          return {
            ok: false,
            selectedAgent: agent.name,
            agentClass: agent.class,
            domain: agent.domain,
            mode,
            toolsInvoked,
            findings: [],
            recommendations: ['Provide valid prepareId, human approvalId, and active session leaseId'],
            evidence: ['Missing execute_with_approval credentials'],
            limitations: ['Gateway execute blocked without approvalId + leaseId'],
            data: {},
            escalatedTo: 'blago-operator',
            error: {
              code: 'DAW_APPROVAL_REQUIRED',
              message: 'execute_with_approval requires prepareId, human approvalId, and active leaseId',
            },
          };
        }
        const out = await invoke('daw_gateway_execute', {
          prepareId: req.prepareId,
          approvalId: req.approvalId,
          leaseId: req.leaseId,
        });
        data.executionResult = out.result;
        evidence.push(`Dispatched single-shot command ${req.prepareId} through DawCommandGateway`);
        return {
          ok: Boolean(out.ok),
          selectedAgent: agent.name,
          agentClass: agent.class,
          domain: agent.domain,
          mode,
          toolsInvoked,
          findings: [Boolean(out.ok) ? 'Approved DAW patch executed & verified' : 'Gateway rejected or failed command'],
          recommendations: [],
          evidence,
          limitations,
          data,
        };
      }

      // Default `analyze` & `recommend` paths: gather grounded subsystem intelligence
      if (agent.tools.includes('daw_host_compatibility_audit')) {
        const compatOut = await invoke('daw_host_compatibility_audit', { sessionId: req.sessionId });
        data.hostAudit = compatOut;
        const activeSess = compatOut.activeSession as Record<string, unknown> | null;
        if (activeSess) {
          evidence.push(
            `Host audit: adapter=${String(activeSess.adapterId)} ver=${String(activeSess.hostVersion)} compat=${String(activeSess.versionCompatibility)}`,
          );
          if (activeSess.versionCompatibility === 'degraded_read_only') {
            limitations.push('Host version degraded to read-only observation mode');
          }
        }
      }

      if (agent.tools.includes('daw_session_analyze')) {
        try {
          const sessOut = await invoke('daw_session_analyze', {
            sessionId: req.sessionId,
            edition: req.hostEdition,
            projectVaultPath: req.projectVaultPath,
            queryHint: req.goal,
          });
          const report = sessOut.report as {
            readonly evidence: readonly string[];
            readonly findings: readonly { readonly title: string; readonly detail: string }[];
            readonly limitations: readonly string[];
            readonly recommendedNextActions: readonly { readonly title: string; readonly rationale: string }[];
            readonly routingGraph: { readonly observabilityStatus: string; readonly orphanNodeIds: readonly string[]; readonly disconnectedSourceIds: readonly string[] };
          };
          data.sessionReport = report;
          evidence.push(...report.evidence);
          findings.push(...report.findings.map((f) => `${f.title}: ${f.detail}`));
          limitations.push(...report.limitations);
          if (mode === 'recommend') {
            recommendations.push(...report.recommendedNextActions.map((a) => `${a.title} (${a.rationale})`));
          }
        } catch (err) {
          limitations.push(`Session analysis skipped: ${(err as Error).message}`);
        }
      }

      if (agent.tools.includes('daw_plugin_brain_query')) {
        const op = req.compareWithPlugin
          ? 'compare'
          : req.pluginName
            ? 'check_compat'
            : req.workflowKind
              ? 'suggest_chain'
              : 'analyze_actual_chains';
        try {
          const plugOut = await invoke('daw_plugin_brain_query', {
            operation: op,
            sessionId: req.sessionId,
            pluginA: req.pluginName,
            pluginB: req.compareWithPlugin,
            workflowKind: req.workflowKind,
            hostKind: req.hostKind ?? 'fl_studio',
            hostEdition: req.hostEdition ?? 'Producer Edition',
          });
          data.pluginBrain = plugOut;
          evidence.push(`PluginBrain verified operation="${op}"`);
          if (op === 'suggest_chain' && mode === 'recommend') {
            const recipe = plugOut.recipe as { readonly label: string; readonly nodes: readonly { pluginName: string }[] } | undefined;
            if (recipe) {
              recommendations.push(
                `${recipe.label}: [${recipe.nodes.map((n) => n.pluginName).join(' -> ')}]`,
              );
            }
          }
        } catch (err) {
          limitations.push(`PluginBrain query "${op}" unavailable: ${(err as Error).message}`);
        }
      }

      if (agent.tools.includes('daw_audio_brain_analyze') && (req.audioFilePath || req.traceAnalysis)) {
        const stage = agent.name === 'daw-mixing-engineer' ? 'mix' : 'master';
        const audioOut = await invoke('daw_audio_brain_analyze', {
          filePath: req.audioFilePath,
          traceAnalysis: req.traceAnalysis,
          stage,
          sessionId: req.sessionId,
        });
        const rep = audioOut.report as {
          readonly diagnostics: { readonly overallVerdict: string; readonly alerts: readonly { summary: string }[] };
          readonly recommendations: readonly { title: string; suggestedDelta: string }[];
          readonly mir: { readonly status: string; readonly value?: { readonly keyEstimate?: { key: string; scale: string; probabilistic: boolean; confidence: number }; readonly tempoEstimate?: { bpm: number | null; probabilistic: boolean } } };
          readonly limitations: readonly string[];
        };
        data.audioReport = rep;
        evidence.push(`AudioBrain verdict=${rep.diagnostics.overallVerdict} (stage=${stage})`);
        findings.push(...rep.diagnostics.alerts.map((a) => a.summary));
        if (rep.mir.status === 'available' && rep.mir.value?.keyEstimate) {
          findings.push(
            `Probabilistic MIR: key=${rep.mir.value.keyEstimate.key} ${rep.mir.value.keyEstimate.scale} (conf=${rep.mir.value.keyEstimate.confidence}, bpm=${String(rep.mir.value.tempoEstimate?.bpm ?? 'unknown')})`,
          );
        }
        limitations.push(...rep.limitations);
        if (mode === 'recommend') {
          recommendations.push(...rep.recommendations.map((r) => `${r.title} (${r.suggestedDelta})`));
        }
      }

      if (agent.tools.includes('daw_context_retrieve')) {
        try {
          const ctxOut = await invoke('daw_context_retrieve', {
            query: req.goal,
            sessionId: req.sessionId,
            projectVaultPath: req.projectVaultPath,
            activePlugins: req.pluginName ? [req.pluginName] : undefined,
          });
          const pkg = ctxOut.contextPackage as {
            readonly epistemicSeparationNotice: string;
            readonly projectMetadata: { readonly projectNotes: readonly { title: string }[] };
            readonly userApprovedPreferences: readonly { title: string }[];
          };
          data.contextPackage = pkg;
          evidence.push(
            `ContextEngine linked ${pkg.projectMetadata.projectNotes.length} project/song note(s), ${pkg.userApprovedPreferences.length} approved preference(s)`,
          );
        } catch (err) {
          limitations.push(`ContextEngine retrieval unavailable: ${(err as Error).message}`);
        }
      }

      void DawBrainError;
      return {
        ok: true,
        selectedAgent: agent.name,
        agentClass: agent.class,
        domain: agent.domain,
        mode,
        toolsInvoked,
        findings,
        recommendations: mode === 'analyze' ? [] : recommendations,
        evidence,
        limitations,
        data,
      };
    } catch (err) {
      const msg = (err as Error).message;
      const code = err instanceof Os3ToolExecutionError ? err.code : 'DAW_AGENT_ERROR';
      return {
        ok: false,
        selectedAgent: agent.name,
        agentClass: agent.class,
        domain: agent.domain,
        mode,
        toolsInvoked,
        findings,
        recommendations: [],
        evidence,
        limitations,
        data,
        error: { code, message: msg },
      };
    }
  }
}
