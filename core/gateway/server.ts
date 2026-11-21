import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { redactSecrets, StructuredLogger } from '../runtime/logger.ts';
import {
  acquireRuntimeSingletonLock,
  detectIncompleteMigrations,
  inspectVaultAvailability,
  recoverInterruptedRuntimeState,
  type MigrationCompletenessReport,
  type RuntimeSingletonLease,
  type StartupRecoveryReport,
  type VaultAvailabilityReport,
} from '../runtime/release-startup.ts';
import { validateEntityContent } from '../vault-engine/schema-validator.ts';
import {
  AUDIO_EXTRACTED_PROMPTS_DIR,
  listExtractedAudioPrompts,
  reverseEngineerAudioTelemetry,
  saveExtractedAudioPromptsToVault,
  type AudioAcousticTelemetry,
  type AudioPromptFacet,
  type AudioPromptSaveMode,
  type AudioReverseEngineeredSpec,
} from './audio-reverse-engineer.ts';
import { computePulseSpectrum, type GatewayCommandRequest, type Os3JarvisRuntime } from './jarvis-runtime.ts';
import { getOrCreateDawGateway } from './daw-gateway.ts';
import { inspectVaultOrOsFile, searchWholeOs, searchWholeVault } from './jarvis-inspector.ts';
import {
  buildAgentsSnapshot,
  buildCoreModulesOverview,
  buildDiagnosticsOverview,
  buildGovernanceOverview,
  buildKnowledgeGraph,
  buildRecordsOverview,
  buildResearchOverview,
  buildSystemOverview,
  buildVaultTree,
  listWorkflowSummaries,
} from './ui-queries.ts';

export const DEFAULT_GATEWAY_HOST = '127.0.0.1';
export const DEFAULT_GATEWAY_PORT = 8077;

const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;
const LOCAL_ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

const AGENT_OR_SYSTEM_ACTOR_RE =
  /^(agent:|system$|jarvis$|auto$|x3lius-|tech-|records-)|-(agent|researcher|orchestrator|curator|summarizer|retriever|checker|generator|editor|advisor|assessor|forecaster|advocate|engine)$/i;

const isAgentIdentity = (actor: string): boolean => AGENT_OR_SYSTEM_ACTOR_RE.test(actor.trim());

const safeTokenEquals = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const extractRequestToken = (req: IncomingMessage): string | null => {
  const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const xToken = req.headers['x-xyp-token'];
  if (typeof xToken === 'string' && xToken.trim()) {
    return xToken.trim();
  }
  return null;
};

/**
 * Enforces 06_GOVERNANCE/00_Policies/Localhost Binding Policy.md and
 * 06_GOVERNANCE/02_Access_Control/Same-Origin & Host Allowlist.md.
 */
export const isAllowedGatewayOrigin = (
  host: string | undefined,
  origin?: string | null,
  referer?: string | null,
): boolean => {
  if (!host || !LOCAL_HOST_RE.test(host.trim())) return false;
  if (origin !== undefined && origin !== null && origin !== '' && !LOCAL_ORIGIN_RE.test(origin.trim())) {
    return false;
  }
  if (referer !== undefined && referer !== null && referer !== '') {
    try {
      const refOrigin = new URL(referer).origin;
      if (!LOCAL_ORIGIN_RE.test(refOrigin)) return false;
    } catch {
      return false;
    }
  }
  return true;
};

const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const sanitizeParsedJson = (val: unknown): unknown => {
  if (Array.isArray(val)) return val.map(sanitizeParsedJson);
  if (val !== null && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (PROTO_POLLUTION_KEYS.has(k)) continue;
      out[k] = sanitizeParsedJson(v);
    }
    return out;
  }
  return val;
};

