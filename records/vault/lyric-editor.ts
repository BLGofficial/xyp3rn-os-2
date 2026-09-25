import type { AgentContext, AgentHandler } from '../../core/orchestrator/dispatch.ts';
import type { ArtifactRecord } from '../../core/tool-registry/tools/read-artifact.ts';
import type { VaultFile } from '../../knowledge/source-registry/vault-tools.ts';
import { LANGUAGE } from '../../knowledge/source-registry/vault-tools.ts';
import { LYRICS_SCHEMA_ID } from '../x3lius/creative/schemas.ts';
import { mixedScriptWords } from '../x3lius/creative/script-check.ts';
import { parseLyricSheet, type ParsedSheet } from './lyric-sheet.ts';

export const LYRIC_EDITOR_AGENT = 'x3lius-lyric-editor';

/** What the lyric editor returns: the version it wrote. */
export type LyricVersion = {
  readonly artifactId: string;
  readonly lineageId: string;
  readonly version: number;
  readonly instrumental: readonly string[];
  /** Sheet text the v2 shape could not keep, and mixed-script words in directions (never sung). */
  readonly warnings: readonly string[];
};

// Owner-authored: no canonical rule shaped these words, and the artifact says so rather than
// looking like an ungrounded model output.
const OWNER = { authored: 'owner' } as const;

/**
 * Checks F22 on what the sheet will send to Suno: the sung lines. A mixed-script word there is
 * refused (a homoglyph is unreadable downstream); in a direction, never sung, it is a warning.
 */
const scriptCheck = (p: ParsedSheet): string[] => {
  const sung = p.sections.flatMap((s) => s.bars.flatMap((b) => mixedScriptWords(b.text).map((w) => `line ${b.n} of ${s.label} mixes Latin and Cyrillic in one word: "${w.word}"`)));
  if (sung.length > 0) throw new Error(`${LYRIC_EDITOR_AGENT}: ${sung.join('; ')}. Retype the word in one alphabet and add the sheet again`);
  return p.sections.flatMap((s) => s.directions.flatMap((d) => mixedScriptWords(d).map((w) => `a direction of ${s.label} mixes Latin and Cyrillic in one word: "${w.word}"`)));
};

const write = async (
  ctx: AgentContext,
  p: ParsedSheet,
  meta: { readonly brief: string; readonly contextRefs: readonly unknown[]; readonly parentId?: string },
): Promise<LyricVersion> => {
  const warnings = [...p.warnings, ...scriptCheck(p)];
  const body = { sections: p.sections, instrumental: p.instrumental, sources: [], rulesApplied: [], ungroundedChoices: ['owner-authored'] };
  const r = (await ctx.useTool('write_artifact', {
    schemaId: LYRICS_SCHEMA_ID, brief: meta.brief, body, contextRefs: meta.contextRefs, knowledge: OWNER, model: ctx.agent.model,
    ...(meta.parentId ? { parentId: meta.parentId } : {}),
    warnings: warnings.map((message) => ({ kind: 'lyric-sheet', message })),
  })) as { artifact_id: string; lineage_id: string; version: number };
  for (const w of warnings) ctx.log('warn', w);
  return { artifactId: r.artifact_id, lineageId: r.lineage_id, version: r.version, instrumental: p.instrumental, warnings };
};

const importSheet = async (ctx: AgentContext, a: Record<string, unknown>): Promise<LyricVersion> => {
  const f = (await ctx.useTool('read_vault_file', { sourceId: a.sourceId })) as VaultFile;
  if (f.mediaClass !== 'lyric_sheet') throw new Error(`${LYRIC_EDITOR_AGENT}: source ${f.id} is a ${f.mediaClass}, not a lyric sheet (add it with --as lyric_sheet)`);
  if (f.text === null) throw new Error(`${LYRIC_EDITOR_AGENT}: lyric sheet ${f.id} has no extracted text`);
  const parsed = parseLyricSheet(f.text, f.language ?? 'und');
  return write(ctx, parsed, {
    brief: `Lyric sheet "${f.title}" (Vault file ${f.id})`,
    // The v2 schema's `sources` holds upstream artifacts only (role structure); the Vault file this
    // version was read from is recorded here instead.
    contextRefs: [{ kind: 'vault-file', sourceId: f.id, sha256: f.sha256, title: f.title }],
  });
};

const edit = async (ctx: AgentContext, a: Record<string, unknown>): Promise<LyricVersion> => {
  if (typeof a.text !== 'string') throw new Error(`${LYRIC_EDITOR_AGENT}: edit needs text, the whole lyric sheet as the owner wants it`);
  if (a.language !== undefined && (typeof a.language !== 'string' || !LANGUAGE.test(a.language))) {
    throw new Error(`${LYRIC_EDITOR_AGENT}: language must be an ISO 639-1 code, "mixed" or "und"`);
  }
  const parent = (await ctx.useTool('read_artifact', { id: a.parentId })) as ArtifactRecord;
  if (parent.schemaId !== LYRICS_SCHEMA_ID) throw new Error(`${LYRIC_EDITOR_AGENT}: edits ${LYRICS_SCHEMA_ID} only; ${parent.id} is ${parent.schemaId}`);
  // Without a language, the edit keeps the parent's (its first bar's), not a guess.
  const firstBar = (parent.body.sections as { bars: { language: string }[] }[])[0]?.bars[0];
  const language = (a.language as string | undefined) ?? firstBar?.language ?? 'und';
  return write(ctx, parseLyricSheet(a.text, language), {
    brief: `Owner edit of ${parent.id} (v${parent.version})`,
    contextRefs: [{ kind: 'owner-edit' }],
    parentId: parent.id,
  });
};

/**
 * x3lius-lyric-editor (AOS-01, Creative, deterministic): writes the owner's lyrics as
 * x3lius.lyrics/v2 versions, never a model's. One of
 * - `{ import: { sourceId } }`: a Vault lyric sheet → a new lineage (v1), citing the file;
 * - `{ edit: { parentId, text, language? } }`: the owner's text → the next version of that lineage.
 * Every version is a draft until the owner approves it (xyp_decide_artifact); nothing here approves.
 * @param ctx - run context; read_vault_file / read_artifact read, write_artifact writes
 * @param input - one of the shapes above
 * @returns the version written
 */
export const lyricEditor: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as Record<string, unknown>;
  const ops = (['import', 'edit'] as const).filter((k) => i[k] !== undefined);
  if (ops.length !== 1 || Object.keys(i).length !== 1) throw new Error(`${LYRIC_EDITOR_AGENT} input needs exactly one of import, edit`);
  const a = i[ops[0]!];
  if (a === null || typeof a !== 'object' || Array.isArray(a)) throw new Error(`${LYRIC_EDITOR_AGENT}: ${ops[0]} must be an object`);
  const out = ops[0] === 'import' ? await importSheet(ctx, a as Record<string, unknown>) : await edit(ctx, a as Record<string, unknown>);
  return { output: out, tokensUsed: 0 };
};
