import type { AgentContext, AgentHandler } from '../../../core/orchestrator/dispatch.ts';
import { readArtifact, sourceOf } from '../creative/artifacts.ts';
import { META_TAG_SET_SCHEMA_ID, STYLE_RECIPE_SCHEMA_ID, SUNO_PROMPT_SCHEMA_ID } from '../creative/schemas.ts';
import { mixedScriptWords } from '../creative/script-check.ts';
import { defaultTagSet, tagSetProblems, type TagSet } from './tags.ts';

export const STUDIO_EDITOR_AGENT = 'x3lius-studio-editor';

/** What the studio editor returns: the version it wrote. */
export type StudioVersion = {
  readonly artifactId: string;
  readonly lineageId: string;
  readonly version: number;
  readonly schemaId: string;
  /** Mixed-script words in text Suno never receives (F22): written, and reported. */
  readonly warnings: readonly string[];
};

const OPS = ['recipe', 'recipeFrom', 'tagSet', 'defaultTagSet'] as const;
type Args = Record<string, unknown>;
type Body = Record<string, unknown>;

const fail = (message: string): never => {
  throw new Error(`${STUDIO_EDITOR_AGENT}: ${message}`);
};
const text = (a: Args, key: string): string => (typeof a[key] === 'string' ? (a[key] as string) : fail(`${key} must be a string`));
const list = (a: Args, key: string): string[] => {
  const v = a[key] ?? [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return fail(`${key} must be a list of strings`);
  if (v.some((x) => x.trim() === '')) return fail(`${key} has a blank entry`);
  return v;
};

/**
 * F22 on a body: a mixed-script word in text Suno receives verbatim refuses the write; anywhere else
 * it is a warning.
 * @param body - the body to write
 * @param toSuno - JSON paths of the text Suno receives
 * @returns the warnings
 */
const scriptCheck = (body: Body, toSuno: RegExp): string[] => {
  const found = mixedScriptWords(body).map((w) => ({ ...w, message: `mixed-script word "${w.word}" at ${w.path} (Latin and Cyrillic letters in one word)` }));
  const hard = found.filter((w) => toSuno.test(w.path));
  if (hard.length > 0) fail(`${hard.map((w) => w.message).join('; ')}: Suno receives this text; retype the word in one alphabet`);
  return found.map((w) => w.message);
};
const RECIPE_TO_SUNO = /^\$\.(style|excludeStyles\[\d+\])$/;
const TAGS_TO_SUNO = /^\$\.sections\[\d+\]\.(label|cues\[\d+\])$/;

const write = async (
  ctx: AgentContext,
  schemaId: string,
  body: Body,
  meta: { readonly brief: string; readonly contextRefs: readonly unknown[]; readonly knowledge: Record<string, unknown>; readonly parentId?: string; readonly warnings: readonly string[] },
): Promise<StudioVersion> => {
  const r = (await ctx.useTool('write_artifact', {
    schemaId, brief: meta.brief, body, contextRefs: meta.contextRefs, knowledge: meta.knowledge, model: ctx.agent.model,
    ...(meta.parentId ? { parentId: meta.parentId } : {}),
    warnings: meta.warnings.map((message) => ({ kind: 'studio', message })),
  })) as { artifact_id: string; lineage_id: string; version: number };
  for (const w of meta.warnings) ctx.log('warn', w);
  return { artifactId: r.artifact_id, lineageId: r.lineage_id, version: r.version, schemaId, warnings: meta.warnings };
};

/** The parent an edit continues, which must be of the same kind. */
const parentOf = async (ctx: AgentContext, a: Args, schemaId: string): Promise<{ id: string; version: number } | null> => {
  if (a.parentId === undefined) return null;
  if (typeof a.parentId !== 'string') return fail('parentId must be an artifact id');
  const p = (await ctx.useTool('read_artifact', { id: a.parentId })) as { id: string; schemaId: string; version: number };
  if (p.schemaId !== schemaId) fail(`edits ${schemaId} only; ${p.id} is ${p.schemaId}`);
  return p;
};

const OWNER = { rulesApplied: [], ungroundedChoices: ['owner-authored'] };

const recipe = async (ctx: AgentContext, a: Args): Promise<StudioVersion> => {
  const name = text(a, 'name');
  const style = text(a, 'style');
  if (name.trim() === '') fail('name is blank');
  if (style.trim() === '') fail('style is blank: it is the "Style of Music" field Suno receives');
  const parent = await parentOf(ctx, a, STYLE_RECIPE_SCHEMA_ID);
  const body = {
    name, style, excludeStyles: list(a, 'excludeStyles'), mood: list(a, 'mood'), production: list(a, 'production'), notes: list(a, 'notes'),
    sources: [], ...OWNER,
  };
  return write(ctx, STYLE_RECIPE_SCHEMA_ID, body, {
    brief: parent ? `Owner edit of style recipe ${parent.id} (v${parent.version})` : `Style recipe "${name}"`,
    contextRefs: [{ kind: 'owner-edit' }], knowledge: { authored: 'owner' }, warnings: scriptCheck(body, RECIPE_TO_SUNO),
    ...(parent ? { parentId: parent.id } : {}),
  });
};

// A formula's style and exclusions are the model's words: the recipe cites the formula and says so,
// so an approved recipe never passes as the owner's own writing.
const recipeFrom = async (ctx: AgentContext, a: Args): Promise<StudioVersion> => {
  if (typeof a.artifactId !== 'string') fail('recipeFrom needs artifactId, a x3lius.suno-prompt/v1 formula');
  const f = await readArtifact(ctx, a.artifactId as string, [SUNO_PROMPT_SCHEMA_ID]);
  const name = a.name === undefined ? String(f.body.title) : text(a, 'name');
  if (name.trim() === '') fail('name is blank');
  const body = {
    name, style: String(f.body.style), excludeStyles: f.body.excludeStyles as string[], mood: [], production: [], notes: [],
    sources: [sourceOf('suno-prompt', f)], rulesApplied: [], ungroundedChoices: [`copied from the model-written formula ${f.id} v${f.version}`],
  };
  return write(ctx, STYLE_RECIPE_SCHEMA_ID, body, {
    brief: `Style recipe "${name}" from formula ${f.id} (v${f.version})`,
    contextRefs: [{ kind: 'artifact', artifactId: f.id, schemaId: f.schemaId, version: f.version }],
    knowledge: { authored: 'model', via: f.id }, warnings: scriptCheck(body, RECIPE_TO_SUNO),
  });
};

const tagSetBody = (set: TagSet, ungrounded: readonly string[]): Body => ({ ...set, rulesApplied: [], ungroundedChoices: ungrounded });

const tagSet = async (ctx: AgentContext, a: Args): Promise<StudioVersion> => {
  if (!Array.isArray(a.sections)) fail('tagSet needs sections: [{ kind, label, numbered?, cues? }]');
  const sections = (a.sections as unknown[]).map((s, i) => {
    const o = (s ?? {}) as Args;
    if (typeof o.kind !== 'string' || typeof o.label !== 'string') fail(`sections[${i}] needs a kind and a label`);
    if (o.numbered !== undefined && typeof o.numbered !== 'boolean') fail(`sections[${i}].numbered must be true or false`);
    return { kind: o.kind as string, label: o.label as string, numbered: (o.numbered as boolean | undefined) ?? false, cues: list(o, 'cues') };
  });
  const set: TagSet = { name: text(a, 'name'), sections, notes: list(a, 'notes') };
  const problems = tagSetProblems(set);
  if (problems.length > 0) fail(problems.join('; '));
  const parent = await parentOf(ctx, a, META_TAG_SET_SCHEMA_ID);
  const body = tagSetBody(set, ['owner-authored']);
  return write(ctx, META_TAG_SET_SCHEMA_ID, body, {
    brief: parent ? `Owner edit of tag set ${parent.id} (v${parent.version})` : `Tag set "${set.name}"`,
    contextRefs: [{ kind: 'owner-edit' }], knowledge: { authored: 'owner' }, warnings: scriptCheck(body, TAGS_TO_SUNO),
    ...(parent ? { parentId: parent.id } : {}),
  });
};

const defaultSet = async (ctx: AgentContext): Promise<StudioVersion> =>
  write(ctx, META_TAG_SET_SCHEMA_ID, tagSetBody(defaultTagSet(), ['code default: sectionLabels (F21)']), {
    brief: 'The default tag set, from the code labels (S2)', contextRefs: [{ kind: 'code', ref: 'records/x3lius/studio/tags.ts#defaultTagSet' }],
    knowledge: { authored: 'code' }, warnings: [],
  });

/**
 * x3lius-studio-editor (AOS-03, Creative, deterministic): writes the owner's Studio records as
 * versioned artifacts, never a model's choice. Exactly one of
 * - `{ recipe: { name, style, excludeStyles?, mood?, production?, notes?, parentId? } }`: a style recipe, or its next version;
 * - `{ recipeFrom: { artifactId, name? } }`: a recipe from a model's Suno formula (its style and exclusions), citing it;
 * - `{ tagSet: { name, sections, notes?, parentId? } }`: a meta-tag set, or its next version;
 * - `{ defaultTagSet: {} }`: the code labels as a new tag set lineage (S2).
 * Every version is a draft until the owner approves it (xyp_decide_artifact); nothing here approves.
 * @param ctx - run context; read_artifact reads, write_artifact writes
 * @param input - one of the shapes above
 * @returns the version written
 */
export const studioEditor: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as Args;
  const ops = OPS.filter((k) => i[k] !== undefined);
  if (ops.length !== 1 || Object.keys(i).length !== 1) fail(`input needs exactly one of ${OPS.join(', ')}`);
  const op = ops[0]!;
  const a = i[op];
  if (a === null || typeof a !== 'object' || Array.isArray(a)) fail(`${op} must be an object`);
  const out = op === 'recipe' ? await recipe(ctx, a as Args)
    : op === 'recipeFrom' ? await recipeFrom(ctx, a as Args)
      : op === 'tagSet' ? await tagSet(ctx, a as Args)
        : await defaultSet(ctx);
  return { output: out, tokensUsed: 0 };
};
