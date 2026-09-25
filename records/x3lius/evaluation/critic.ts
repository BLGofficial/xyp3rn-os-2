import type { LlmProgram } from '../../../core/llm/runner.ts';
import type { ArtifactRecord } from '../../../core/tool-registry/tools/read-artifact.ts';
import { withoutTrace } from '../creative/artifacts.ts';
import { promptLine, pullEntries, specForSchema } from '../creative/program.ts';
import { MIX_REPORT_SCHEMA_ID } from '../creative/schemas.ts';
import { isModelAgnostic, scopeOf, type ContextEntry } from '../creative/types.ts';
import { appliesTo } from '../suno/formula.ts';
import { codeChecks, mixReportChecks } from './checks.ts';
import {
  CRITIQUE_LLM_SCHEMA, CRITIQUE_LLM_SCHEMA_ID, type CheckedRule, type CritiqueBody, type CritiqueCounts, type Unverified, type Violation,
} from './schemas.ts';
import type { CritiqueRow } from './tools.ts';
import { verifyReported, type ReportedViolation } from './verify.ts';

/**
 * The Critic (Phase 12, class Critic): checks one creative artifact version against the canonical
 * rules in force for it and writes an x3lius.critique/v1. Specific violations, each tied to a rule
 * ref; it never edits the artifact (Revision's job). Code checks structured claims; the model
 * judges prose rules, and code verifies every violation it reports (spec §5).
 */
export const CRITIC_AGENT = 'x3lius-evaluation';

export type CriticOutput = {
  readonly status: 'critiqued';
  readonly critique: { readonly id: string; readonly artifactId: string; readonly schemaId: string; readonly version: number; readonly counts: CritiqueCounts };
  readonly body: CritiqueBody;
};

/** Entries that apply to this artifact: model-agnostic ones, and ones scoped to the Suno version its body targets. */
const applies = (e: ContextEntry, body: Record<string, unknown>): boolean =>
  isModelAgnostic(e) || (typeof body.sunoModel === 'string' && appliesTo(scopeOf(e), body.sunoModel));

const systemPrompt = (rules: readonly ContextEntry[]): string => [
  'You are the Critic of the X3LIUS Music System. You check one creative artifact against the canonical rules below and report only where it breaks them.',
  '',
  'RULES',
  'Each starts with its ref in brackets.',
  ...rules.map(promptLine),
  '',
  'HOW TO REPORT',
  '- Report a violation only when the artifact breaks one of the RULES. Do not report taste or preferences no rule states.',
  '- ruleRef: the rule broken, with its ref copied exactly as shown inside the brackets.',
  '- path: a JSON Pointer to the field that breaks it, e.g. /sections/1/bars/0/text.',
  '- quote: the offending words, copied exactly from that field. Code checks the quote; one it cannot find there is dropped.',
  '- expected: what the rule requires there. found: what the artifact has.',
  '- When the artifact breaks no rule, reply with an empty violations list.',
  '- Reply with JSON only, matching the response schema.',
].join('\n');

/**
 * @param ctx - run context (tools: retrieve_context, retrieve_claims, read_artifact, read_critique, write_critique, log_message)
 * @param input - `{ artifactId, previousCritiqueId? }`; previousCritiqueId must be the critique of the artifact's parent
 * @returns `{ status: 'critiqued', critique: { id, artifactId, schemaId, version, counts }, body }`
 * @throws Error on a bare request, a previous critique of another version, or a schema no current spec writes
 */
