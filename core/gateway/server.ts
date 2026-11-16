import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { redactSecrets, StructuredLogger } from '../runtime/logger.ts';
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
import { inspectVaultOrOsFile, searchWholeOs, searchWholeVault } from './jarvis-inspector.ts';
import {
  buildAgentsSnapshot,
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
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
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
  readonly close: () => Promise<void>;
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
  } = {},
): Promise<Os3GatewayServerHandle> => {
  const host = options.host ?? DEFAULT_GATEWAY_HOST;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`Security policy violation: OS 3.0 Gateway must bind to 127.0.0.1, refused "${host}"`);
  }
  const requestedPort = options.port ?? DEFAULT_GATEWAY_PORT;
  const logger = options.logger ?? new StructuredLogger({ service: 'xyp3rn-os3-gateway' });
  const authToken = options.authToken?.trim() || process.env.XYP_GATEWAY_TOKEN?.trim() || undefined;

  const server = createServer((req, res) => {
    logger.debug('http.request', `${req.method ?? 'GET'} ${req.url ?? '/'}`, {
      method: req.method,
      url: req.url,
      host: req.headers.host,
    });
    void handleRequest(runtime, req, res, logger, authToken);
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
  });

  return {
    server,
    host,
    port: actualPort,
    url,
    logger,
    close: () =>
      new Promise<void>((resolve, reject) => {
        logger.info('gateway.stopping', `Shutting down OS 3.0 Gateway on ${url}`);
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
      sendJson(
        res,
        200,
        {
          ok: true,
          service: 'xyp3rn-os3-gateway',
          vaultRoot: runtime.vault.vaultRoot,
          sqlitePath: runtime.db.dbPath,
          sqliteOpen,
          schemaVersion: integrity?.schemaVersion ?? null,
          integrityOk: integrity?.ok ?? false,
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

    sendJson(res, 404, { ok: false, error: `route not found: ${req.method} ${pathname}` }, origin);
  } catch (err) {
    const safeMsg = redactSecrets((err as Error).message);
    logger?.error('http.error', safeMsg, { pathname });
    sendJson(res, 500, { ok: false, error: safeMsg }, origin);
  }
}
