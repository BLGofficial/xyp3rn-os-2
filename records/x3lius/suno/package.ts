import type { AgentHandler } from '../../../core/orchestrator/dispatch.ts';
import type { ClaimBundle } from '../../../core/context-engine/context-engine.ts';
import { readArtifact, sourceOf } from '../creative/artifacts.ts';
import { LYRICS_SCHEMA_ID, META_TAG_SET_SCHEMA_ID, STYLE_RECIPE_SCHEMA_ID, SUNO_PACKAGE_SCHEMA_ID } from '../creative/schemas.ts';
import { mixedScriptWords } from '../creative/script-check.ts';
import { renderWithTags, type SungSection, type TagSet } from '../studio/tags.ts';
import { appliesTo, LIMIT_TOPIC, measureSunoText } from './formula.ts';

export const PACKAGE_AGENT = 'x3lius-suno-package';
/** Builds a package and links it to its song, so every attempt has a workflow version (S4). */
export const BUILD_PACKAGE_WORKFLOW = 'records/workflows/build-suno-package.workflow.yaml';

const SUNO_MODEL = /^v\d+(\.\d+)?[a-z]*$/;

export type SunoLimit = { readonly field: string; readonly max: number; readonly actual: number; readonly ref: string };
type Claim = ClaimBundle['items'][number];

/**
 * The canonical length limits in force for one Suno model (F20: model-agnostic claims and the
 * model's own `suno-<v>` ones), checked against measured lengths. The same claims, topics and refs
 * as the Phase 9 formula and the Phase 12 Critic; only the claims decide, never a constant here.
 * @param claims - current canonical claims (`retrieve_claims` items)
 * @param measured - lengths by limit field (measureSunoText)
 * @param sunoModel - the target Suno model, e.g. v5
 * @returns every applicable limit, and a message per one exceeded
 */
export const sunoLimits = (claims: readonly Claim[], measured: Readonly<Record<string, number>>, sunoModel: string) => {
  const limits: SunoLimit[] = claims.flatMap((c) => {
    const m = LIMIT_TOPIC.exec(c.topic);
    if (!m || !Number.isInteger(c.value) || !(m[1]! in measured) || !appliesTo(c.modelScope, sunoModel)) return [];
    return [{ field: m[1]!, max: c.value as number, actual: measured[m[1]!]!, ref: `canonical_prompts:${c.ref.id}#${c.topic}` }];
  });
  return { limits, violations: limits.filter((l) => l.actual > l.max).map((l) => `${l.field} is ${l.actual} chars; canonical limit ${l.max} (${l.ref})`) };
};

const fail = (message: string): never => {
  throw new Error(`${PACKAGE_AGENT}: ${message}`);
};
const id = (input: Record<string, unknown>, key: string): string =>
  (typeof input[key] === 'string' ? (input[key] as string) : fail(`${key} must be an artifact id`));

/**
 * x3lius-suno-package (AOS-03, Creative, deterministic): the Suno prompt package (S3). From one lyric
 * version, one style recipe and one tag set it renders the lyrics with the tags, copies the recipe's
 * style and exclusions verbatim, checks the canonical limits and F22, and writes a
 * x3lius.suno-package/v1 naming each version. It builds from drafts too, as a preview: submitting
 * requires each version approved (S4, the DB gate). Run it through build-suno-package, which
 * links the package to its song; a package built outside a workflow can't be submitted.
 * @param ctx - run context; read_artifact and retrieve_claims read, write_artifact writes
 * @param input - `{ lyricsArtifactId, styleRecipeArtifactId, tagSetArtifactId, title, sunoModel }`
 * @returns the package written and what it measured
 */
export const sunoPackage: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as Record<string, unknown>;
  const sunoModel = typeof i.sunoModel === 'string' ? i.sunoModel.toLowerCase() : '';
  if (!SUNO_MODEL.test(sunoModel)) fail('sunoModel must be a Suno version, e.g. "v5" or "v4.5"');
  if (typeof i.title !== 'string' || i.title.trim() === '') fail('title must be a non-blank string');
  const title = i.title as string;

  const lyrics = await readArtifact(ctx, id(i, 'lyricsArtifactId'), [LYRICS_SCHEMA_ID]);
  const recipe = await readArtifact(ctx, id(i, 'styleRecipeArtifactId'), [STYLE_RECIPE_SCHEMA_ID]);
  const tags = await readArtifact(ctx, id(i, 'tagSetArtifactId'), [META_TAG_SET_SCHEMA_ID]);

  const suno = {
    title,
    style: recipe.body.style as string,
    excludeStyles: recipe.body.excludeStyles as string[],
    lyrics: (() => {
      try {
        return renderWithTags(lyrics.body.sections as SungSection[], tags.body as unknown as TagSet);
      } catch (e) {
        return fail((e as Error).message);
      }
    })(),
  };
  const mixed = mixedScriptWords(suno);
  if (mixed.length > 0) fail(`${mixed.map((w) => `mixed-script word "${w.word}" at ${w.path}`).join('; ')}: Suno receives this text; fix the version it came from`);

  const claims = (await ctx.useTool('retrieve_claims', { topicPrefix: 'suno.limit.' })) as ClaimBundle;
  const { limits, violations } = sunoLimits(claims.items, measureSunoText(suno), sunoModel);
  if (violations.length > 0) fail(`over a canonical Suno limit: ${violations.join('; ')}`);

  const sources = [sourceOf('lyrics', lyrics), sourceOf('style-recipe', recipe), sourceOf('meta-tag-set', tags)];
  const body = {
    sunoModel, ...suno, sources, limits,
    rulesApplied: limits.map((l) => ({ ref: l.ref, how: `${l.field} is ${l.actual} of at most ${l.max} characters` })),
    ungroundedChoices: [],
  };
  const r = (await ctx.useTool('write_artifact', {
    schemaId: SUNO_PACKAGE_SCHEMA_ID, brief: `Suno ${sunoModel} package "${title}"`, body,
    contextRefs: limits.map((l) => ({ kind: 'claim', ref: l.ref })), knowledge: { authored: 'code', from: sources.map((s) => s.artifactId) }, model: ctx.agent.model,
  })) as { artifact_id: string; lineage_id: string; version: number };
  ctx.log('info', `${PACKAGE_AGENT}: package ${r.artifact_id} from ${sources.map((s) => `${s.role} ${s.artifactId} v${s.version}`).join(', ')}`);
  return { output: { artifactId: r.artifact_id, lineageId: r.lineage_id, version: r.version, title, sunoModel, sources, limits }, tokensUsed: 0 };
};