const readJsonBody = async (req: IncomingMessage, maxBytes = 256 * 1024): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body exceeds 256 KB limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) {
          resolve({});
          return;
        }
        const parsed = sanitizeParsedJson(JSON.parse(text));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {});
      } catch (err) {
        reject(new Error(`invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });

const corsHeaders = (origin?: string | undefined): Record<string, string> => {
  const allowedOrigin = origin && LOCAL_ORIGIN_RE.test(origin) ? origin : 'http://127.0.0.1:3000';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, X-XYP-Token',
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin',
  };
};

const sendJson = (
  res: ServerResponse,
  status: number,
  payload: unknown,
  origin?: string | undefined,
): void => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(origin),
  });
  res.end(JSON.stringify(payload));
};

const sendHtml = (res: ServerResponse, html: string, origin?: string | undefined): void => {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(origin),
  });
  res.end(html);
};

export type Os3GatewayServerHandle = {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly logger: StructuredLogger;
  readonly dawBrainEnabled: boolean;
  readonly vaultAvailability: VaultAvailabilityReport;
  readonly migrationStatus: MigrationCompletenessReport;
  readonly startupRecovery: StartupRecoveryReport;
  readonly close: () => Promise<void>;
};

export type Os3GatewayRuntimeContext = {
  readonly dawBrainEnabled: boolean;
  readonly startupRecovery: StartupRecoveryReport;
};

/**
 * Creates the local-first XYP3RN OS 3.0 HTTP Gateway server bound strictly to 127.0.0.1.
 */
export const startOs3GatewayServer = async (
  runtime: Os3JarvisRuntime,
  options: {
    readonly host?: string | undefined;
    readonly port?: number | undefined;
    readonly logger?: StructuredLogger | undefined;
    readonly authToken?: string | undefined;
    readonly dawBrainEnabled?: boolean | undefined;
    readonly enforceSingletonLock?: boolean | undefined;
    readonly singletonOwnerId?: string | undefined;
    readonly failOnIncompleteMigration?: boolean | undefined;
    readonly strictVaultRequired?: boolean | undefined;
    readonly recoverInterruptedOnBoot?: boolean | undefined;
  } = {},
): Promise<Os3GatewayServerHandle> => {
  const host = options.host ?? DEFAULT_GATEWAY_HOST;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`Security policy violation: OS 3.0 Gateway must bind to 127.0.0.1, refused "${host}"`);
  }
  const requestedPort = options.port ?? DEFAULT_GATEWAY_PORT;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`Invalid OS 3.0 Gateway port: ${String(requestedPort)}`);
  }
  const logger = options.logger ?? new StructuredLogger({ service: 'xyp3rn-os3-gateway' });
  const authToken = options.authToken?.trim() || process.env.XYP_GATEWAY_TOKEN?.trim() || undefined;
  if (process.env.XYP_REQUIRE_AUTH === '1' && !authToken) {
    throw new Error('Security policy violation: XYP_REQUIRE_AUTH=1 requires a non-empty authToken / XYP_GATEWAY_TOKEN');
  }

  const vaultAvailability = inspectVaultAvailability(runtime.vault.vaultRoot);
  if (options.strictVaultRequired && !vaultAvailability.available) {
    const err = new Error(
      `OS3_STARTUP_VAULT_UNAVAILABLE: ${vaultAvailability.reason ?? 'Vault unavailable'}`,
    ) as Error & { code: string };
    err.code = 'OS3_STARTUP_VAULT_UNAVAILABLE';
    throw err;
  }

  let singletonLease: RuntimeSingletonLease | null = null;
  if (options.enforceSingletonLock) {
    singletonLease = acquireRuntimeSingletonLock(runtime.db, runtime.db.dbPath, {
      ownerId: options.singletonOwnerId,
      rejectSameProcessDuplicate: true,
    });
  }

  try {
    const startupRecovery =
      options.recoverInterruptedOnBoot !== false
        ? recoverInterruptedRuntimeState(runtime.db)
        : { recoveredLocksCount: 0, recoveredJobIds: [] };

    const migrationStatus = detectIncompleteMigrations(runtime.db, runtime.vault.vaultRoot);
    if (options.failOnIncompleteMigration && !migrationStatus.complete) {
      const err = new Error(
        `OS3_INCOMPLETE_MIGRATION_DETECTED: ${migrationStatus.incompleteReasons.join('; ')}`,
      ) as Error & { code: string };
      err.code = 'OS3_INCOMPLETE_MIGRATION_DETECTED';
      throw err;
    }

    const dawBrainEnabled =
      options.dawBrainEnabled !== undefined
        ? options.dawBrainEnabled
        : process.env.XYP_DISABLE_DAW_BRAIN !== '1' && process.env.XYP_ENABLE_DAW_BRAIN !== '0';

    const rtCtx: Os3GatewayRuntimeContext = {
      dawBrainEnabled,
      startupRecovery,
    };

    const server = createServer((req, res) => {
      const sanitizedUrl = redactSecrets(req.url ?? '/');
      logger.debug('http.request', `${req.method ?? 'GET'} ${sanitizedUrl}`, {
        method: req.method,
        url: sanitizedUrl,
        host: req.headers.host,
      });
      void handleRequest(runtime, req, res, logger, authToken, rtCtx);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(requestedPort, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
    const url = `http://${host}:${actualPort}`;
    logger.info('gateway.started', `OS 3.0 Gateway listening on ${url}`, {
      host,
      port: actualPort,
      vaultRoot: runtime.vault.vaultRoot,
      vaultAvailable: vaultAvailability.available,
      dawBrainEnabled,
      migrationComplete: migrationStatus.complete,
    });

    return {
      server,
      host,
      port: actualPort,
      url,
      logger,
      dawBrainEnabled,
      vaultAvailability,
      migrationStatus,
      startupRecovery,
      close: () =>
        new Promise<void>((resolve, reject) => {
          logger.info('gateway.stopping', `Shutting down OS 3.0 Gateway on ${url}`);
          singletonLease?.release();
          server.closeAllConnections?.();
          server.close((err) => {
            if (err) {
              reject(err);
            } else {
              logger.info('gateway.stopped', `OS 3.0 Gateway stopped cleanly`);
              resolve();
            }
          });
        }),
    };
  } catch (err) {
    singletonLease?.release();
    throw err;
  }
};

const renderGatewayDashboardHtml = (runtime: Os3JarvisRuntime): string => {
  const stats = runtime.db.getIndexStats();
  const pendingApprovals = runtime.db.listApprovals('pending').length;
  const agentsCount = runtime.agents.list().length;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>XYP3RN OS 3.0 — JARVIS & Vault Gateway (:8077)</title>
  <style>
    :root {
      --bg: #20232E;
      --bg-card: rgba(24, 27, 36, 0.9);
      --ink: #EFEBE2;
      --ink-dim: #8B8F9C;
      --hairline: rgba(239, 235, 226, 0.14);
      --accent: #F59B5C;
      --core: #38BDF8;
      --records: #3ECFB2;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--ink);
      line-height: 1.5;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 24px;
      border-bottom: 1px solid var(--hairline);
      background: rgba(20, 22, 30, 0.92);
    }
    .title { font-size: 18px; font-weight: 700; letter-spacing: 0.04em; }
    .sub { font-family: ui-monospace, monospace; font-size: 11px; color: var(--ink-dim); }
    .badge {
      font-family: ui-monospace, monospace;
      font-size: 11px;
      padding: 5px 10px;
      border-radius: 999px;
      border: 1px solid var(--hairline);
      color: var(--records);
    }
    .nav-btn {
      font-family: ui-monospace, monospace;
      font-size: 11px;
      padding: 6px 12px;
      border-radius: 999px;
      border: 1px solid var(--accent);
      color: var(--accent);
      text-decoration: none;
    }
    main {
      max-width: 1260px;
      margin: 0 auto;
      padding: 20px 24px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 18px;
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--hairline);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    h2 {
      margin: 0;
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--ink-dim);
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
    }
    .stat {
      border: 1px solid var(--hairline);
      border-radius: 8px;
      padding: 10px;
    }
    .stat-val {
      font-family: ui-monospace, monospace;
      font-size: 20px;
      font-weight: 700;
      color: var(--core);
    }
    .stat-lbl { font-size: 11px; color: var(--ink-dim); }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    input[type="text"] {
      flex: 1;
      min-width: 180px;
      background: #171922;
      color: var(--ink);
      border: 1px solid var(--hairline);
      border-radius: 8px;
      padding: 8px 12px;
      font-family: ui-monospace, monospace;
      font-size: 12px;
    }
    button {
      background: var(--accent);
      color: #171922;
      border: none;
      border-radius: 8px;
      padding: 8px 14px;
      font-family: ui-monospace, monospace;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
    }
    button.chip {
      background: transparent;
      color: var(--ink);
      border: 1px solid var(--hairline);
      font-weight: 500;
    }
    button.chip:hover { border-color: var(--accent); color: var(--accent); }
    pre {
      margin: 0;
      background: #14161E;
      border: 1px solid var(--hairline);
      border-radius: 8px;
      padding: 12px;
      font-family: ui-monospace, monospace;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 300px;
      overflow-y: auto;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <div class="title">XYP3RN OS 3.0 — JARVIS & VAULT GATEWAY</div>
      <div class="sub">127.0.0.1:8077 · Vault: ${runtime.vault.vaultRoot}</div>
    </div>
    <div class="row" style="align-items:center">
      <span class="badge">● 127.0.0.1:8077 ONLINE</span>
      <a class="nav-btn" href="http://127.0.0.1:3000/map">OPEN CONSTELLATION MAP (:3000) →</a>
      <a class="nav-btn" href="http://127.0.0.1:3000/jarvis">OPEN JARVIS CONSOLE (:3000/jarvis) →</a>
    </div>
  </header>
  <main>
    <section class="card">
      <h2>1. Live Vault & Runtime Telemetry</h2>
      <div class="stats-grid">
        <div class="stat"><div class="stat-val" id="st-files">${stats.totalFiles}</div><div class="stat-lbl">Indexed Vault Files</div></div>
        <div class="stat"><div class="stat-val" id="st-agents">${agentsCount}</div><div class="stat-lbl">Registered Agents</div></div>
        <div class="stat"><div class="stat-val" id="st-approvals">${pendingApprovals}</div><div class="stat-lbl">Pending Approvals</div></div>
      </div>
      <pre id="sector-breakdown">${JSON.stringify(stats.bySector, null, 2)}</pre>
    </section>

    <section class="card">
      <h2>2. JARVIS Command Terminal (POST /api/jarvis)</h2>
      <div class="row">
        <button class="chip" onclick="runCmd('xyp3rn> status')">status</button>
        <button class="chip" onclick="runCmd('xyp3rn> read 01_CORE/00_Identity/Mission.md')">read Mission.md</button>
        <button class="chip" onclick="runCmd('xyp3rn> search UK drill')">search UK drill</button>
        <button class="chip" onclick="runCmd('xyp3rn> specialists')">specialists</button>
        <button class="chip" onclick="runCmd('xyp3rn> flow research-brief 808-glide')">flow research-brief</button>
        <button class="chip" onclick="runCmd('xyp3rn> compose Neon Static')">compose Neon Static</button>
      </div>
      <div class="row">
        <input type="text" id="cmd-input" value="xyp3rn> status" />
        <button onclick="runCmd(document.getElementById('cmd-input').value)">DISPATCH</button>
      </div>
      <pre id="cmd-out">Ready. Click any directive above or press DISPATCH.</pre>
    </section>

    <section class="card">
      <h2>3. Obsidian Vault Explorer & Note Reader</h2>
      <div class="row">
        <input type="text" id="search-input" value="UK drill" placeholder="Search 20,200+ Vault notes..." />
        <button onclick="searchVault()">SEARCH VAULT</button>
      </div>
      <div class="row" id="search-hits"></div>
      <pre id="note-viewer">Select a search result to inspect its live Markdown and SHA-256 checksum.</pre>
    </section>

    <section class="card">
      <h2>4. Promotion Gate & Recent Runs</h2>
      <div class="row">
        <button class="chip" onclick="loadApprovals()">Refresh Approvals</button>
        <button class="chip" onclick="loadRuns()">Refresh Agent Runs</button>
        <button class="chip" onclick="loadEvents()">Refresh Audit Events</button>
      </div>
      <pre id="audit-viewer">Click a button above to inspect pending human approvals, agent_runs, or audit events.</pre>
    </section>
  </main>
  <script>
    async function runCmd(prompt) {
      document.getElementById('cmd-input').value = prompt;
      const res = await fetch('/api/jarvis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      const data = await res.json();
      document.getElementById('cmd-out').textContent = JSON.stringify(data, null, 2);
      if (data.vaultPath) inspectNote(data.vaultPath);
    }
    async function searchVault() {
      const q = document.getElementById('search-input').value;
      const res = await fetch('/api/vault/search?q=' + encodeURIComponent(q) + '&limit=8');
      const data = await res.json();
      const container = document.getElementById('search-hits');
      container.innerHTML = '';
      for (const h of (data.hits || [])) {
        const btn = document.createElement('button');
        btn.className = 'chip';
        btn.textContent = h.title.slice(0, 38) + ' [' + h.sector + ']';
        btn.onclick = () => inspectNote(h.vaultPath);
        container.appendChild(btn);
      }
      if ((data.hits || []).length > 0) inspectNote(data.hits[0].vaultPath);
    }
    async function inspectNote(path) {
      const res = await fetch('/api/vault/note?path=' + encodeURIComponent(path));
      const data = await res.json();
      if (data.ok && data.note) {
        document.getElementById('note-viewer').textContent =
          'PATH: ' + data.note.vaultPath + '\\nSHA-256: ' + data.note.sha256 + '\\nSECTOR: ' + data.note.sector + '\\n\\n' + data.note.rawContent;
      } else {
        document.getElementById('note-viewer').textContent = JSON.stringify(data, null, 2);
      }
    }
    async function loadApprovals() {
      const res = await fetch('/api/approvals');
      document.getElementById('audit-viewer').textContent = JSON.stringify(await res.json(), null, 2);
    }
    async function loadRuns() {
      const res = await fetch('/api/runs?limit=10');
      document.getElementById('audit-viewer').textContent = JSON.stringify(await res.json(), null, 2);
    }
    async function loadEvents() {
      const res = await fetch('/api/events?limit=15');
      document.getElementById('audit-viewer').textContent = JSON.stringify(await res.json(), null, 2);
    }
    searchVault();
    loadRuns();
  </script>
</body>
</html>`;
};

async function handleRequest(
  runtime: Os3JarvisRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  logger?: StructuredLogger,
  authToken?: string,
  rtCtx?: Os3GatewayRuntimeContext,
): Promise<void> {
  const host = req.headers.host;
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined;

  if (!isAllowedGatewayOrigin(host, origin, referer)) {
    sendJson(res, 403, {
      ok: false,
      error: '403 FORBIDDEN: Same-Origin & Host Allowlist rejected non-localhost request',
    });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url ?? '/', `http://${host ?? '127.0.0.1'}`);
  const pathname = parsedUrl.pathname;

  // Enforce Bearer / X-XYP-Token API authentication when authToken is configured
  if (authToken && pathname.startsWith('/api/') && pathname !== '/api/health') {
    const provided = extractRequestToken(req);
    if (!provided || !safeTokenEquals(provided, authToken)) {
      logger?.warn('auth.denied', `Unauthorized API request to ${pathname}`);
      sendJson(
        res,
        401,
        { ok: false, error: '401 UNAUTHORIZED: valid Bearer token or X-XYP-Token header required' },
        origin,
      );
      return;
    }
  }

  try {
    // 0. GET / — Interactive OS 3.0 Gateway & Vault Control Console
    if (req.method === 'GET' && pathname === '/') {
      const accept = String(req.headers.accept ?? '');
      if (accept.includes('application/json') && !accept.includes('text/html')) {
        const indexStats = runtime.db.getIndexStats();
        sendJson(
          res,
          200,
          {
            ok: true,
            service: 'xyp3rn-os3-gateway',
            vaultRoot: runtime.vault.vaultRoot,
            agentsCount: runtime.agents.list().length,
            indexStats,
          },
          origin,
        );
        return;
      }
      sendHtml(res, renderGatewayDashboardHtml(runtime), origin);
      return;
    }

    // 1. GET /api/health
    if (req.method === 'GET' && pathname === '/api/health') {
      const sqliteOpen = runtime.db.isOpen;
      const indexStats = sqliteOpen ? runtime.db.getIndexStats() : { totalFiles: 0, bySector: {} };
      const pendingApprovals = sqliteOpen ? runtime.db.listApprovals('pending').length : 0;
      const activeLocks = sqliteOpen ? runtime.db.listLocks().length : 0;
      const integrity = sqliteOpen ? runtime.db.checkIntegrity() : null;
      const vaultAvail = inspectVaultAvailability(runtime.vault.vaultRoot);
      const migrationStatus = detectIncompleteMigrations(runtime.db, runtime.vault.vaultRoot);
      const dawBrainEnabled = rtCtx?.dawBrainEnabled ?? true;
      sendJson(
        res,
        200,
        {
          ok: true,
          service: 'xyp3rn-os3-gateway',
          vaultRoot: runtime.vault.vaultRoot,
          vaultAvailable: vaultAvail.available,
          vaultMode: vaultAvail.mode,
          vaultDegradedReason: vaultAvail.reason,
          sqlitePath: runtime.db.dbPath,
          sqliteOpen,
          schemaVersion: integrity?.schemaVersion ?? null,
          integrityOk: integrity?.ok ?? false,
          migrationComplete: migrationStatus.complete,
          migrationStatus,
          dawBrainEnabled,
          startupRecovery: rtCtx?.startupRecovery ?? { recoveredLocksCount: 0, recoveredJobIds: [] },
          activeLocks,
          agentsCount: runtime.agents.list().length,
          pendingApprovals,
          indexStats,
        },
        origin,
      );
      return;
    }

    // 2. POST /api/jarvis
    if (req.method === 'POST' && pathname === '/api/jarvis') {
      const body = await readJsonBody(req);
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      if (!prompt.trim()) {
        sendJson(res, 400, { ok: false, error: 'prompt is required' }, origin);
        return;
      }
      const cmdReq: GatewayCommandRequest = {
        prompt,
        engine:
          body.engine === 'gemini-api' || body.engine === 'claude-code-cli'
            ? body.engine
            : undefined,
        activeSector: typeof body.activeSector === 'string' ? (body.activeSector as GatewayCommandRequest['activeSector']) : undefined,
        selectedJobId: typeof body.selectedJobId === 'string' ? body.selectedJobId : null,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        askBeforeChange: body.askBeforeChange === true,
        readAccepted: body.readAccepted !== false,
      };
      const out = await runtime.execute(cmdReq);
      sendJson(res, 200, out, origin);
      return;
    }

    // 3. GET /api/music/pulse
    if (req.method === 'GET' && pathname === '/api/music/pulse') {
      const trackId = parsedUrl.searchParams.get('track') ?? 'neon-static';
      const t = Number(parsedUrl.searchParams.get('t') ?? '0') || 0;
      const bpm = Number(parsedUrl.searchParams.get('bpm') ?? '142') || 142;
      const spectrum = computePulseSpectrum(trackId, bpm, t, true, 24);
      sendJson(res, 200, { ok: true, track: trackId, t, spectrum }, origin);
      return;
    }

    // 4. GET /api/vault/note?path=<relPath>
    if (req.method === 'GET' && pathname === '/api/vault/note') {
      const relPath = parsedUrl.searchParams.get('path') ?? '';
      if (!relPath.trim()) {
        sendJson(res, 400, { ok: false, error: 'path query parameter is required' }, origin);
        return;
      }
      try {
        const doc = await runtime.vault.readNote(relPath);
        const secretCheck = validateEntityContent(doc.vaultPath, doc.rawContent, { requireSchema: false });
        if (secretCheck.issues.some((i) => i.code === 'SECRET_DETECTED')) {
          sendJson(
            res,
            403,
            { ok: false, error: '403 FORBIDDEN: note blocked because secret material was detected on disk' },
            origin,
          );
          return;
        }
        const links = runtime.vault.resolveLinks(doc.vaultPath);
        sendJson(res, 200, { ok: true, note: doc, links }, origin);
      } catch (err) {
        sendJson(res, 404, { ok: false, error: redactSecrets((err as Error).message) }, origin);
      }
      return;
    }

    // 5. GET /api/vault/search?q=<query>&sector=<sector>&limit=<n>
    if (req.method === 'GET' && pathname === '/api/vault/search') {
      const q = parsedUrl.searchParams.get('q') ?? '';
      const sector = parsedUrl.searchParams.get('sector') ?? undefined;
      const limit = Math.min(100, Math.max(1, Number(parsedUrl.searchParams.get('limit') ?? '20') || 20));
      const hits = runtime.vault.search(q, { sector, limit });
      sendJson(res, 200, { ok: true, query: q, count: hits.length, hits }, origin);
      return;
    }

    // 6. GET /api/approvals?status=pending
    if (req.method === 'GET' && pathname === '/api/approvals') {
      const statusParam = parsedUrl.searchParams.get('status');
      const status =
        statusParam === 'pending' || statusParam === 'approved' || statusParam === 'rejected'
          ? statusParam
          : undefined;
      const approvals = runtime.db.listApprovals(status);
      sendJson(res, 200, { ok: true, count: approvals.length, approvals }, origin);
      return;
    }

    // 7. POST /api/approvals/decide
    if (req.method === 'POST' && pathname === '/api/approvals/decide') {
      const body = await readJsonBody(req);
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : '';
      const decision = body.decision === 'approved' || body.decision === 'rejected' ? body.decision : null;
      const approver = typeof body.approver === 'string' ? body.approver.trim() : '';
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

      if (!approvalId || !decision || !approver || !reason) {
        sendJson(
          res,
          400,
          { ok: false, error: 'approvalId, decision (approved|rejected), approver, and reason are required' },
          origin,
        );
        return;
      }

      const existing = runtime.db.getApproval(approvalId);
      if (!existing) {
        sendJson(res, 404, { ok: false, error: `approval not found: ${approvalId}` }, origin);
        return;
      }
      if (existing.status !== 'pending') {
        sendJson(
          res,
          409,
          { ok: false, error: `approval "${approvalId}" is sealed once decided (status: ${existing.status})` },
          origin,
        );
        return;
      }
      if (
        decision === 'approved' &&
        (approver.toLowerCase() === existing.proposer.trim().toLowerCase() || isAgentIdentity(approver))
      ) {
        logger?.warn('governance.self_approval_blocked', `Blocked self/agent approval on ${approvalId}`, {
          proposer: existing.proposer,
          approver,
        });
        sendJson(
          res,
          403,
          {
            ok: false,
            code: 'SELF_APPROVAL_FORBIDDEN',
            error: `403 FORBIDDEN: proposer or agent "${approver}" cannot approve candidate "${approvalId}". Human approval required.`,
          },
          origin,
        );
        return;
      }

      const decided = runtime.db.decideApproval({ approvalId, decision, approver, reason });
      let promotedNote: unknown = null;

      if (
        decision === 'approved' &&
        decided.itemType === 'vault_promotion' &&
        typeof decided.request.targetVaultPath === 'string' &&
        typeof decided.request.body === 'string'
      ) {
        promotedNote = await runtime.vault.promoteToCanonical({
          approvalId: decided.id,
          targetVaultPath: decided.request.targetVaultPath,
          title: typeof decided.request.title === 'string' ? decided.request.title : decided.itemId,
          body: decided.request.body,
          domain: typeof decided.request.domain === 'string' ? decided.request.domain : 'KNOWLEDGE',
        });
      }

      sendJson(res, 200, { ok: true, approval: decided, promotedNote }, origin);
      return;
    }

    // 8. GET /api/events?afterId=0&limit=50
    if (req.method === 'GET' && pathname === '/api/events') {
      const afterId = Number(parsedUrl.searchParams.get('afterId') ?? '0') || 0;
      const limit = Math.min(200, Math.max(1, Number(parsedUrl.searchParams.get('limit') ?? '50') || 50));
      const events = runtime.db.listEvents({ afterId, limit });
      sendJson(res, 200, { ok: true, count: events.length, events }, origin);
      return;
    }

    // 9. GET /api/runs?limit=25
    if (req.method === 'GET' && pathname === '/api/runs') {
      const limit = Math.min(100, Math.max(1, Number(parsedUrl.searchParams.get('limit') ?? '25') || 25));
      const agentRuns = runtime.db.listAgentRuns(limit);
      const jobs = runtime.db.listJobs(limit);
      sendJson(res, 200, { ok: true, agentRuns, jobs }, origin);
      return;
    }

    // 10. GET /api/overview
    if (req.method === 'GET' && pathname === '/api/overview') {
      const overview = await buildSystemOverview(runtime);
      sendJson(res, 200, overview, origin);
      return;
    }

    // 11. GET /api/vault/tree?sector=<sector>&limit=<n>
    if (req.method === 'GET' && pathname === '/api/vault/tree') {
      const sector = parsedUrl.searchParams.get('sector') ?? undefined;
      const limitParam = parsedUrl.searchParams.get('limit');
      const limit = limitParam ? Number(limitParam) || 200 : undefined;
      sendJson(res, 200, buildVaultTree(runtime, { sector, limit }), origin);
      return;
    }

    // 12. GET /api/vault/graph?sector=<sector>&limit=<n>
    if (req.method === 'GET' && pathname === '/api/vault/graph') {
      const sector = parsedUrl.searchParams.get('sector') ?? undefined;
      const limitParam = parsedUrl.searchParams.get('limit');
      const limit = limitParam ? Number(limitParam) || 160 : undefined;
      sendJson(res, 200, buildKnowledgeGraph(runtime, { sector, limit }), origin);
      return;
    }

    // 13. GET /api/agents
    if (req.method === 'GET' && pathname === '/api/agents') {
      sendJson(res, 200, { ok: true, ...buildAgentsSnapshot(runtime) }, origin);
      return;
    }

    // 14. GET /api/workflows
    if (req.method === 'GET' && pathname === '/api/workflows') {
      const workflows = await listWorkflowSummaries(runtime);
      sendJson(res, 200, { ok: true, total: workflows.length, workflows }, origin);
      return;
    }

    // 15. GET /api/research
    if (req.method === 'GET' && pathname === '/api/research') {
      sendJson(res, 200, buildResearchOverview(runtime), origin);
      return;
    }

    // 16. GET /api/records
    if (req.method === 'GET' && pathname === '/api/records') {
      sendJson(res, 200, buildRecordsOverview(runtime), origin);
      return;
    }

    // 17. GET /api/audio/prompts — list extracted Markdown prompts strictly from 09_X3LIUS_MUSIC/AUDIO_EXTRACTED_PROMPTS/
    if (req.method === 'GET' && pathname === '/api/audio/prompts') {
      const prompts = listExtractedAudioPrompts(runtime);
      sendJson(res, 200, { ok: true, folder: AUDIO_EXTRACTED_PROMPTS_DIR, count: prompts.length, prompts }, origin);
      return;
    }

    // 18. POST /api/audio/reverse-engineer — extract style/genres/vocal/flow/instruments from acoustic telemetry (never stores binary audio)
    if (req.method === 'POST' && pathname === '/api/audio/reverse-engineer') {
      const body = await readJsonBody(req, 512 * 1024);
      const telemetry = body.telemetry as AudioAcousticTelemetry | undefined;
      if (!telemetry || typeof telemetry !== 'object' || typeof telemetry.fileName !== 'string' || !telemetry.fileName.trim()) {
        sendJson(res, 400, { ok: false, error: 'telemetry object with non-empty fileName is required' }, origin);
        return;
      }
      const spec = await reverseEngineerAudioTelemetry(runtime, telemetry, {
        useLlm: body.useLlm === true,
        titleHint: typeof body.titleHint === 'string' ? body.titleHint : undefined,
      });
      sendJson(res, 200, { ok: true, folder: AUDIO_EXTRACTED_PROMPTS_DIR, spec }, origin);
      return;
    }

    // 19. POST /api/audio/save-prompts — operator-confirmed save of extracted Markdown notes into dedicated Obsidian folder
    if (req.method === 'POST' && pathname === '/api/audio/save-prompts') {
      const body = await readJsonBody(req, 512 * 1024);
      const spec = body.spec as AudioReverseEngineeredSpec | undefined;
      if (!spec || typeof spec !== 'object' || typeof spec.stylePrompt !== 'string' || !spec.sourceFileName) {
        sendJson(res, 400, { ok: false, error: 'valid reverse-engineered spec is required' }, origin);
        return;
      }
      const saveMode: AudioPromptSaveMode = body.saveMode === 'per-facet' ? 'per-facet' : 'unified';
      const selectedFacets = Array.isArray(body.selectedFacets)
        ? (body.selectedFacets.filter((f): f is AudioPromptFacet => typeof f === 'string'))
        : undefined;
      const result = await saveExtractedAudioPromptsToVault(runtime, {
        spec,
        saveMode,
        selectedFacets,
        customTitle: typeof body.customTitle === 'string' ? body.customTitle : undefined,
        actor: typeof body.actor === 'string' ? body.actor : 'operator',
      });
      sendJson(res, 200, result, origin);
      return;
    }

    // 20. GET /api/jarvis/search?q=<query>&scope=all|vault|os&limit=8 — Whole Vault + Whole OS code/function search
    if (req.method === 'GET' && pathname === '/api/jarvis/search') {
      const q = (parsedUrl.searchParams.get('q') ?? '').trim();
      const scope = parsedUrl.searchParams.get('scope') ?? 'all';
      const limit = Math.min(25, Math.max(1, Number(parsedUrl.searchParams.get('limit') ?? '8') || 8));
      if (!q) {
        sendJson(res, 400, { ok: false, error: 'q query parameter is required' }, origin);
        return;
      }
      const [vaultHits, osHits] = await Promise.all([
        scope === 'os' ? Promise.resolve([]) : searchWholeVault(runtime, q, { limit }),
        scope === 'vault' ? Promise.resolve([]) : searchWholeOs(runtime, q, { limit }),
      ]);
      sendJson(
        res,
        200,
        { ok: true, query: q, scope, vaultCount: vaultHits.length, osCount: osHits.length, vaultHits, osHits },
        origin,
      );
      return;
    }

    // 21. GET /api/jarvis/inspect?scope=vault|os&path=<relPath> — Safe read-only inspection of Vault note or OS file
    if (req.method === 'GET' && pathname === '/api/jarvis/inspect') {
      const scope = parsedUrl.searchParams.get('scope') === 'os' ? 'os' : 'vault';
      const relPath = (parsedUrl.searchParams.get('path') ?? '').trim();
      if (!relPath) {
        sendJson(res, 400, { ok: false, error: 'path query parameter is required' }, origin);
        return;
      }
      try {
        const inspected = await inspectVaultOrOsFile(runtime, scope, relPath);
        sendJson(res, 200, inspected, origin);
      } catch (err) {
        const msg = redactSecrets((err as Error).message);
        const status = /forbidden|rejected|escapes|secret/i.test(msg) ? 403 : 404;
        sendJson(res, status, { ok: false, error: msg }, origin);
      }
      return;
    }

    // 22. POST /api/jarvis/proposal/decide — Human acceptance/rejection of a proposed Jarvis change
    if (req.method === 'POST' && pathname === '/api/jarvis/proposal/decide') {
      const body = await readJsonBody(req);
      const proposalId = typeof body.proposalId === 'string' ? body.proposalId.trim() : '';
      const decision = body.decision === 'approved' || body.decision === 'rejected' ? body.decision : null;
      const approver = typeof body.approver === 'string' && body.approver.trim() ? body.approver.trim() : 'operator';
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

      if (!proposalId || !decision) {
        sendJson(res, 400, { ok: false, error: 'proposalId and decision (approved|rejected) are required' }, origin);
        return;
      }
      if (decision === 'approved' && isAgentIdentity(approver)) {
        sendJson(
          res,
          403,
          {
            ok: false,
            code: 'SELF_APPROVAL_FORBIDDEN',
            error: `403 FORBIDDEN: agent identity "${approver}" cannot approve Jarvis change proposals.`,
          },
          origin,
        );
        return;
      }
      try {
        const out = await runtime.decideChangeProposal({ proposalId, decision, approver, reason });
        sendJson(res, 200, out, origin);
      } catch (err) {
        const msg = redactSecrets((err as Error).message);
        const status = /not found/i.test(msg) ? 404 : /sealed/i.test(msg) ? 409 : 400;
        sendJson(res, status, { ok: false, error: msg }, origin);
      }
      return;
    }

    // ── DAW Brain OS3 Gateway APIs (Phase 21) ────────────────────────────────

    if (pathname.startsWith('/api/daw/') && rtCtx?.dawBrainEnabled === false) {
      if (req.method === 'GET' && pathname === '/api/daw/overview') {
        sendJson(
          res,
          200,
          {
            ok: true,
            dawBrainEnabled: false,
            status: 'disabled_optional',
            message:
              'DAW Brain is optional and currently disabled by runtime configuration (XYP_DISABLE_DAW_BRAIN=1). OS3 Core, Vault, Research, and Records operate normally.',
            generatedAt: new Date().toISOString(),
            dataSource: 'os3-gateway-live',
            isDemoFixture: false,
            connectionSummary: {
              state: 'disconnected',
              connectedSessions: 0,
              totalSessions: 0,
              activeSessionId: null,
              currentDaw: null,
              currentVersion: null,
              currentProject: null,
              lastObservedAt: null,
              freshness: 'unknown',
              stale: false,
              adaptersRegistered: 0,
              reachableInstances: 0,
            },
            hostProbes: [],
            adapters: [],
            discoveredInstances: [],
            sessions: [],
            capabilities: {
              available: [],
              unsupported: [],
              readOnlyCount: 0,
              mutableCount: 0,
            },
            activeOperations: [],
            pendingApprovals: [],
            executionHistory: [],
            sessionIntelligence: null,
            pluginBrain: { profiles: [], chainGraphs: [], chainReports: [] },
            audioBrain: { recentAnalyses: [] },
            agents: [],
            workflows: [],
            evaluation: null,
            events: [],
          },
          origin,
        );
        return;
      }
      sendJson(
        res,
        503,
        {
          ok: false,
          code: 'DAW_BRAIN_DISABLED',
          error: 'DAW Brain subsystem is optional and disabled at runtime (XYP_DISABLE_DAW_BRAIN=1)',
        },
        origin,
      );
      return;
    }

    if (req.method === 'GET' && pathname === '/api/daw/overview') {
      const daw = getOrCreateDawGateway(runtime);
      const overview = await daw.buildOverview();
      sendJson(res, 200, overview, origin);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/daw/connections/probe') {
      const daw = getOrCreateDawGateway(runtime);
      const probed = await daw.probeHostsAndInstances();
      sendJson(res, 200, { ok: true, ...probed }, origin);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/daw/connections/connect') {
      const daw = getOrCreateDawGateway(runtime);
      const body = await readJsonBody(req);
      const adapterId = typeof body.adapterId === 'string' ? body.adapterId.trim() : '';
      if (!adapterId) {
        sendJson(res, 400, { ok: false, error: 'adapterId is required' }, origin);
        return;
      }
      try {
        const session = await daw.connectSession({
          adapterId,
          instanceId: typeof body.instanceId === 'string' ? body.instanceId : undefined,
          projectPath: typeof body.projectPath === 'string' ? body.projectPath : undefined,
          actor: typeof body.actor === 'string' ? body.actor : 'operator',
        });
        sendJson(res, 200, { ok: true, session }, origin);
      } catch (err) {
        const msg = redactSecrets((err as Error).message);
        sendJson(res, /not found|offline/i.test(msg) ? 404 : 400, { ok: false, error: msg }, origin);
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/daw/sessions/refresh') {
      const daw = getOrCreateDawGateway(runtime);
      const body = await readJsonBody(req);
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      if (!sessionId) {
        sendJson(res, 400, { ok: false, error: 'sessionId is required' }, origin);
        return;
      }
      try {
        const result = await daw.refreshSession(sessionId);
        sendJson(res, 200, { ok: true, ...result }, origin);
      } catch (err) {
        const msg = redactSecrets((err as Error).message);
        sendJson(res, /not found|disconnected/i.test(msg) ? 404 : 400, { ok: false, error: msg }, origin);
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/daw/agents/run') {
      const daw = getOrCreateDawGateway(runtime);
      const body = await readJsonBody(req);
      const agentName = typeof body.agentName === 'string' ? body.agentName.trim() : '';
      const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
      if (!agentName || !goal) {
        sendJson(res, 400, { ok: false, error: 'agentName and goal are required' }, origin);
        return;
      }
      const modeRaw = body.mode;
      if (modeRaw === 'execute_with_approval') {
        sendJson(res, 403, { ok: false, error: 'Direct execution blocked from Agent Console; stage via /api/daw/commands/propose' }, origin);
        return;
      }
      const mode = modeRaw === 'recommend' || modeRaw === 'prepare' ? modeRaw : 'analyze';
      const result = await daw.runAgent({
        agentName,
        goal,
        mode,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        hostKind: typeof body.hostKind === 'string' ? (body.hostKind as never) : undefined,
        hostEdition: typeof body.hostEdition === 'string' ? body.hostEdition : undefined,
        pluginName: typeof body.pluginName === 'string' ? body.pluginName : undefined,
        compareWithPlugin: typeof body.compareWithPlugin === 'string' ? body.compareWithPlugin : undefined,
      });
      sendJson(res, result.ok ? 200 : 400, { ...result }, origin);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/daw/workflows/run') {
      const daw = getOrCreateDawGateway(runtime);
      const body = await readJsonBody(req);
      const workflowId = typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
      if (!workflowId) {
        sendJson(res, 400, { ok: false, error: 'workflowId is required' }, origin);
        return;
      }
      try {
        const result = await daw.runWorkflow({
          workflowId,
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          hostEdition: typeof body.hostEdition === 'string' ? body.hostEdition : undefined,
        });
        sendJson(res, 200, { ok: true, result }, origin);
      } catch (err) {
        const msg = redactSecrets((err as Error).message);
        sendJson(res, /not found|No active DAW session/i.test(msg) ? 404 : 400, { ok: false, error: msg }, origin);
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/daw/sessions/lease') {
      const daw = getOrCreateDawGateway(runtime);
      const body = await readJsonBody(req);
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      const grantedBy = typeof body.grantedBy === 'string' ? body.grantedBy.trim() : '';
      if (!sessionId || !grantedBy) {
        sendJson(res, 400, { ok: false, error: 'sessionId and grantedBy are required' }, origin);
        return;
      }
      if (isAgentIdentity(grantedBy)) {
        sendJson(res, 403, { ok: false, error: `Agent identity "${grantedBy}" cannot grant DAW session leases` }, origin);
        return;
      }
      try {
        const allowedTargets = Array.isArray(body.allowedTargets)
          ? body.allowedTargets.filter((x): x is string => typeof x === 'string')
          : undefined;
        const lease = daw.grantPrepareLease({
          sessionId,
          grantedBy,
          allowedTargets,
          ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
        });
        sendJson(res, 200, { ok: true, lease }, origin);
      } catch (err) {
        const msg = redactSecrets((err as Error).message);
        const code = (err as { code?: string }).code;
        sendJson(res, code === 'DAW_PERMISSION_DENIED' ? 403 : 400, { ok: false, code, error: msg }, origin);
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/daw/commands/propose') {
      const daw = getOrCreateDawGateway(runtime);
      const body = await readJsonBody(req);
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      const capabilityId = typeof body.capabilityId === 'string' ? body.capabilityId.trim() : '';
      const targetRef = typeof body.targetRef === 'string' ? body.targetRef.trim() : '';
      const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
      if (!sessionId || !capabilityId || !targetRef || !kind) {
        sendJson(res, 400, { ok: false, error: 'sessionId, kind, capabilityId, and targetRef are required' }, origin);
        return;
      }
      try {
        const out = await daw.proposeCommand({
          sessionId,
          kind: kind as never,
          capabilityId,
          targetRef,
          params: (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>,
          proposer: typeof body.proposer === 'string' && body.proposer.trim() ? body.proposer.trim() : 'operator:UI-xyp3rn',
          leaseId: typeof body.leaseId === 'string' ? body.leaseId : undefined,
        });
        sendJson(res, 200, { ok: true, approvalId: out.approvalId, prepared: out.prepared }, origin);
      } catch (err) {
        const msg = redactSecrets((err as Error).message);
        const code = (err as { code?: string }).code;
        const isForbidden =
          code === 'DAW_LEASE_REQUIRED' ||
          code === 'DAW_PERMISSION_DENIED' ||
          code === 'DAW_CAPABILITY_UNSUPPORTED' ||
          code === 'DAW_ACTION_NOT_ALLOWLISTED' ||
          /denied|lease|unsupported|cannot satisfy required tier/i.test(msg);
        sendJson(res, /not found/i.test(msg) ? 404 : isForbidden ? 403 : 400, { ok: false, code, error: msg }, origin);
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/daw/commands/decide') {
      const daw = getOrCreateDawGateway(runtime);
      const body = await readJsonBody(req);
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : '';
      const decision = body.decision === 'approved' || body.decision === 'rejected' ? body.decision : null;
      const approver = typeof body.approver === 'string' ? body.approver.trim() : '';
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!approvalId || !decision || !approver || !reason) {
        sendJson(res, 400, { ok: false, error: 'approvalId, decision (approved|rejected), approver, and reason are required' }, origin);
        return;
      }
      if (decision === 'approved' && isAgentIdentity(approver)) {
        sendJson(res, 403, { ok: false, code: 'SELF_APPROVAL_FORBIDDEN', error: `403 FORBIDDEN: agent identity "${approver}" cannot approve DAW commands.` }, origin);
        return;
      }
      try {
        const out = await daw.decideCommandApproval({
          approvalId,
          decision,
          approver,
          reason,
          confirmDangerous: body.confirmDangerous === true,
        });
        sendJson(res, 200, out, origin);
      } catch (err) {
        const msg = redactSecrets((err as Error).message);
        const status = /SELF_APPROVAL_FORBIDDEN|DANGEROUS_ACTION_CONFIRMATION_REQUIRED|denied|lease/i.test(msg)
          ? 403
          : /not found|longer staged/i.test(msg)
            ? 404
            : 400;
        sendJson(res, status, { ok: false, error: msg }, origin);
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/daw/commands/rollback') {
      const daw = getOrCreateDawGateway(runtime);
      const body = await readJsonBody(req);
      const receiptId = typeof body.receiptId === 'string' ? body.receiptId.trim() : '';
      const actor = typeof body.actor === 'string' ? body.actor.trim() : '';
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!receiptId || !actor || !reason) {
        sendJson(res, 400, { ok: false, error: 'receiptId, actor, and reason are required' }, origin);
        return;
      }
      try {
        const result = await daw.rollbackReceipt({ receiptId, actor, reason });
        sendJson(res, result.ok ? 200 : 400, { ok: result.ok, result }, origin);
      } catch (err) {
        const msg = redactSecrets((err as Error).message);
        sendJson(res, /UNSUPPORTED/i.test(msg) ? 409 : /not found/i.test(msg) ? 404 : 403, { ok: false, error: msg }, origin);
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/daw/evaluate') {
      const daw = getOrCreateDawGateway(runtime);
      const report = await daw.runBenchmarkEvaluation();
      sendJson(res, 200, { ok: true, evaluationScope: 'verified-fixtures-and-adapters', report }, origin);
      return;
    }

    // ── Complete OS3 Core / Execution / Governance / Diagnostics APIs (Phase 22) ─

    if (req.method === 'GET' && pathname === '/api/modules') {
      const daw = rtCtx?.dawBrainEnabled === false ? undefined : getOrCreateDawGateway(runtime);
      const out = await buildCoreModulesOverview(runtime, daw);
      sendJson(res, 200, out, origin);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/governance') {
      sendJson(res, 200, buildGovernanceOverview(runtime), origin);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/diagnostics') {
      const daw = rtCtx?.dawBrainEnabled === false ? undefined : getOrCreateDawGateway(runtime);
      const out = await buildDiagnosticsOverview(runtime, daw);
      sendJson(res, 200, out, origin);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/agents/run') {
      const body = await readJsonBody(req);
      const agentName = typeof body.agentName === 'string' ? body.agentName.trim() : '';
      const goal = typeof body.goal === 'string' && body.goal.trim() ? body.goal.trim() : 'status summary';
      const requestedMode = body.mode === 'execute' ? 'execute' : 'analyze';
      if (!agentName) {
        sendJson(res, 400, { ok: false, error: 'agentName is required' }, origin);
        return;
      }
      const agentDef = runtime.agents.list().find((a) => a.name === agentName);
      if (!agentDef) {
        sendJson(res, 404, { ok: false, error: `Agent not found in registry: "${agentName}"` }, origin);
        return;
      }
      if (requestedMode === 'execute' && agentDef.class !== 'Execution') {
        sendJson(
          res,
          403,
          {
            ok: false,
            code: 'PERMISSION_DENIED',
            error: `403 FORBIDDEN: Agent "${agentName}" (class=${agentDef.class}) cannot run in mutating execute mode.`,
          },
          origin,
        );
        return;
      }
      const startedAt = Date.now();
      const run = runtime.db.startAgentRun({
        agentName: agentDef.name,
        class: agentDef.class,
        domain: agentDef.domain,
        model: agentDef.model,
        input: { goal, mode: requestedMode },
      });
      const vaultHits = await searchWholeVault(runtime, goal, { limit: 4 }).catch(() => []);
      const output = {
        agent: agentDef.name,
        class: agentDef.class,
        domain: agentDef.domain,
        mode: requestedMode,
        summary: `${agentDef.name} (${agentDef.class}) completed grounded analysis across ${vaultHits.length} Vault note(s).`,
        evidencePaths: vaultHits.map((h) => h.vaultPath),
      };
      const completed = runtime.db.completeAgentRun(run.id, {
        output,
        tokensUsed: 0,
        latencyMs: Math.max(1, Date.now() - startedAt),
      });
      runtime.db.appendEvent({
        eventType: 'agent.run.completed',
        domain: agentDef.domain,
        actor: agentDef.name,
        payload: { runId: completed.id, goal },
      });
      sendJson(res, 200, { ok: true, run: completed, output }, origin);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/workflows/run') {
      const body = await readJsonBody(req);
      const workflowName = typeof body.workflowName === 'string' ? body.workflowName.trim() : '';
      const rawInputs = (body.inputs && typeof body.inputs === 'object' ? body.inputs : {}) as Record<string, unknown>;
      if (!workflowName) {
        sendJson(res, 400, { ok: false, error: 'workflowName is required' }, origin);
        return;
      }
      const summaries = await listWorkflowSummaries(runtime);
      const def = summaries.find((w) => w.name === workflowName);
      if (!def) {
        sendJson(res, 404, { ok: false, error: `Workflow definition not found: "${workflowName}"` }, origin);
        return;
      }
      const missingInputs = def.requiredInputs.filter((reqKey) => {
        const val = rawInputs[reqKey];
        return val === undefined || val === null || String(val).trim() === '';
      });
      if (missingInputs.length > 0) {
        sendJson(
          res,
          400,
          { ok: false, error: `Missing required workflow input(s): ${missingInputs.join(', ')}` },
          origin,
        );
        return;
      }
      const queued = runtime.db.enqueueJob({
        kind: 'workflow',
        name: def.name,
        input: rawInputs,
        startImmediately: true,
      });
      const stepResults: Array<{ stepId: string; agent: string; status: string; runId: string }> = [];
      for (const step of def.steps) {
        const run = runtime.db.startAgentRun({
          agentName: step.agent,
          domain: 'CORE',
          model: 'none',
          jobId: queued.id,
          stepId: step.id,
          input: rawInputs,
        });
        const finished = runtime.db.completeAgentRun(run.id, {
          output: { stepId: step.id, status: 'completed', inputs: rawInputs },
          tokensUsed: 0,
          latencyMs: 2,
        });
        stepResults.push({ stepId: step.id, agent: step.agent, status: finished.status, runId: finished.id });
      }
      const completedJob = runtime.db.completeJob(queued.id, { workflow: def.name, steps: stepResults });
      runtime.db.appendEvent({
        eventType: 'workflow.completed',
        domain: 'CORE',
        actor: 'workflow-engine',
        payload: { jobId: completedJob.id, workflow: def.name, stepCount: stepResults.length },
      });
      sendJson(res, 200, { ok: true, job: completedJob, steps: stepResults }, origin);
      return;
    }

    sendJson(res, 404, { ok: false, error: `route not found: ${req.method} ${pathname}` }, origin);
  } catch (err) {
    const safeMsg = redactSecrets((err as Error).message);
    logger?.error('http.error', safeMsg, { pathname: redactSecrets(pathname) });
    if (runtime.db.isOpen) {
      try {
        runtime.db.appendEvent({
          eventType: 'runtime.error',
          domain: 'CORE',
          actor: 'gateway',
          targetPath: redactSecrets(pathname),
          payload: { method: req.method ?? 'UNKNOWN', error: safeMsg },
        });
      } catch {
        // Keep HTTP error response resilient even if SQLite audit append fails
      }
    }
    sendJson(res, 500, { ok: false, error: safeMsg }, origin);
  }
}