export const criticProgram: LlmProgram = async (ctx, input, llm) => {
  const i = (input ?? {}) as { artifactId?: unknown; previousCritiqueId?: unknown };
  if (typeof i.artifactId !== 'string') throw new Error(`${CRITIC_AGENT} critiques one artifact version: input { artifactId, previousCritiqueId? }`);
  const a = (await ctx.useTool('read_artifact', { id: i.artifactId })) as ArtifactRecord;
  let previous: CritiqueRow | null = null;
  if (i.previousCritiqueId !== undefined) {
    if (typeof i.previousCritiqueId !== 'string') throw new Error('previousCritiqueId must be a critique id');
    previous = (await ctx.useTool('read_critique', { id: i.previousCritiqueId })) as CritiqueRow;
    if (previous.artifactId !== a.parentId) throw new Error(`critique ${previous.id} reviewed ${previous.artifactId}, not the parent of ${a.id}`);
  }

  let rules: CheckedRule[];
  let violations: Violation[];
  let unverified: Unverified[] = [];
  let tokensUsed = 0;
  if (a.schemaId === MIX_REPORT_SCHEMA_ID) {
    // A report of measurements: its checks are the rules, all code (spec §5.1). No model call.
    const mix = mixReportChecks(a.body);
    rules = [...mix.rules];
    violations = [...mix.violations];
  } else {
    const found = specForSchema(a.schemaId);
    if (!found) throw new Error(`no Creative spec writes ${a.schemaId}: the Critic can't tell which rules govern it`);
    const { pulled } = await pullEntries(ctx, found.slug, a.brief);
    const byRef = new Map(pulled.map((p) => [p.entry.ref, p.entry]));
    const entries = [...byRef.values()].filter((e) => applies(e, a.body));
    const code = codeChecks(a.schemaId, entries, a.body);
    const codeRefs = new Set(code.rules.map((r) => r.ref));
    const modelRules = entries.filter((e) => !codeRefs.has(e.ref));
    let model: { violations: Violation[]; unverified: Unverified[] } = { violations: [], unverified: [] };
    if (modelRules.length > 0) {
      const res = await llm.complete({
        system: systemPrompt(modelRules),
        user: `ARTIFACT ${a.schemaId} v${a.version}\n${JSON.stringify(withoutTrace(a.body))}`,
        schema: { name: CRITIQUE_LLM_SCHEMA_ID, schema: CRITIQUE_LLM_SCHEMA },
        signal: ctx.signal,
      });
      tokensUsed = res.usage.inputTokens + res.usage.outputTokens;
      model = verifyReported((res.json as { violations: ReportedViolation[] }).violations, modelRules, codeRefs, a.body);
      for (const u of model.unverified) {
        await ctx.useTool('log_message', { level: 'warn', message: `${CRITIC_AGENT}: dropped an unverifiable violation of ${u.ruleRef} at ${u.path}: ${u.reason}` });
      }
    }
    rules = [...code.rules, ...modelRules.map((e) => ({ ref: e.ref, kind: e.kind, method: 'model' as const }))];
    violations = [...code.violations, ...model.violations];
    unverified = model.unverified;
  }

  const keys = new Set(violations.map((v) => v.key));
  const counts: CritiqueCounts = {
    checked: rules.length,
    passed: rules.filter((r) => !violations.some((v) => v.ruleRef === r.ref)).length,
    violations: violations.length,
  };
  const body: CritiqueBody = {
    artifact: { id: a.id, schemaId: a.schemaId, version: a.version, agent: a.agentName },
    ...(previous ? { previousCritiqueId: previous.id } : {}),
    rules,
    violations,
    resolved: previous ? previous.body.violations.map((v) => v.key).filter((k) => !keys.has(k)) : [],
    unverified,
    counts,
  };
  const written = (await ctx.useTool('write_critique', { artifactId: a.id, ...(previous ? { previousId: previous.id } : {}), body })) as { critique_id: string };
  await ctx.useTool('log_message', {
    message: `${CRITIC_AGENT}: ${a.schemaId} v${a.version}: ${counts.violations} violation(s); ${counts.passed}/${counts.checked} rules passed${body.resolved.length > 0 ? `; ${body.resolved.length} resolved` : ''}`,
  });
  return {
    output: { status: 'critiqued', critique: { id: written.critique_id, artifactId: a.id, schemaId: a.schemaId, version: a.version, counts }, body } satisfies CriticOutput,
    tokensUsed,
  };
};
