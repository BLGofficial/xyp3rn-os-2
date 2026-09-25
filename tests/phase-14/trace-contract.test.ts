import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMetric } from '../../records/x3lius/mix-master/agent.ts';
import { MIX_REPORT_SCHEMA } from '../../records/x3lius/creative/schemas.ts';
import { TRACE_ANALYSIS_SCHEMA, traceMetrics } from '../../tech/trace/analysis.ts';
import { TRACE_CHECK_SCHEMA, TRACE_REPORT_SCHEMA_ID, validateTraceReport, type TraceReport } from '../../tech/trace/report.ts';
import { renderTraceSchemas, TRACE_SCHEMA_DIR } from '../../tech/trace/schemas.ts';
import { REPO_ROOT } from '../helpers/db.ts';
import { ANALYSIS } from '../helpers/trace-fixture.ts';

// Phase 14 proof (part 2): the TRACE boundary contract is defined once (tech/trace), versioned,
// and exported for the plugin as JSON Schema files that can't drift from the TypeScript source.

const REF = 'canonical_prompts:11111111-1111-4111-8111-111111111111#x3lius.mix.loudness.integrated-lufs';
const check = checkMetric(traceMetrics(ANALYSIS)[0]!, { bound: { min: -10, max: -8 }, claim: { version: 2 } as never, ref: REF });
const report = (over: Partial<TraceReport> = {}): TraceReport => ({
  schema: TRACE_REPORT_SCHEMA_ID,
  analysisId: '22222222-2222-4222-8222-222222222222',
  subject: { stage: 'mix', label: ANALYSIS.subject.label },
  checks: [check],
  unset: ['stereo.width-pct'],
  rubricClaims: 1,
  mixReportArtifactId: '33333333-3333-4333-8333-333333333333',
  ...over,
});

describe('trace.report/v1: what the OS answers TRACE with', () => {
  it('is versioned and validates a report built from Mix/Master\'s own check', () => {
    expect(TRACE_REPORT_SCHEMA_ID).toBe('trace.report/v1');
    expect(validateTraceReport(report())).toEqual([]);
  });

  it('names every violation: wrong schema, a bad action, a check without its rule ref, a non-uuid id', () => {
    const bad = report({ schema: 'trace.report/v2' as never, analysisId: 'nope', checks: [{ ...check, action: 'boost' as never, ref: '' }] });
    const errors = validateTraceReport(bad);
    expect(errors.join('\n')).toMatch(/\$\.schema/);
    expect(errors.join('\n')).toMatch(/\$\.analysisId/);
    expect(errors.join('\n')).toMatch(/\$\.checks\[0\]\.action/);
    expect(errors.join('\n')).toMatch(/\$\.checks\[0\]\.ref/);
  });
});

describe('defined once (the guide\'s constraint: "if you find yourself defining it twice, that\'s the bug")', () => {
  it('the mix report artifact\'s checks ARE the TRACE check schema, not a copy', () => {
    const checks = (MIX_REPORT_SCHEMA as { properties: Record<string, { items: unknown }> }).properties.checks!.items;
    expect(checks).toBe(TRACE_CHECK_SCHEMA);
    expect((MIX_REPORT_SCHEMA as { properties: Record<string, unknown> }).properties.analysis).toBe(TRACE_ANALYSIS_SCHEMA);
  });

  it('no source file outside tech/trace declares a TRACE contract id or a check shape', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
    });
    const files = ['core', 'records', 'tech', 'knowledge', 'research-intelligence'].flatMap((d) => walk(join(REPO_ROOT, d)))
      .filter((p) => !relative(REPO_ROOT, p).startsWith('tech/trace/'));
    const offenders = files.flatMap((p) => {
      const src = readFileSync(p, 'utf8');
      return [
        /['"`]trace\.(analysis|report)\/v\d+['"`]/.test(src) ? [`${relative(REPO_ROOT, p)}: declares a TRACE contract id`] : [],
        /'keep' \| 'raise' \| 'lower'|\['keep', 'raise', 'lower'\]/.test(src) ? [`${relative(REPO_ROOT, p)}: declares a check action set`] : [],
      ].flat();
    });
    expect(offenders).toEqual([]);
  });
});

describe('JSON Schema files for the plugin (generated, never hand-edited)', () => {
  it('every generated file matches the file on disk byte for byte (run pnpm trace:schemas after a contract change)', () => {
    const rendered = renderTraceSchemas();
    expect(Object.keys(rendered).sort()).toEqual(['trace.analysis.v1.schema.json', 'trace.report.v1.schema.json']);
    for (const [name, text] of Object.entries(rendered)) {
      expect(readFileSync(join(TRACE_SCHEMA_DIR, name), 'utf8'), name).toBe(text);
    }
  });

  it('each file is a draft 2020-12 schema with an $id per contract version and the contract\'s required keys', () => {
    const a = JSON.parse(renderTraceSchemas()['trace.analysis.v1.schema.json']!) as Record<string, unknown>;
    expect(a).toMatchObject({ $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'trace.analysis/v1', type: 'object', additionalProperties: false });
    expect(String(a.$id)).toMatch(/trace\.analysis\.v1\.schema\.json$/);
    expect(a.required).toEqual(['schema', 'producer', 'subject', 'audio', 'loudness', 'tonalBalanceDb', 'stereo', 'dynamics']);
    const r = JSON.parse(renderTraceSchemas()['trace.report.v1.schema.json']!) as Record<string, unknown>;
    expect(r).toMatchObject({ title: 'trace.report/v1', type: 'object' });
  });
});
