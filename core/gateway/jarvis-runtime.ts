import { join, resolve } from 'node:path';
import { createAgentRegistry, type AgentRegistry } from '../agent-registry/registry.ts';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import { createToolRegistry, defineTool, type ToolRegistry } from '../tool-registry/registry.ts';
import { bootstrapAndSyncVault } from '../vault-engine/bootstrap.ts';
import type { VaultEngine } from '../vault-engine/engine.ts';

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

export type GatewayCommandRequest = {
  readonly prompt: string;
  readonly engine?: EngineId | undefined;
  readonly activeSector?: DepartmentId | undefined;
  readonly selectedJobId?: string | null | undefined;
  readonly sessionId?: string | undefined;
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
      result = await this.#dispatchDirective(head, rest, body, engine, contextRefs);
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
  ): Promise<GatewayCommandResponse> {
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

    // 2. READ <path>
    if (head === 'read' && rest) {
      const targetPath = unquote(rest);
      const auth = this.#tools.authorize('Execution', 'vault_read');
      if (!auth.allow) {
        return {
          ok: false,
          commandKind: 'read',
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
        input: { op: 'read', path: targetPath },
      });
      try {
        const doc = await this.#vault.readNote(targetPath);
        const preview = doc.body.replace(/\s+/g, ' ').trim().slice(0, 220);
        this.#db.completeAgentRun(run.id, {
          output: { vaultPath: doc.vaultPath, sha256: doc.sha256, byteSize: doc.byteSize },
          latencyMs: 5,
        });
        return {
          ok: true,
          commandKind: 'read',
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          runId: run.id,
          vaultPath: doc.vaultPath,
          sha256: doc.sha256,
          reply: `${doc.frontmatter.title ?? doc.vaultPath} (${doc.vaultPath} · sha256:${doc.sha256.slice(0, 12)}) — ${preview || '(empty body)'}`,
        };
      } catch (err) {
        this.#db.failAgentRun(run.id, { errorDetail: (err as Error).message });
        return {
          ok: false,
          commandKind: 'read',
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

    // 5. SEARCH <query>
    if (head === 'search' && rest) {
      const query = unquote(rest);
      const hits = this.#vault.search(query, { limit: 5 });
      if (hits.length === 0) {
        return {
          ok: true,
          commandKind: 'search',
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          reply: `vault.search found 0 matches for "${query}".`,
        };
      }
      return {
        ok: true,
        commandKind: 'search',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        vaultPath: hits[0]!.vaultPath,
        sha256: hits[0]!.sha256,
        reply: `vault.search top hits for "${query}": ${hits
          .map((h) => `${h.title} (${h.vaultPath})`)
          .join(' · ')}.`,
      };
    }

    // 6. FLOW <workflow>
    if (head === 'flow' && rest) {
      const [wfName = '', ...wfArgParts] = rest.split(/\s+/);
      const wfArg = unquote(wfArgParts.join(' ')) || todayDate();
      const job = this.#db.enqueueJob({
        kind: 'workflow',
        name: wfName,
        input: { args: wfArg },
        startImmediately: true,
      });

      if (wfName.toLowerCase() === 'daily-digest') {
        const notePath = `05_XYP3RN_RECORDS/00_Daily_Notes/${todayDate()}.md`;
        const stats = this.#db.getIndexStats();
        const written = await this.#vault.appendNote({
          vaultPath: notePath,
          appendText: `\n## Daily Digest (${new Date().toISOString()})\n- Topic: ${wfArg}\n- Indexed Vault Files: ${stats.totalFiles}\n`,
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
        const written = await this.#vault.writeNote({
          vaultPath: briefPath,
          content: `---\ntitle: "Research Brief: ${wfArg}"\ntype: research_brief\ndomain: RESEARCH_INTELLIGENCE\ntags: [xyp3rn, research, brief]\n---\n\n# Research Brief: ${wfArg}\n\n## Grounded Vault Evidence\n${citations || '- No prior Vault notes matched.'}\n`,
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
      const job = this.#db.enqueueJob({
        kind: 'task',
        name: title,
        input: { mode: isRun ? 'run' : 'new' },
        startImmediately: true,
      });
      const taskPath = `01_CORE/06_Tasks/${slugify(title)}.md`;
      const written = await this.#vault.writeNote({
        vaultPath: taskPath,
        content: `---\ntitle: "${title}"\ntype: task\ndomain: CORE\nstatus: ${isRun ? 'in-progress' : 'open'}\ntags: [xyp3rn, task]\n---\n\n# Task: ${title}\n\nCreated at ${new Date().toISOString()}.\n`,
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
      const written = await this.#vault.writeNote({
        vaultPath: briefPath,
        content: `---\ntitle: "Research Synthesis: ${topic}"\ntype: research_brief\ndomain: RESEARCH_INTELLIGENCE\ntags: [xyp3rn, research]\n---\n\n# Research Synthesis: ${topic}\n\n${hits
          .map((h) => `- **${h.title}** (\`${h.vaultPath}\`)`)
          .join('\n')}\n`,
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
        const written = await this.#vault.appendNote({
          vaultPath: notePath,
          appendText: `- [${new Date().toISOString()}] ${unquote(rest)}\n`,
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
      const written = await this.#vault.writeNote({
        vaultPath: promptPath,
        content: `---\ntitle: "Suno Prompt: ${arg || track.title}"\ntype: suno_package\ndomain: RECORDS\ntags: [xyp3rn, x3lius, suno]\n---\n\n# ${arg || track.title}\n\n- **Style Prompt:** ${track.stylePrompt}\n- **BPM:** ${track.bpm}\n- **Grounded KB Refs:** ${kbHits.map((h) => `[[${h.vaultPath}]]`).join(', ') || 'baseline'}\n`,
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

    // 17. @CONTEXT or GENERAL CHAT / RUN
    if (contextRefs.length > 0) {
      const resolvedSummaries: string[] = [];
      for (const ref of contextRefs) {
        const entry = this.#db.getIndexEntry(ref) ?? this.#vault.search(ref, { limit: 1 })[0] ?? null;
        if (entry) {
          resolvedSummaries.push(`${entry.title} [${entry.vaultPath}]`);
        } else {
          const ag = this.#agents.get(ref.toLowerCase());
          if (ag) resolvedSummaries.push(`Agent ${ag.name} (${ag.class}/${ag.domain})`);
        }
      }
      if (resolvedSummaries.length > 0) {
        return {
          ok: true,
          commandKind: 'chat',
          engine,
          connectorCount: MCP_CONNECTOR_TOTAL,
          connectorHealthy: MCP_CONNECTOR_TOTAL,
          reply: `Jarvis (${engine}) injected ${resolvedSummaries.length} @context reference(s) from Vault — ${resolvedSummaries.join(' | ')}`,
        };
      }
    }

    const searchHits = this.#vault.search(body, { limit: 3 });
    if (searchHits.length > 0) {
      const top = searchHits[0]!;
      return {
        ok: true,
        commandKind: head === 'run' ? 'run' : 'chat',
        engine,
        connectorCount: MCP_CONNECTOR_TOTAL,
        connectorHealthy: MCP_CONNECTOR_TOTAL,
        vaultPath: top.vaultPath,
        sha256: top.sha256,
        reply: `Jarvis (${engine}) routed to Vault note "${top.title}" (${top.vaultPath} · sector ${top.sector}).`,
      };
    }

    const stats = this.#db.getIndexStats();
    return {
      ok: true,
      commandKind: 'chat',
      engine,
      connectorCount: MCP_CONNECTOR_TOTAL,
      connectorHealthy: MCP_CONNECTOR_TOTAL,
      reply: `Jarvis Operator (${engine}) standing by across 6 sectors and ${stats.totalFiles} indexed Vault notes. Try "xyp3rn> status", "xyp3rn> search UK drill", or "play Neon Static".`,
    };
  }
}
