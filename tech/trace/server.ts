import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type postgres from 'postgres';
import { quoteIdent } from '../../core/db/client.ts';
import type { DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { loadWorkflow, runWorkflow } from '../../core/workflow-engine/engine.ts';
import { TRACE_ANALYSIS_SCHEMA_ID, validateTraceAnalysis, type TraceAnalysis } from './analysis.ts';
import { buildTraceReport, TRACE_REPORT_SCHEMA_ID, type TraceCheck, type TraceReport } from './report.ts';

/**
 * The TRACE service (Phase 14): the OS side of the TRACE boundary contract, over local HTTP.
 * TRACE (a separate VST3/AU codebase) POSTs a trace.analysis/v1; the service validates it with the
 * contract's own validator, runs tech/workflows/trace-intake.workflow.yaml (record → X3LIUS
 * Mix/Master against the canonical rubric → link), and answers with trace.report/v1.
 *
 * Local by default (127.0.0.1) and never without a bearer token: exposing it further is a
 * deployment decision, not this module's.
 */

export const TRACE_INTAKE_WORKFLOW = join(import.meta.dirname, '..', 'workflows', 'trace-intake.workflow.yaml');
export const DEFAULT_TRACE_PORT = 8787;
const MIN_TOKEN = 16;
const DEFAULT_LIMIT_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type TraceServer = { readonly server: Server; readonly url: string; readonly close: () => Promise<void> };
export type TraceServerOptions = {
  readonly deps: DispatchDeps;
  readonly token: string;
  readonly host?: string;
  readonly port?: number;
  readonly limitBytes?: number;
  readonly log?: (line: string) => void;
};

type HttpError = Error & { readonly httpStatus: number; readonly httpBody: Record<string, unknown> };
/** An error that carries its own HTTP answer; anything else is a 500. */
const httpError = (status: number, body: Record<string, unknown>): HttpError =>
  Object.assign(new Error(String(body.error)), { httpStatus: status, httpBody: body });
const isHttpError = (e: unknown): e is HttpError => e instanceof Error && 'httpStatus' in e;

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

/** Constant-time over equal-length digests, so neither the token nor its length leaks by timing. */
const sameToken = (given: string, expected: string): boolean =>
  timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());

const readJson = async (req: IncomingMessage, limit: number): Promise<unknown> => {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw httpError(415, { error: 'the body must be application/json' });
  }
  const tooLarge = () => httpError(413, { error: `the body is over ${limit} bytes` });
  if (Number(req.headers['content-length'] ?? 0) > limit) {
    req.resume();
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, { error: 'the body is not valid JSON' });
  }
};

const asRuntime = <T>(deps: DispatchDeps, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  deps.sql.begin('read only', async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent('xyp_runtime')}`);
    return fn(tx);
  }) as Promise<T>;

type CheckOutput = { artifact: { id: string }; body: { checks: TraceCheck[]; unset: string[] }; knowledge: { rubricClaims: number } };

const postAnalysis = async (o: TraceServerOptions, req: IncomingMessage, url: URL): Promise<TraceReport> => {
  const takeId = url.searchParams.get('takeId');
  if (takeId !== null && !UUID.test(takeId)) throw httpError(400, { error: 'takeId must be a uuid' });
  const analysis = await readJson(req, o.limitBytes ?? DEFAULT_LIMIT_BYTES);
  const violations = validateTraceAnalysis(analysis);
  if (violations.length > 0) throw httpError(400, { error: `not a valid ${TRACE_ANALYSIS_SCHEMA_ID}`, violations });

  const wf = loadWorkflow(TRACE_INTAKE_WORKFLOW, o.deps.registry);
  const run = await runWorkflow(o.deps, wf, { analysis, takeId }, { log: o.log ?? (() => {}) });
  if (run.status === 'error') {
    const recorded = run.steps.find((s) => s.stepId === 'record' && s.status === 'success');
    const [row] = recorded
      ? await asRuntime(o.deps, (tx) => tx<{ id: string }[]>`select id from trace_analyses where agent_run_id = ${recorded.agentRunId}`)
      : [];
    throw httpError(422, { error: run.error ?? 'the intake failed', failedStep: run.failedStep, workflowRunId: run.workflowRunId, ...(row ? { analysisId: row.id } : {}) });
  }
  const out = run.output as { record: { analysisId: string }; check: CheckOutput };
  return buildTraceReport({
    analysisId: out.record.analysisId, analysis: analysis as TraceAnalysis, checks: out.check.body.checks, unset: out.check.body.unset,
    rubricClaims: out.check.knowledge.rubricClaims, mixReportArtifactId: out.check.artifact.id,
  });
};

const getReport = async (o: TraceServerOptions, id: string): Promise<TraceReport> => {
  if (!UUID.test(id)) throw httpError(404, { error: `no analysis ${id}` });
  const [row] = await asRuntime(o.deps, (tx) => tx<{ body: TraceAnalysis; artifact_id: string | null; report: CheckOutput['body'] | null; knowledge: { rubricClaims: number } | null }[]>`
    select t.body, t.mix_report_artifact_id as artifact_id, a.body as report, a.knowledge
    from trace_analyses t left join creative_artifacts a on a.id = t.mix_report_artifact_id where t.id = ${id}`);
  if (!row) throw httpError(404, { error: `no analysis ${id}` });
  if (!row.artifact_id || !row.report || !row.knowledge) throw httpError(404, { error: `analysis ${id} has no linked report (its intake failed at the check)` });
  return buildTraceReport({
    analysisId: id, analysis: row.body, checks: row.report.checks, unset: row.report.unset,
    rubricClaims: row.knowledge.rubricClaims, mixReportArtifactId: row.artifact_id,
  });
};

/**
 * Starts the TRACE service.
 * @param o - dispatch deps (registry, runtime tools, handlers), the bearer token, host (default
 *   127.0.0.1), port (default 8787; 0 = any free port), body limit, and a log line sink
 * @returns the listening server, its base URL, and close()
 * @throws Error when the token is missing or shorter than 16 characters
 */
export const startTraceServer = async (o: TraceServerOptions): Promise<TraceServer> => {
  if (!o.token) throw new Error('the TRACE service needs a bearer token: set XYP_TRACE_TOKEN');
  if (o.token.length < MIN_TOKEN) throw new Error(`XYP_TRACE_TOKEN must be at least ${MIN_TOKEN} characters`);
  const host = o.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://trace.local');
    const handle = async (): Promise<[number, unknown]> => {
      if (req.method === 'GET' && url.pathname === '/v1/trace/health') {
        return [200, { status: 'ok', contracts: [TRACE_ANALYSIS_SCHEMA_ID, TRACE_REPORT_SCHEMA_ID] }];
      }
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
      if (!auth || !sameToken(auth[1]!, o.token)) {
        req.resume();
        return [401, { error: 'a valid bearer token is required' }];
      }
      if (req.method === 'POST' && url.pathname === '/v1/trace/analyses') return [201, await postAnalysis(o, req, url)];
      const byId = /^\/v1\/trace\/analyses\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && byId) return [200, await getReport(o, byId[1]!)];
      req.resume();
      return [404, { error: `no route ${req.method} ${url.pathname}` }];
    };
    handle()
      .then(([status, body]) => send(res, status, body))
      .catch((e: unknown) => {
        if (isHttpError(e)) return send(res, e.httpStatus, e.httpBody);
        o.log?.(`[trace] 500 ${req.method} ${url.pathname}: ${(e as Error).message}`);
        return send(res, 500, { error: 'internal error' });
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? DEFAULT_TRACE_PORT, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://${host}:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
