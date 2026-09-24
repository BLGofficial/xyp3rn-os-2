import type { LlmProgram } from '../../../core/llm/runner.ts';
import type { ArtifactRecord } from '../../../core/tool-registry/tools/read-artifact.ts';
import { withoutTrace } from '../creative/artifacts.ts';
import { scriptFindings, specForSchema } from '../creative/program.ts';
import { MIX_REPORT_SCHEMA_ID } from '../creative/schemas.ts';
import { applyEdits, rederive, type Edit } from './edits.ts';
import { REVISION_LLM_SCHEMA, REVISION_LLM_SCHEMA_ID } from './schemas.ts';
import type { CritiqueRow } from './tools.ts';

/**
 * Revision (Phase 12, class Revision): reads one critique, asks the model for concrete edits,
 * applies them in code (all or nothing), and appends the next version of the artifact naming the
 * critique it answers. It never overwrites a version and never marks a critique resolved: the
 * Critic judges the new version (spec §6).
 */
export const REVISION_AGENT = 'x3lius-revision';

export type RevisionOutput = {
  readonly status: 'revised';
  readonly artifact: { readonly id: string; readonly lineageId: string; readonly version: number; readonly schemaId: string };
  readonly critiqueId: string;
  readonly edits: readonly Edit[];
  readonly body: Record<string, unknown>;
};

const SYSTEM = [
  'You are the Revision agent of the X3LIUS Music System. A Critic found the violations listed under VIOLATIONS in the artifact under ARTIFACT. Propose concrete edits that fix them.',
  '',
  'HOW TO EDIT',
  '- Each edit replaces the value of one field: path is a JSON Pointer to it (e.g. /sections/1/bars/0/text), replacement is the new value.',
  '- Edit only a field a violation points at, or a field inside it. Leave everything else as it is.',
  '- Keep each field’s type: text stays text; for a number or true/false field write the value as JSON (120, true).',
  '- In violationKeys, list the key of every violation the edit fixes, copied exactly from VIOLATIONS.',
  '- Change only what the violation requires; keep the rest of the artifact’s wording and voice.',
  '- Write every word in a single alphabet: never mix Latin and Cyrillic letters inside one word.',
  '- Reply with JSON only, matching the response schema.',
].join('\n');

/**
 * @param ctx - run context (tools: read_critique, read_artifact, write_artifact, log_message)
 * @param input - `{ critiqueId }`
 * @returns `{ status: 'revised', artifact, critiqueId, edits, body }`
 * @throws Error on a bare request, a mix report (studio work), a critique with no violations, refused edits, or a revised body that fails its spec's checks
 */
export const revisionProgram: LlmProgram = async (ctx, input, llm) => {
  const critiqueId = (input as { critiqueId?: unknown } | null)?.critiqueId;
  if (typeof critiqueId !== 'string') throw new Error(`${REVISION_AGENT} revises from one critique: input { critiqueId }`);
  const c = (await ctx.useTool('read_critique', { id: critiqueId })) as CritiqueRow;
  const a = (await ctx.useTool('read_artifact', { id: c.artifactId })) as ArtifactRecord;
  if (a.schemaId === MIX_REPORT_SCHEMA_ID) throw new Error('a mix report measures a render: fixing it is studio work (change the session, render again), not a revision');
  const found = specForSchema(a.schemaId);
  if (!found) throw new Error(`no Creative spec writes ${a.schemaId}: nothing to validate a revision against`);
  const violations = c.body.violations;
  if (violations.length === 0) throw new Error(`critique ${c.id} lists no violation: nothing to revise`);

  const res = await llm.complete({
    system: SYSTEM,
    user: [
      `ARTIFACT ${a.schemaId} v${a.version}\n${JSON.stringify(withoutTrace(a.body))}`,
      `VIOLATIONS\n${JSON.stringify(violations.map(({ key, ruleRef, path, quote, expected, found: f }) => ({ key, ruleRef, path, quote, expected, found: f })))}`,
    ].join('\n\n'),
    schema: { name: REVISION_LLM_SCHEMA_ID, schema: REVISION_LLM_SCHEMA },
    signal: ctx.signal,
  });
  const edits = (res.json as { edits: Edit[] }).edits;
  const body = rederive(a.schemaId, applyEdits(a.schemaId, a.body, edits, violations));
  const script = scriptFindings(found.spec, body);
  const failed = [...(found.spec.check?.(body) ?? []), ...script.refuse];
  if (failed.length > 0) throw new Error(`${REVISION_AGENT}: the revised ${a.schemaId} failed checks: ${failed.join('; ')}`);
  if (script.softMessages.length > 0) await ctx.useTool('log_message', { level: 'warn', message: `${REVISION_AGENT}: written with warnings — ${script.softMessages.join('; ')}` });

  const written = (await ctx.useTool('write_artifact', {
    schemaId: a.schemaId, brief: a.brief, body, contextRefs: a.contextRefs, knowledge: a.knowledge, model: ctx.agent.model,
    parentId: a.id, critiqueId: c.id, warnings: script.warnings,
  })) as { artifact_id: string; lineage_id: string; version: number };
  await ctx.useTool('log_message', { message: `${REVISION_AGENT}: ${a.schemaId} v${a.version} → v${written.version}: ${edits.length} edit(s) for critique ${c.id}` });
  return {
    output: {
      status: 'revised',
      artifact: { id: written.artifact_id, lineageId: written.lineage_id, version: written.version, schemaId: a.schemaId },
      critiqueId: c.id, edits, body,
    } satisfies RevisionOutput,
    tokensUsed: res.usage.inputTokens + res.usage.outputTokens,
  };
};
