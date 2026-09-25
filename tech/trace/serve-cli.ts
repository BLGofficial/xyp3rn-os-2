import { connect } from '../../core/db/client.ts';
import { createRuntimeDeps } from '../../core/runtime/deps.ts';
import { DEFAULT_TRACE_PORT, startTraceServer } from './server.ts';

// Usage: XYP_TRACE_TOKEN=<≥16 chars> node tech/trace/serve-cli.ts   (pnpm trace:serve)
// Optional: XYP_TRACE_HOST (default 127.0.0.1), XYP_TRACE_PORT (default 8787). Ctrl-C stops it.

const sql = connect(undefined, { max: 4 });
try {
  const trace = await startTraceServer({
    deps: createRuntimeDeps(sql),
    token: process.env.XYP_TRACE_TOKEN ?? '',
    host: process.env.XYP_TRACE_HOST ?? '127.0.0.1',
    port: Number(process.env.XYP_TRACE_PORT ?? DEFAULT_TRACE_PORT),
    log: (line) => console.error(line),
  });
  console.log(`TRACE service on ${trace.url}: POST /v1/trace/analyses (trace.analysis/v1 → trace.report/v1), GET /v1/trace/analyses/:id, GET /v1/trace/health`);
  const stop = async () => {
    await trace.close();
    await sql.end();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (e) {
  console.error((e as Error).message);
  await sql.end();
  process.exit(2);
}
