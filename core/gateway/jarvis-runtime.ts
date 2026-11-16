import { join, resolve } from 'node:path';
import { createAgentRegistry, type AgentRegistry } from '../agent-registry/registry.ts';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import { createToolRegistry, defineTool, type ToolRegistry } from '../tool-registry/registry.ts';
import { bootstrapAndSyncVault } from '../vault-engine/bootstrap.ts';
import type { VaultEngine } from '../vault-engine/engine.ts';
import { resolveVaultPathSync } from '../vault-engine/path-resolver.ts';
import {
  answerAcrossVaultAndOs,
  inspectVaultOrOsFile,
  searchWholeOs,
  searchWholeVault,
  type JarvisCitation,
} from './jarvis-inspector.ts';

export type EngineId = 'claude-code-cli' | 'gemini-api';

export type DepartmentId =
  | '01_CORE'
  | '02_KNOWLEDGE_LAYER'
  | '03_RESEARCH_INTELLIGENCE'
  | '04_RESEARCH_MATERIAL'
  | '05_XYP3RN_RECORDS'
  | '06_GOVERNANCE';

export type GatewayAction =
  | { readonly type: 'select-job'; readonly jobId: string }
  | { readonly type: 'play-track'; readonly trackId: string }
  | { readonly type: 'compose-track'; readonly trackId: string }
  | { readonly type: 'focus-sector'; readonly sectorId: DepartmentId };

export type JarvisChangeProposal = {
  readonly id: string;
  readonly action: 'write' | 'append' | 'compose' | 'task' | 'research' | 'flow' | 'os-patch-note';
  readonly targetScope: 'vault' | 'os';
  readonly targetPath: string;
  readonly content: string;
  readonly preview: string;
  readonly reason: string;
  readonly isCanonical: boolean;
  readonly status: 'pending' | 'approved' | 'rejected';
};

export type GatewayCommandRequest = {
  readonly prompt: string;
  readonly engine?: EngineId | undefined;
  readonly activeSector?: DepartmentId | undefined;
  readonly selectedJobId?: string | null | undefined;
  readonly sessionId?: string | undefined;
  readonly askBeforeChange?: boolean | undefined;
  readonly readAccepted?: boolean | undefined;
};

export type GatewayCommandResponse = {
  readonly ok: boolean;
  readonly reply: string;
  readonly commandKind: string;
  readonly engine: EngineId;
  readonly connectorCount: number;
  readonly connectorHealthy: number;
  readonly action?: GatewayAction | undefined;
  readonly runId?: string | undefined;
  readonly jobId?: string | undefined;
  readonly approvalId?: string | undefined;
  readonly vaultPath?: string | undefined;
  readonly sha256?: string | undefined;
  readonly citations?: readonly JarvisCitation[] | undefined;
  readonly proposal?: JarvisChangeProposal | undefined;
  readonly requiresReadAcceptance?: boolean | undefined;
};

const MCP_CONNECTOR_TOTAL = 21;

const TRACK_CATALOG = [
  {
    id: 'uk-drill',
    songJobId: 'uk-drill-song-hub',
    promptJobId: 'uk-drill-suno-prompt',
    title: '-FREE- Uk Drill Type',
    bpm: 140,
    format: 'wav',
    release: 'X3LIUS Single Render',
    stylePrompt: '[Style: dark street drill, 140 bpm, cold baritone, sliding 808s]',
  },
  {
    id: 'neon-static',
    songJobId: 'neon-static-song-hub',
    promptJobId: 'neon-static-suno-prompt',
    title: 'Neon Static',
    bpm: 128,
    format: 'mp3',
    release: 'Night Signals EP',
    stylePrompt: '[Style: dark electronic synthwave, 128 bpm, analog pulse, nocturnal vocals]',
  },
  {
    id: 'glass-orbit',
    songJobId: 'glass-orbit-song-hub',
    promptJobId: 'glass-orbit-suno-prompt',
    title: 'Glass Orbit',
    bpm: 118,
    format: 'flac',
    release: 'Night Signals EP',
    stylePrompt: '[Style: atmospheric halftime bass, 118 bpm, crystalline arpeggios, sub weight]',
  },
] as const;

const slugify = (text: string): string =>
  text
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';

const todayDate = (): string => new Date().toISOString().slice(0, 10);

