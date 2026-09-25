import { join } from 'node:path';
import type { JsonSchema } from '../../core/llm/json-schema.ts';
import { TRACE_ANALYSIS_SCHEMA, TRACE_ANALYSIS_SCHEMA_ID } from './analysis.ts';
import { TRACE_REPORT_SCHEMA, TRACE_REPORT_SCHEMA_ID } from './report.ts';

/**
 * The TRACE contract as JSON Schema files for the plugin (a separate C++ VST3/AU codebase), generated
 * from the TypeScript schemas that are the contract (Phase 14). Never hand-edited: `pnpm
 * trace:schemas` rewrites them, and tests/phase-14 fails when a file differs from what it would write.
 * The files carry shape; ranges the shape can't state are in each field's description and are
 * enforced by the service (validateTraceAnalysis).
 */

export const TRACE_SCHEMA_DIR = join(import.meta.dirname, 'schemas');
const ID_BASE = 'https://github.com/BLGofficial/xyp3rn-os-2/blob/main/tech/trace/schemas/';

/** `trace.analysis/v1` → `trace.analysis.v1.schema.json`. */
const fileName = (id: string): string => `${id.replace('/', '.')}.schema.json`;

const render = (id: string, description: string, schema: JsonSchema): string =>
  `${JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `${ID_BASE}${fileName(id)}`, title: id, description, ...schema }, null, 2)}\n`;

/**
 * @returns file name → file content, for every contract version TECH publishes
 */
export const renderTraceSchemas = (): Record<string, string> => ({
  [fileName(TRACE_ANALYSIS_SCHEMA_ID)]: render(TRACE_ANALYSIS_SCHEMA_ID,
    'One render of one track (mix bus or master) as TRACE measures it: loudness per ITU-R BS.1770 / EBU R128, tonal balance over seven fixed bands, stereo correlation and width, crest factor. POST it to /v1/trace/analyses.',
    TRACE_ANALYSIS_SCHEMA),
  [fileName(TRACE_REPORT_SCHEMA_ID)]: render(TRACE_REPORT_SCHEMA_ID,
    'What the OS answers a trace.analysis/v1 with: each metric the canonical mix/master rubric bounds, as keep/raise/lower by how much and the rubric claim that says so; every unbounded metric as unset.',
    TRACE_REPORT_SCHEMA),
});