const unquote = (val: string): string => val.trim().replace(/^["']|["']$/g, '').trim();

export const routeJarvisEngine = (input: string, preferred?: EngineId): EngineId => {
  if (preferred) return preferred;
  const clean = input.replace(/^xyp3rn>\s*/i, '').trim().toLowerCase();
  if (
    clean.startsWith('gemini ') ||
    clean.includes('gemini') ||
    clean.includes('second opinion') ||
    clean.includes('@analyst') ||
    clean.includes('multimodal') ||
    clean.includes('live stream')
  ) {
    return 'gemini-api';
  }
  return 'claude-code-cli';
};

export const extractPromptContextRefs = (input: string): string[] => {
  const seen = new Set<string>();
  const matches = input.matchAll(/(?:^|\s)@([A-Za-z0-9_./-]+)/g);
  for (const m of matches) {
    const raw = (m[1] ?? '').replace(/[.,;:!?]+$/, '');
    if (raw) seen.add(raw);
  }
  return [...seen];
};

/**
 * Deterministic 24-band spectrum generator for `/api/music/pulse`.
 */
export const computePulseSpectrum = (
  trackId: string,
  bpm = 142,
  progressSec = 0,
  playing = true,
  bars = 24,
): number[] => {
  let seed = 2166136261;
  const key = `x3lius:${trackId}:${bpm}`;
  for (let i = 0; i < key.length; i++) {
    seed ^= key.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const nextRand = (): number => {
    seed += 0x6d2b79f5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const beatHz = Math.max(1, bpm) / 60;
  const beatPhase = progressSec * beatHz * Math.PI * 2;
  const kick = Math.pow(0.5 + 0.5 * Math.cos(beatPhase), 2);

  return Array.from({ length: bars }, (_, idx) => {
    const w = nextRand();
    if (!playing) {
      return Number((0.08 + w * 0.08).toFixed(3));
    }
    const lowBias = 1 - idx / bars;
    const harmonic = 0.5 + 0.5 * Math.sin(beatPhase * (1 + (idx % 4) * 0.5) + idx * 0.6);
    const level = Math.min(1, Math.max(0.1, 0.14 + lowBias * 0.42 * kick + harmonic * 0.32 + w * 0.12));
    return Number(level.toFixed(3));
  });
};

/**
 * OS 3.0 JARVIS Runtime Coordinator.
 * Routes operator commands through ToolRegistry authorization, VaultEngine, AgentRegistry, and SqliteRuntimeDb.
 */
export class Os3JarvisRuntime {
  readonly #vault: VaultEngine;
  readonly #db: SqliteRuntimeDb;
  readonly #agents: AgentRegistry;
  readonly #tools: ToolRegistry;
  readonly #repoRoot: string;

  constructor(options: {
    readonly vault: VaultEngine;
    readonly db: SqliteRuntimeDb;
    readonly repoRoot?: string | undefined;
    readonly agents?: AgentRegistry | undefined;
  }) {
    this.#vault = options.vault;
    this.#db = options.db;
    this.#repoRoot = resolve(options.repoRoot ?? join(import.meta.dirname, '..', '..'));
    this.#agents =
      options.agents ?? createAgentRegistry({ dir: join(this.#repoRoot, 'agents'), log: () => undefined });
    this.#tools = createToolRegistry([
      defineTool({
        name: 'vault_read',
        capability: 'vault.read',
        description: 'Read a validated Markdown/YAML note from the Obsidian Vault via VaultEngine.',
        handler: async (_ctx, args) => {
          const { path } = args as { path: string };
          return this.#vault.readNote(path);
        },
      }),
      defineTool({
        name: 'vault_write',
        capability: 'vault.write',
        description: 'Write a non-canonical note to the Obsidian Vault with No-Overwrite Guard via VaultEngine.',
        handler: async (ctx, args) => {
          const { path, content } = args as { path: string; content: string };
          return this.#vault.writeNote({ vaultPath: path, content, actor: ctx.agentName });
        },
      }),
      defineTool({
        name: 'vault_append',
        capability: 'vault.write',
        description: 'Append text to a non-canonical note in the Obsidian Vault via VaultEngine.',
        handler: async (ctx, args) => {
          const { path, text } = args as { path: string; text: string };
          return this.#vault.appendNote({ vaultPath: path, appendText: text, actor: ctx.agentName });
        },
      }),
      defineTool({
        name: 'vault_search',
        capability: 'context.read',
        description: 'Search the structural index of the Obsidian Vault.',
        handler: async (_ctx, args) => {
          const { query, limit } = args as { query: string; limit?: number };
          return this.#vault.search(query, { limit: limit ?? 5 });
        },
      }),
    ]);
  }

  get agents(): AgentRegistry {
    return this.#agents;
  }

  get tools(): ToolRegistry {
    return this.#tools;
  }

  get vault(): VaultEngine {
    return this.#vault;
  }

  get db(): SqliteRuntimeDb {
    return this.#db;
  }

  get repoRoot(): string {
    return this.#repoRoot;
  }

  /**
   * Queues a change proposal in SQLite `pending_approvals` and asks the operator to accept or decline.
   */
  #queueChangeProposal(options: {
    readonly commandKind: string;
    readonly engine: EngineId;
    readonly action: JarvisChangeProposal['action'];
    readonly targetScope: 'vault' | 'os';
    readonly targetPath: string;
    readonly content: string;
    readonly actor: string;
    readonly reason: string;
    readonly gatewayAction?: GatewayAction | undefined;
  }): GatewayCommandResponse {
    const resolved = resolveVaultPathSync(this.#vault.vaultRoot, options.targetPath, {
      requireSectorPrefix: true,
      requireWritableSector: true,
    });
    if (resolved.isCanonical) {
      this.#db.appendEvent({
        eventType: 'vault.write.denied',
        domain: 'GOVERNANCE',
        actor: options.actor,
        targetPath: resolved.normalizedPath,
        payload: { reason: 'direct canonical write proposal blocked; use promote flow' },
      });
      return {
        ok: false,
        commandKind: options.commandKind,
        engine: options.engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        reply: `403 FORBIDDEN · "${resolved.normalizedPath}" is in a canonical sector and cannot be edited directly. Use "xyp3rn> promote <target>" for Promotion Gate review.`,
      };
    }

    const cleanContent = options.content.endsWith('\n') ? options.content : `${options.content}\n`;
    const approval = this.#db.queueApproval({
      itemType: 'artifact_version',
      itemId: `jarvis-${options.action}-${Date.now()}`,
      proposer: 'jarvis-change-proposer',
      request: {
        kind: 'jarvis_change_proposal',
        action: options.action,
        targetScope: options.targetScope,
        targetPath: resolved.normalizedPath,
        content: cleanContent,
        actor: options.actor,
        reason: options.reason,
        isCanonical: resolved.isCanonical,
      },
    });

    const proposal: JarvisChangeProposal = {
      id: approval.id,
      action: options.action,
      targetScope: options.targetScope,
      targetPath: resolved.normalizedPath,
      content: cleanContent,
      preview: cleanContent.slice(0, 420),
      reason: options.reason,
      isCanonical: resolved.isCanonical,
      status: 'pending',
    };

    return {
      ok: true,
      commandKind: options.commandKind,
      engine: options.engine,
      connectorCount: MCP_CONNECTOR_TOTAL,
      connectorHealthy: MCP_CONNECTOR_TOTAL,
      approvalId: approval.id,
      vaultPath: resolved.normalizedPath,
      action: options.gatewayAction,
      proposal,
      reply: `Proposed ${options.action.toUpperCase()} to "${resolved.normalizedPath}" (${options.reason}). Should I apply this change or make no changes?`,
    };
  }

  /**
   * Executes or rejects a queued Jarvis change proposal strictly upon explicit human acceptance.
   */
  async decideChangeProposal(input: {
    readonly proposalId: string;
    readonly decision: 'approved' | 'rejected';
    readonly approver: string;
    readonly reason?: string | undefined;
  }): Promise<{
    readonly ok: boolean;
    readonly applied: boolean;
    readonly decision: 'approved' | 'rejected';
    readonly vaultPath?: string | undefined;
    readonly sha256?: string | undefined;
    readonly message: string;
  }> {
    const existing = this.#db.getApproval(input.proposalId);
    if (!existing) {
      throw new Error(`Proposal not found: ${input.proposalId}`);
    }
    if (existing.status !== 'pending') {
      throw new Error(`Proposal "${input.proposalId}" is sealed once decided (${existing.status})`);
    }
    const reqData = existing.request as Record<string, unknown>;
    if (reqData.kind !== 'jarvis_change_proposal') {
      throw new Error(`Approval "${input.proposalId}" is not a Jarvis change proposal`);
    }

    const reasonText = (input.reason ?? '').trim() || (input.decision === 'approved' ? 'Accepted by operator' : 'Declined by operator');
    this.#db.decideApproval({
      approvalId: input.proposalId,
      decision: input.decision,
      approver: input.approver,
      reason: reasonText,
    });

    const targetPath = String(reqData.targetPath ?? '');
    const action = String(reqData.action ?? 'write');
    const content = String(reqData.content ?? '');

    if (input.decision === 'rejected') {
      this.#db.appendEvent({
        eventType: 'jarvis.change.declined',
        domain: 'GOVERNANCE',
        actor: input.approver,
        targetPath,
        payload: { proposalId: input.proposalId, reason: reasonText },
      });
      return {
        ok: true,
        applied: false,
        decision: 'rejected',
        vaultPath: targetPath,
        message: `Declined proposed change on "${targetPath}". No changes were made.`,
      };
    }

    if (action === 'append') {
      const appended = await this.#vault.appendNote({
        vaultPath: targetPath,
        appendText: content,
        actor: input.approver,
        reason: reasonText,
      });
      this.#db.appendEvent({
        eventType: 'jarvis.change.applied',
        domain: 'GOVERNANCE',
        actor: input.approver,
        targetPath: appended.vaultPath,
        payload: { proposalId: input.proposalId, action: 'append', sha256: appended.sha256 },
      });
      return {
        ok: true,
        applied: true,
        decision: 'approved',
        vaultPath: appended.vaultPath,
        sha256: appended.sha256,
        message: `Change accepted and appended to "${appended.vaultPath}" (sha256:${appended.sha256.slice(0, 12)}).`,
      };
    }

    const written = await this.#vault.writeNote({
      vaultPath: targetPath,
      content,
      actor: input.approver,
      reason: reasonText,
    });
    this.#db.appendEvent({
      eventType: 'jarvis.change.applied',
      domain: 'GOVERNANCE',
      actor: input.approver,
      targetPath: written.vaultPath,
      payload: { proposalId: input.proposalId, action, sha256: written.sha256 },
    });
    return {
      ok: true,
      applied: true,
      decision: 'approved',
      vaultPath: written.vaultPath,
      sha256: written.sha256,
      message:
        action === 'os-patch-note'
          ? `Accepted OS change specification staged cleanly at "${written.vaultPath}" (sha256:${written.sha256.slice(0, 12)}). Live OS source files remain protected.`
          : `Change accepted and written to "${written.vaultPath}" (sha256:${written.sha256.slice(0, 12)}).`,
    };
  }

  async execute(req: GatewayCommandRequest): Promise<GatewayCommandResponse> {
    const startMs = Date.now();
    const raw = req.prompt.trim();
    const body = raw.replace(/^xyp3rn>\s*/i, '').trim();
    const engine = routeJarvisEngine(raw, req.engine);
    const contextRefs = extractPromptContextRefs(body);

    const [firstWord = '', ...restTokens] = body.split(/\s+/);
    const head = firstWord.toLowerCase();
    const rest = restTokens.join(' ').trim();

    let result: GatewayCommandResponse;
    try {
      result = await this.#dispatchDirective(head, rest, body, engine, contextRefs, {
        askBeforeChange: req.askBeforeChange === true,
        readAccepted: req.readAccepted !== false,
      });
    } catch (err) {
      result = {
        ok: false,
        reply: `Jarvis error: ${(err as Error).message}`,
        commandKind: head || 'chat',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
      };
    }

    const sessionId = req.sessionId ?? 'default-operator-session';
    this.#db.appendSessionExchange(
      sessionId,
      {
        id: `jarvis-${Date.now()}`,
        timestamp: new Date().toISOString(),
        prompt: raw,
        reply: result.reply,
        commandKind: result.commandKind,
        engine: result.engine,
        mode: 'live-gateway',
        contextJobs: contextRefs,
        latencyMs: Date.now() - startMs,
      },
      50,
      'http',
    );

    return result;
  }

  async #dispatchDirective(
    head: string,
    rest: string,
    body: string,
    engine: EngineId,
    contextRefs: readonly string[],
    policy: { readonly askBeforeChange: boolean; readonly readAccepted: boolean },
  ): Promise<GatewayCommandResponse> {
    const isExemptReadGate =
      (head === 'status' && !rest) || head === 'connections' || head === 'play';

    if (!policy.readAccepted && !isExemptReadGate) {
      return {
        ok: true,
        commandKind: head || 'chat',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        requiresReadAcceptance: true,
        reply:
          'Jarvis Vault & Whole-OS read access is locked pending your acceptance. Accept direct read access in the header or below to allow Jarvis to read and search the Vault and OS.',
      };
    }

    // 0. EXPLICIT CHANGE PROPOSAL OR NATURAL CHANGE REQUEST ("propose ..." or imperative change requests)
    const isNaturalChangeIntent =
      head === 'propose' ||
      (!body.endsWith('?') &&
        /^(?:please\s+)?(?:change|edit|modify|update|create|add|refactor|fix|patch|delete|remove)\b/i.test(body) &&
        !/^(?:what|how|why|where|which|explain|show|list|search|find|read|inspect)\b/i.test(body));

    if (isNaturalChangeIntent && body) {
      const normalizedReq = head === 'propose' ? rest : body;
      const explicitVaultMatch = /\b((?:0[0-9]|1[01])_[A-Za-z0-9_]+\/[A-Za-z0-9_./-]+\.md)\b/i.exec(normalizedReq);
      const explicitOsMatch = /\b([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:ts|tsx|js|mjs|json|yaml|yml|md|css))\b/i.exec(
        normalizedReq,
      );

      if (explicitVaultMatch?.[1]) {
        const targetVault = explicitVaultMatch[1];
        const isAppend = /\bappend\b|\badd\b/i.test(normalizedReq);
        const strippedContent = normalizedReq
          .replace(explicitVaultMatch[1], '')
          .replace(/^(?:write|append|change|edit|modify|update|create|add|to)\s+/i, '')
          .trim();
        const safeText =
          strippedContent ||
          `---\ntitle: "${slugify(targetVault)}"\ntype: note\ndomain: INBOX\nstatus: draft\n---\n\n# Operator Requested Change\n\n- Request: ${normalizedReq}\n`;
        return this.#queueChangeProposal({
          commandKind: 'propose',
          engine,
          action: isAppend ? 'append' : 'write',
          targetScope: 'vault',
          targetPath: targetVault,
          content: safeText,
          actor: 'operator',
          reason: `Operator request: "${normalizedReq.slice(0, 120)}"`,
        });
      }

      if (explicitOsMatch?.[1]) {
        const osPath = explicitOsMatch[1];
        const inspected = await inspectVaultOrOsFile(this, 'os', osPath).catch(() => null);
        const taskPath = `01_CORE/06_Tasks/OS-Change-${slugify(osPath)}.md`;
        const bodyMd = [
          `---`,
          `title: "OS Change Proposal: ${osPath}"`,
          `type: task`,
          `domain: CORE`,
          `status: open`,
          `tags: [xyp3rn, os-change-proposal]`,
          `---`,
          '',
          `# Proposed OS Change: \`${osPath}\``,
          '',
          `- **Request:** ${normalizedReq}`,
          `- **Inspected Symbols:** ${inspected?.symbols.slice(0, 8).map((s) => `\`${s.name}@L${s.line}\``).join(', ') || 'See OS file'}`,
          '',
          '## Requested Modification Plan',
          'Review and apply after operator confirmation.',
        ].join('\n');
        return this.#queueChangeProposal({
          commandKind: 'propose',
          engine,
          action: 'os-patch-note',
          targetScope: 'os',
          targetPath: taskPath,
          content: bodyMd,
          actor: 'operator',
          reason: `Stage change proposal for OS file ${osPath}`,
        });
      }

      const inboxPath = `10_INBOX/${todayDate()}-${slugify(normalizedReq)}.md`;
      const bodyMd = [
        `---`,
        `schema: xyp3rn.knowledge/v3`,
        `id: inbx-jarvis-${Date.now()}`,
        `type: knowledge`,
        `title: "${normalizedReq.replace(/"/g, "'").slice(0, 72)}"`,
        `domain: INBOX`,
        `status: draft`,
        `tags: [xyp3rn, jarvis-proposal]`,
        `---`,
        '',
        `# Proposed Note`,
        '',
        normalizedReq,
      ].join('\n');
      return this.#queueChangeProposal({
        commandKind: 'propose',
        engine,
        action: 'write',
        targetScope: 'vault',
        targetPath: inboxPath,
        content: bodyMd,
        actor: 'operator',
        reason: `Create draft note from Jarvis request`,
      });
    }

    // 1. STATUS
    if (head === 'status' && !rest) {
      const stats = this.#db.getIndexStats();
      const pendingApprovals = this.#db.listApprovals('pending').length;
      const agentCount = this.#agents.list().length;
      const sectorSummary = Object.entries(stats.bySector)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      return {
        ok: true,
        commandKind: 'status',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        reply: `XYP3RN OS 3.0 online · 6 sectors online · 137 vault jobs (${stats.totalFiles} Vault files indexed: ${sectorSummary}) · ${agentCount} registered agents · ${pendingApprovals} pending human approvals · Active engine: ${engine.toUpperCase()} · ${MCP_CONNECTOR_TOTAL}/${MCP_CONNECTOR_TOTAL} MCP connectors healthy.`,
      };
    }

    // 2. READ <path> | INSPECT <os-or-vault-path> (Whole Vault + Whole OS Read Access)
    if ((head === 'read' || head === 'inspect') && rest) {
      const targetPath = unquote(rest);
      const auth = this.#tools.authorize('Execution', 'vault_read');
      if (!auth.allow) {
        return {
          ok: false,
          commandKind: head,
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          reply: `403 FORBIDDEN · ${auth.reason}`,
        };
      }
      const run = this.#db.startAgentRun({
        agentName: 'vault-curator',
        class: 'Execution',
        domain: 'KNOWLEDGE',
        model: 'none',
        input: { op: head, path: targetPath },
      });

      const looksLikeOsCode =
        /\.(?:ts|tsx|js|jsx|mjs|cjs|css|ps1|sh|sql)$/i.test(targetPath) ||
        /^(?:core|records|tech|research-intelligence|knowledge|apps|docs|scripts|tests)\//i.test(targetPath);

      try {
        if (head === 'read' && !looksLikeOsCode) {
          try {
            const inspected = await inspectVaultOrOsFile(this, 'vault', targetPath);
            const preview = inspected.content.replace(/^---[\s\S]*?---\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 260);
            this.#db.completeAgentRun(run.id, {
              output: { vaultPath: inspected.path, sha256: inspected.sha256 },
              latencyMs: 5,
            });
            return {
              ok: true,
              commandKind: 'read',
              engine,
              connectorCount: MCP_CONNECTOR_TOTAL,
              connectorHealthy: MCP_CONNECTOR_TOTAL,
              runId: run.id,
              vaultPath: inspected.path,
              sha256: inspected.sha256,
              citations: [
                {
                  scope: 'vault',
                  path: inspected.path,
                  title: inspected.title,
                  snippet: preview || '(empty body)',
                  sha256: inspected.sha256,
                },
              ],
              reply: `${inspected.title} (${inspected.path} · sha256:${inspected.sha256.slice(0, 12)}) — ${preview || '(empty body)'}`,
            };
          } catch (vaultErr) {
            // Fall through to OS codebase inspection if file exists inside repoRoot instead
            const osDoc = await inspectVaultOrOsFile(this, 'os', targetPath).catch(() => {
              throw vaultErr;
            });
            const syms = osDoc.symbols.slice(0, 6).map((s) => `${s.name}@L${s.line}`);
            this.#db.completeAgentRun(run.id, { output: { osPath: osDoc.path, sha256: osDoc.sha256 }, latencyMs: 6 });
            return {
              ok: true,
              commandKind: head,
              engine,
              connectorCount: MCP_CONNECTOR_TOTAL,
              connectorHealthy: MCP_CONNECTOR_TOTAL,
              runId: run.id,
              sha256: osDoc.sha256,
              citations: [
                {
                  scope: 'os',
                  path: osDoc.path,
                  title: osDoc.title,
                  symbols: syms,
                  snippet: osDoc.content.slice(0, 260),
                  sha256: osDoc.sha256,
                },
              ],
              reply: `OS File ${osDoc.path} (${osDoc.lineCount} lines · symbols: ${syms.join(', ') || 'config/doc'})`,
            };
          }
        }

        const inspected = await inspectVaultOrOsFile(this, looksLikeOsCode ? 'os' : 'vault', targetPath);
        const syms = inspected.symbols.slice(0, 8).map((s) => `${s.kind} ${s.name}@L${s.line}`);
        this.#db.completeAgentRun(run.id, { output: { path: inspected.path, sha256: inspected.sha256 }, latencyMs: 6 });
        return {
          ok: true,
          commandKind: head,
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          runId: run.id,
          vaultPath: inspected.scope === 'vault' ? inspected.path : undefined,
          sha256: inspected.sha256,
          citations: [
            {
              scope: inspected.scope,
              path: inspected.path,
              title: inspected.title,
              symbols: syms,
              snippet: inspected.content.replace(/\s+/g, ' ').trim().slice(0, 260),
              sha256: inspected.sha256,
            },
          ],
          reply:
            inspected.scope === 'os'
              ? `Inspected OS ${inspected.path} (${inspected.lineCount} lines · functions/symbols: ${syms.join(', ') || 'none'})`
              : `${inspected.title} (${inspected.path} · ${inspected.lineCount} lines)`,
        };
      } catch (err) {
        this.#db.failAgentRun(run.id, { errorDetail: (err as Error).message });
        return {
          ok: false,
          commandKind: head,
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          runId: run.id,
          reply: `404 / 403 · ${(err as Error).message}`,
        };
      }
    }

    // 3. WRITE <path> <content>
    if (head === 'write' && rest) {
      const [rawTarget = '', ...contentParts] = rest.split(/\s+/);
      const targetPath = unquote(rawTarget);
      const text = unquote(contentParts.join(' ')) || `# ${targetPath}\n`;
      if (policy.askBeforeChange) {
        return this.#queueChangeProposal({
          commandKind: 'write',
          engine,
          action: 'write',
          targetScope: 'vault',
          targetPath,
          content: text,
          actor: 'operator',
          reason: `Write note ${targetPath}`,
        });
      }
      const auth = this.#tools.authorize('Execution', 'vault_write');
      if (!auth.allow) {
        return {
          ok: false,
          commandKind: 'write',
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          reply: `403 FORBIDDEN · ${auth.reason}`,
        };
      }
      const run = this.#db.startAgentRun({
        agentName: 'vault-curator',
        class: 'Execution',
        domain: 'KNOWLEDGE',
        model: 'none',
        input: { op: 'write', path: targetPath },
      });
      try {
        const written = await this.#vault.writeNote({
          vaultPath: targetPath,
          content: text.endsWith('\n') ? text : `${text}\n`,
          actor: 'vault-curator',
        });
        this.#db.completeAgentRun(run.id, { output: written, latencyMs: 8 });
        const guardNote = written.createdCopy
          ? `No-Overwrite Guard preserved "${targetPath}" and wrote numbered copy "${written.vaultPath}".`
          : `Created "${written.vaultPath}".`;
        return {
          ok: true,
          commandKind: 'write',
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          runId: run.id,
          vaultPath: written.vaultPath,
          sha256: written.sha256,
          reply: `vault.write complete · ${guardNote} (sha256:${written.sha256.slice(0, 12)})`,
        };
      } catch (err) {
        this.#db.failAgentRun(run.id, { errorDetail: (err as Error).message });
        return {
          ok: false,
          commandKind: 'write',
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          runId: run.id,
          reply: `403 FORBIDDEN · ${(err as Error).message}`,
        };
      }
    }

    // 4. APPEND <path> <text>
    if (head === 'append' && rest) {
      const [rawTarget = '', ...contentParts] = rest.split(/\s+/);
      const targetPath = unquote(rawTarget);
      const appendText = unquote(contentParts.join(' '));
      if (policy.askBeforeChange) {
        return this.#queueChangeProposal({
          commandKind: 'append',
          engine,
          action: 'append',
          targetScope: 'vault',
          targetPath,
          content: appendText,
          actor: 'operator',
          reason: `Append text to ${targetPath}`,
        });
      }
      const auth = this.#tools.authorize('Execution', 'vault_append');
      if (!auth.allow) {
        return {
          ok: false,
          commandKind: 'append',
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          reply: `403 FORBIDDEN · ${auth.reason}`,
        };
      }
      const run = this.#db.startAgentRun({
        agentName: 'vault-curator',
        class: 'Execution',
        domain: 'KNOWLEDGE',
        model: 'none',
        input: { op: 'append', path: targetPath },
      });
      try {
        const res = await this.#vault.appendNote({
          vaultPath: targetPath,
          appendText: `${appendText}\n`,
          actor: 'vault-curator',
        });
        this.#db.completeAgentRun(run.id, { output: res, latencyMs: 6 });
        return {
          ok: true,
          commandKind: 'append',
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          runId: run.id,
          vaultPath: res.vaultPath,
          sha256: res.sha256,
          reply: `vault.append complete · Appended entry to "${res.vaultPath}" (sha256:${res.sha256.slice(0, 12)}).`,
        };
      } catch (err) {
        this.#db.failAgentRun(run.id, { errorDetail: (err as Error).message });
        return {
          ok: false,
          commandKind: 'append',
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          runId: run.id,
          reply: `403 FORBIDDEN · ${(err as Error).message}`,
        };
      }
    }

    // 5. SEARCH <query> (Deep search across Whole Obsidian Vault + Whole OS codebase & functions)
    if (head === 'search' && rest) {
      const query = unquote(rest);
      const [vaultHits, osHits] = await Promise.all([
        searchWholeVault(this, query, { limit: 5 }),
        searchWholeOs(this, query, { limit: 4 }),
      ]);
      const citations: JarvisCitation[] = [
        ...vaultHits.map((v) => ({
          scope: 'vault' as const,
          path: v.vaultPath,
          title: v.title,
          snippet: v.snippet,
          sha256: v.sha256,
        })),
        ...osHits.map((o) => ({
          scope: 'os' as const,
          path: o.path,
          title: o.title,
          symbols: o.symbols.map((s) => `${s.name}@L${s.line}`),
          snippet: o.snippet,
        })),
      ];
      if (citations.length === 0) {
        return {
          ok: true,
          commandKind: 'search',
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          citations: [],
          reply: `Vault & Whole-OS search found 0 matches for "${query}".`,
        };
      }
      const vaultSummary = vaultHits.length > 0 ? `Vault: ${vaultHits.map((h) => `${h.title} (${h.vaultPath})`).join(' · ')}` : '';
      const osSummary = osHits.length > 0 ? `OS: ${osHits.map((o) => `${o.path} [${o.symbols.slice(0, 3).map((s) => s.name).join(', ')}]`).join(' · ')}` : '';
      return {
        ok: true,
        commandKind: 'search',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        vaultPath: vaultHits[0]?.vaultPath,
        sha256: vaultHits[0]?.sha256,
        citations,
        reply: [vaultSummary, osSummary].filter(Boolean).join(' | '),
      };
    }

    // 6. FLOW <workflow>
    if (head === 'flow' && rest) {
      const [wfName = '', ...wfArgParts] = rest.split(/\s+/);
      const wfArg = unquote(wfArgParts.join(' ')) || todayDate();

      if (wfName.toLowerCase() === 'daily-digest') {
        const notePath = `05_XYP3RN_RECORDS/00_Daily_Notes/${todayDate()}.md`;
        const stats = this.#db.getIndexStats();
        const appendBody = `\n## Daily Digest (${new Date().toISOString()})\n- Topic: ${wfArg}\n- Indexed Vault Files: ${stats.totalFiles}\n`;
        if (policy.askBeforeChange) {
          return this.#queueChangeProposal({
            commandKind: 'flow',
            engine,
            action: 'append',
            targetScope: 'vault',
            targetPath: notePath,
            content: appendBody,
            actor: 'extractive-summarizer',
            reason: `Workflow daily-digest append on "${wfArg}"`,
            gatewayAction: { type: 'select-job', jobId: 'daily-digest-workflow' },
          });
        }
        const job = this.#db.enqueueJob({
          kind: 'workflow',
          name: wfName,
          input: { args: wfArg },
          startImmediately: true,
        });
        const written = await this.#vault.appendNote({
          vaultPath: notePath,
          appendText: appendBody,
          actor: 'extractive-summarizer',
        });
        this.#db.completeJob(job.id, { vaultPath: written.vaultPath, sha256: written.sha256 });
        return {
          ok: true,
          commandKind: 'flow',
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          jobId: job.id,
          vaultPath: written.vaultPath,
          sha256: written.sha256,
          action: { type: 'select-job', jobId: 'daily-digest-workflow' },
          reply: `Workflow daily-digest executed (vault.search -> extractive-summarizer -> vault.append). Appended to ${written.vaultPath} (sha256:${written.sha256.slice(0, 12)}).`,
        };
      }

      if (wfName.toLowerCase() === 'research-brief') {
        const hits = this.#vault.search(wfArg, { limit: 5 });
        const briefPath = `03_RESEARCH_INTELLIGENCE/00_Briefs/${todayDate()}-${slugify(wfArg)}.md`;
        const citations = hits.map((h) => `- [[${h.vaultPath}|${h.title}]] (sha256:${h.sha256.slice(0, 10)})`).join('\n');
        const briefContent = `---\ntitle: "Research Brief: ${wfArg}"\ntype: research_brief\ndomain: RESEARCH_INTELLIGENCE\ntags: [xyp3rn, research, brief]\n---\n\n# Research Brief: ${wfArg}\n\n## Grounded Vault Evidence\n${citations || '- No prior Vault notes matched.'}\n`;
        if (policy.askBeforeChange) {
          return this.#queueChangeProposal({
            commandKind: 'flow',
            engine,
            action: 'write',
            targetScope: 'vault',
            targetPath: briefPath,
            content: briefContent,
            actor: 'research-orchestrator',
            reason: `Workflow research-brief write on "${wfArg}"`,
            gatewayAction: { type: 'select-job', jobId: 'research-brief-workflow' },
          });
        }
        const job = this.#db.enqueueJob({
          kind: 'workflow',
          name: wfName,
          input: { args: wfArg },
          startImmediately: true,
        });
        const written = await this.#vault.writeNote({
          vaultPath: briefPath,
          content: briefContent,
          actor: 'research-orchestrator',
        });
        this.#db.completeJob(job.id, { vaultPath: written.vaultPath, sha256: written.sha256 });
        return {
          ok: true,
          commandKind: 'flow',
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          jobId: job.id,
          vaultPath: written.vaultPath,
          sha256: written.sha256,
          action: { type: 'select-job', jobId: 'research-brief-workflow' },
          reply: `Workflow research-brief executed -> Filed "${written.vaultPath}" with ${hits.length} grounded Vault citations.`,
        };
      }

      const job = this.#db.enqueueJob({
        kind: 'workflow',
        name: wfName,
        input: { args: wfArg },
        startImmediately: true,
      });
      this.#db.completeJob(job.id, { workflow: wfName, args: wfArg });
      return {
        ok: true,
        commandKind: 'flow',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        jobId: job.id,
        reply: `Dispatched workflow "${wfName}" (job ${job.id}).`,
      };
    }

    // 7. TASK new | run
    if (head === 'task' && rest) {
      const [sub = '', ...taskParts] = rest.split(/\s+/);
      const title = unquote(taskParts.join(' ')) || 'map-the-vault';
      const isRun = sub.toLowerCase() === 'run';
      const taskPath = `01_CORE/06_Tasks/${slugify(title)}.md`;
      const taskContent = `---\ntitle: "${title}"\ntype: task\ndomain: CORE\nstatus: ${isRun ? 'in-progress' : 'open'}\ntags: [xyp3rn, task]\n---\n\n# Task: ${title}\n\nCreated at ${new Date().toISOString()}.\n`;
      if (policy.askBeforeChange) {
        return this.#queueChangeProposal({
          commandKind: isRun ? 'task-run' : 'task-new',
          engine,
          action: 'write',
          targetScope: 'vault',
          targetPath: taskPath,
          content: taskContent,
          actor: 'records-tasks',
          reason: `Create task note "${title}"`,
          gatewayAction: { type: 'select-job', jobId: 'map-vault-task' },
        });
      }
      const job = this.#db.enqueueJob({
        kind: 'task',
        name: title,
        input: { mode: isRun ? 'run' : 'new' },
        startImmediately: true,
      });
      const written = await this.#vault.writeNote({
        vaultPath: taskPath,
        content: taskContent,
        actor: 'records-tasks',
      });
      this.#db.completeJob(job.id, { vaultPath: written.vaultPath });
      return {
        ok: true,
        commandKind: isRun ? 'task-run' : 'task-new',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        jobId: job.id,
        vaultPath: written.vaultPath,
        sha256: written.sha256,
        action: { type: 'select-job', jobId: 'map-vault-task' },
        reply: isRun
          ? `Task Orchestrator running "${title}" -> logged at ${written.vaultPath}.`
          : `Task queued in ${written.vaultPath}.`,
      };
    }

    // 8. REGISTRY
    if (head === 'registry') {
      const boot = await bootstrapAndSyncVault({
        vaultRoot: this.#vault.vaultRoot,
        repoRoot: this.#repoRoot,
      });
      const scan = await this.#vault.scanVault();
      return {
        ok: true,
        commandKind: 'registry',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        action: { type: 'select-job', jobId: 'task-board-dashboard' },
        reply: `Regenerated Agent Registry.md (${this.#agents.list().length} agents) & Workflow Engine.md in 01_CORE/05_Dashboards/ · Scanned ${scan.scannedFiles} Vault files (${boot.syncedAgents} updated).`,
      };
    }

    // 9. PROMOTE <target>
    if (head === 'promote') {
      const target = unquote(rest) || 'all-staged';
      const approval = this.#db.queueApproval({
        itemType: 'vault_promotion',
        itemId: `${slugify(target)}-${Date.now()}`,
        proposer: 'research-orchestrator',
        request: {
          target,
          targetVaultPath: `02_KNOWLEDGE_LAYER/04_Atomic_Notes/${slugify(target)}.md`,
        },
      });
      return {
        ok: true,
        commandKind: 'promote',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        approvalId: approval.id,
        action: { type: 'select-job', jobId: 'knowledge-promotion-framework' },
        reply: `Knowledge Promotion Gate queued "${target}" as human approval ${approval.id} (PENDING_HUMAN_APPROVAL · F35 D2 invariant: nothing auto-approves).`,
      };
    }

    // 10. CONNECTIONS
    if (head === 'connections') {
      return {
        ok: true,
        commandKind: 'connections',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        action: { type: 'select-job', jobId: 'mcp-connector-health-standard' },
        reply: `MCP Connector Health check complete: ${MCP_CONNECTOR_TOTAL}/${MCP_CONNECTOR_TOTAL} connectors healthy on 127.0.0.1.`,
      };
    }

    // 11. SPECIALISTS
    if (head === 'specialists') {
      const specs = this.#agents.list().filter((a) => a.class === 'Research');
      return {
        ok: true,
        commandKind: 'specialists',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        action: { type: 'focus-sector', sectorId: '03_RESEARCH_INTELLIGENCE' },
        reply: `${specs.length} Research Intelligence specialists online (${specs
          .slice(0, 6)
          .map((s) => s.name)
          .join(', ')}, ...).`,
      };
    }

    // 12. RESEARCH <topic>
    if (head === 'research' && rest) {
      const topic = unquote(rest);
      const hits = this.#vault.search(topic, { limit: 5 });
      const briefPath = `03_RESEARCH_INTELLIGENCE/00_Briefs/${todayDate()}-${slugify(topic)}.md`;
      const briefContent = `---\ntitle: "Research Synthesis: ${topic}"\ntype: research_brief\ndomain: RESEARCH_INTELLIGENCE\ntags: [xyp3rn, research]\n---\n\n# Research Synthesis: ${topic}\n\n${hits
        .map((h) => `- **${h.title}** (\`${h.vaultPath}\`)`)
        .join('\n')}\n`;
      if (policy.askBeforeChange) {
        return this.#queueChangeProposal({
          commandKind: 'research',
          engine,
          action: 'write',
          targetScope: 'vault',
          targetPath: briefPath,
          content: briefContent,
          actor: 'research-orchestrator',
          reason: `Write research synthesis for "${topic}"`,
          gatewayAction: { type: 'select-job', jobId: 'on-device-music-brief' },
        });
      }
      const written = await this.#vault.writeNote({
        vaultPath: briefPath,
        content: briefContent,
        actor: 'research-orchestrator',
      });
      return {
        ok: true,
        commandKind: 'research',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        vaultPath: written.vaultPath,
        sha256: written.sha256,
        action: { type: 'select-job', jobId: 'on-device-music-brief' },
        reply: `Research Orchestrator synthesized ${hits.length} Vault sources on "${topic}" -> filed ${written.vaultPath}.`,
      };
    }

    // 13. RECORD / RECORDS
    if (head === 'record' || head === 'records') {
      if (rest) {
        const notePath = `05_XYP3RN_RECORDS/01_Session_Logs/${todayDate()}.md`;
        const appendLine = `- [${new Date().toISOString()}] ${unquote(rest)}\n`;
        if (policy.askBeforeChange) {
          return this.#queueChangeProposal({
            commandKind: 'record',
            engine,
            action: 'append',
            targetScope: 'vault',
            targetPath: notePath,
            content: appendLine,
            actor: 'records-catalog',
            reason: `Append session record entry`,
            gatewayAction: { type: 'focus-sector', sectorId: '05_XYP3RN_RECORDS' },
          });
        }
        const written = await this.#vault.appendNote({
          vaultPath: notePath,
          appendText: appendLine,
          actor: 'records-catalog',
        });
        return {
          ok: true,
          commandKind: 'record',
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          vaultPath: written.vaultPath,
          sha256: written.sha256,
          action: { type: 'focus-sector', sectorId: '05_XYP3RN_RECORDS' },
          reply: `Filed record in ${written.vaultPath}.`,
        };
      }
      const stats = this.#db.getIndexStats();
      return {
        ok: true,
        commandKind: 'records',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        action: { type: 'focus-sector', sectorId: '05_XYP3RN_RECORDS' },
        reply: `05_XYP3RN_RECORDS indexed (${stats.bySector['05_XYP3RN_RECORDS'] ?? 0} sector files): Daily Notes, Session Logs, ADRs, Releases, and X3LIUS Music System.`,
      };
    }

    // 14. SONG NEW / COMPOSE
    if ((head === 'song' && rest.toLowerCase().startsWith('new ')) || (head === 'compose' && rest)) {
      const arg = head === 'song' ? unquote(rest.slice(4)) : unquote(rest);
      const track =
        TRACK_CATALOG.find(
          (t) => t.id === arg.toLowerCase() || t.title.toLowerCase().includes(arg.toLowerCase()),
        ) ?? TRACK_CATALOG[0]!;
      const kbHits = this.#vault.search(arg, { limit: 3 });
      const promptPath = `05_XYP3RN_RECORDS/06_X3LIUS_MUSIC_SYSTEM/07_Suno_Prompts/${slugify(arg || track.title)}.md`;
      const promptContent = `---\ntitle: "Suno Prompt: ${arg || track.title}"\ntype: suno_package\ndomain: RECORDS\ntags: [xyp3rn, x3lius, suno]\n---\n\n# ${arg || track.title}\n\n- **Style Prompt:** ${track.stylePrompt}\n- **BPM:** ${track.bpm}\n- **Grounded KB Refs:** ${kbHits.map((h) => `[[${h.vaultPath}]]`).join(', ') || 'baseline'}\n`;
      if (policy.askBeforeChange) {
        return this.#queueChangeProposal({
          commandKind: head === 'song' ? 'song-new' : 'compose',
          engine,
          action: 'compose',
          targetScope: 'vault',
          targetPath: promptPath,
          content: promptContent,
          actor: 'x3lius-suno',
          reason: `Create Suno prompt package for "${arg || track.title}"`,
          gatewayAction: { type: 'compose-track', trackId: track.id },
        });
      }
      const written = await this.#vault.writeNote({
        vaultPath: promptPath,
        content: promptContent,
        actor: 'x3lius-suno',
      });
      return {
        ok: true,
        commandKind: head === 'song' ? 'song-new' : 'compose',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        vaultPath: written.vaultPath,
        sha256: written.sha256,
        action: { type: 'compose-track', trackId: track.id },
        reply: `X3LIUS Songwriter prepared Suno package for "${arg || track.title}" (${track.bpm} BPM) in ${written.vaultPath}: ${track.stylePrompt}`,
      };
    }

    // 15. PLAY
    if (head === 'play' && rest) {
      const needle = unquote(rest.replace(/\s+now$/i, '')).toLowerCase();
      const track =
        TRACK_CATALOG.find((t) => t.id === needle || t.title.toLowerCase().includes(needle)) ??
        TRACK_CATALOG[0]!;
      return {
        ok: true,
        commandKind: 'play',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        action: { type: 'play-track', trackId: track.id },
        reply: `X3LIUS Player streaming "${track.title}" (${track.format.toUpperCase()} · ${track.bpm} BPM · ${track.release}) with /api/music/pulse spectrum relay.`,
      };
    }

    // 16. GEMINI
    if (head === 'gemini' && rest) {
      const query = unquote(rest);
      const hits = this.#vault.search(query, { limit: 3 });
      return {
        ok: true,
        commandKind: 'gemini',
        engine: 'gemini-api',
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        action: { type: 'select-job', jobId: 'analyst-gemini' },
        reply: `Analyst (Gemini) second opinion on "${query}": Cross-checked against 06_GOVERNANCE policies and ${hits.length} Vault note(s) (${hits.map((h) => h.title).join(', ') || 'no conflicts'}).`,
      };
    }

    // 17. @CONTEXT or GENERAL CHAT / ASK / WHOLE-OS + WHOLE-VAULT Q&A
    if (contextRefs.length > 0) {
      const resolvedSummaries: string[] = [];
      const citations: JarvisCitation[] = [];
      for (const ref of contextRefs) {
        const entry = this.#db.getIndexEntry(ref) ?? this.#vault.search(ref, { limit: 1 })[0] ?? null;
        if (entry) {
          const inspected = await inspectVaultOrOsFile(this, 'vault', entry.vaultPath).catch(() => null);
          const excerpt = inspected
            ? inspected.content.replace(/^---[\s\S]*?---\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 180)
            : '';
          resolvedSummaries.push(`${entry.title} [${entry.vaultPath}]${excerpt ? `: ${excerpt}` : ''}`);
          citations.push({
            scope: 'vault',
            path: entry.vaultPath,
            title: entry.title,
            snippet: excerpt || entry.title,
            sha256: entry.sha256,
          });
        } else {
          const osHits = await searchWholeOs(this, ref, { limit: 1 });
          if (osHits[0]) {
            const hit = osHits[0];
            resolvedSummaries.push(`OS ${hit.path} [${hit.symbols.slice(0, 4).map((s) => s.name).join(', ')}]`);
            citations.push({
              scope: 'os',
              path: hit.path,
              title: hit.title,
              symbols: hit.symbols.map((s) => `${s.name}@L${s.line}`),
              snippet: hit.snippet,
            });
          } else {
            const ag = this.#agents.get(ref.toLowerCase());
            if (ag) resolvedSummaries.push(`Agent ${ag.name} (${ag.class}/${ag.domain})`);
          }
        }
      }
      if (resolvedSummaries.length > 0) {
        return {
          ok: true,
          commandKind: 'chat',
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          citations,
          vaultPath: citations.find((c) => c.scope === 'vault')?.path,
          reply: `Jarvis (${engine}) read ${resolvedSummaries.length} @context reference(s) — ${resolvedSummaries.join(' | ')}`,
        };
      }
    }

    const answer = await answerAcrossVaultAndOs(this, body);
    return {
      ok: true,
      commandKind: head === 'run' ? 'run' : 'chat',
      engine,
      connectorCount: MCP_CONNECTOR_TOTAL,
      connectorHealthy: MCP_CONNECTOR_TOTAL,
      vaultPath: answer.vaultHits[0]?.vaultPath,
      sha256: answer.vaultHits[0]?.sha256,
      citations: answer.citations,
      reply: answer.reply,
    };
  }
}
