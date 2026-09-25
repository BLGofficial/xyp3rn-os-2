import { readArtifact, sourceOf, withoutTrace, type ArtifactRow, type ArtifactSource } from '../creative/artifacts.ts';
import {
  GENRE_STYLE_SCHEMA_ID, LYRICS_SCHEMA_ID, LYRICS_V1_SCHEMA_ID, SONG_STRUCTURE_SCHEMA_ID, SUNO_PROMPT_LLM_SCHEMA, SUNO_PROMPT_LLM_SCHEMA_ID,
  SUNO_PROMPT_SCHEMA, SUNO_PROMPT_SCHEMA_ID,
} from '../creative/schemas.ts';
import { CLAIM_NAMESPACE, scopeOf, VOICE_MODULE, type ContextEntry, type CreativeSpec, type Prepared } from '../creative/types.ts';

/**
 * Phase 9 Suno Prompt-Formula (agent x3lius-suno, Creative). Hybrid by user decision:
 * - the model writes the title, the style prompt and the styles to exclude, citing canonical rules
 *   (Suno rules from x3lius-suno, genre/style rules, voice rules, and `suno.*` claims);
 * - code renders the lyrics from the approved Phase 8 lyrics artifact(s), so the model can't
 *   rewrite them, and records which artifact versions the prompt was built from;
 * - a length limit is enforced only when a canonical claim states it (`suno.limit.<field>-chars`,
 *   scoped to the Suno model), never from a constant here.
 * Rules and claims tagged for another Suno version (`suno-<v>`) are kept out of the prompt.
 */

/** One command from a brief to a Suno-ready prompt: songwriting + lyrics + genre/style → formula. */
export const SONG_TO_SUNO_WORKFLOW = 'records/x3lius/song-to-suno.workflow.yaml';

type LyricSection = { readonly kind: string; readonly label: string; readonly bars: readonly { readonly text: string }[] };
type Source = ArtifactSource<'lyrics' | 'structure' | 'genre-style'>;
type SunoState = { readonly sunoModel: string; readonly lyrics: string; readonly sources: readonly Source[] };

const SUNO_MODEL = /^v\d+(\.\d+)?[a-z]*$/;
export const LIMIT_TOPIC = /^suno\.limit\.([a-z]+(?:-[a-z]+)*)-chars$/;

/** A lyrics artifact's sections in song order: v2 holds the whole song, v1 (Phase 8) one section. */
const sectionsOf = (a: { readonly schemaId: string; readonly body: unknown }): readonly LyricSection[] => {
  if (a.schemaId !== LYRICS_V1_SCHEMA_ID) return (a.body as { sections: LyricSection[] }).sections;
  const b = a.body as { section: { kind: string; label: string }; bars: LyricSection['bars'] };
  return [{ ...b.section, bars: b.bars }];
};

/**
 * Renders lyrics artifacts into Suno's lyrics field: a `[Section label]` meta-tag, then one line
 * per bar; sections separated by a blank line. Formatting only — the words are the artifact's.
 * Sections a v2 artifact lists as instrumental carry no words and are not rendered.
 * @param artifacts - x3lius.lyrics/v2 (or v1) artifacts with their schema ids, in song order
 * @returns the lyrics text submitted to Suno
 */
export const renderLyrics = (artifacts: readonly { readonly schemaId: string; readonly body: unknown }[]): string =>
  artifacts.flatMap(sectionsOf).map((s) => `[${s.label.trim() || s.kind}]\n${s.bars.map((x) => x.text).join('\n')}`).join('\n\n');

/**
 * Model-agnostic entries apply to every Suno version, `suno-<version>` only to that version, and
 * anything scoped to another tool (e.g. the Vocal DNA's `rvc` settings, Phase 10) never.
 */
export const appliesTo = (tag: string | null, sunoModel: string): boolean => tag === null || tag === 'model-agnostic' || tag === `suno-${sunoModel}`;

/**
 * The lengths Suno limits apply to, measured from a Suno-prompt body's own text. The Critic and
 * Revision measure the same way, never from the stored `limits`.
 * @param b - a body with title, style, excludeStyles and lyrics
 * @returns character counts by limit field
 */
export const measureSunoText = (b: Record<string, unknown>): Record<string, number> => ({
  title: String(b.title).length,
  style: String(b.style).length,
  'exclude-styles': (b.excludeStyles as string[]).join(', ').length,
  lyrics: String(b.lyrics).length,
});

const prepare: CreativeSpec['prepare'] = async (ctx, input) => {
  const sunoModel = typeof input.sunoModel === 'string' ? input.sunoModel.toLowerCase() : '';
  if (!SUNO_MODEL.test(sunoModel)) throw new Error('x3lius-suno needs sunoModel, the target Suno version, e.g. "v5" or "v4.5"');
  const lyricsIds = input.lyricsArtifactIds;
  if (!Array.isArray(lyricsIds) || lyricsIds.length === 0 || !lyricsIds.every((i) => typeof i === 'string')) {
    throw new Error(`x3lius-suno needs lyricsArtifactIds: the Phase 8 lyrics artifacts to render, in song order (or run ${SONG_TO_SUNO_WORKFLOW})`);
  }
  const optional = async (key: string, expected: string): Promise<ArtifactRow | null> =>
    (typeof input[key] === 'string' ? readArtifact(ctx, input[key] as string, [expected]) : null);

  const lyrics = await Promise.all((lyricsIds as string[]).map((id) => readArtifact(ctx, id, [LYRICS_V1_SCHEMA_ID, LYRICS_SCHEMA_ID])));
  const structure = await optional('structureArtifactId', SONG_STRUCTURE_SCHEMA_ID);
  const genre = await optional('genreStyleArtifactId', GENRE_STYLE_SCHEMA_ID);
  const rendered = renderLyrics(lyrics);
  const sources: Source[] = [...lyrics.map((l) => sourceOf('lyrics', l)), ...(structure ? [sourceOf('structure', structure)] : []), ...(genre ? [sourceOf('genre-style', genre)] : [])];

  const request = typeof input.request === 'string' && input.request.trim() !== '' ? input.request : null;
  const state: SunoState = { sunoModel, lyrics: rendered, sources };
  return {
    brief: request ?? `Suno ${sunoModel} prompt for ${sources.map((s) => `${s.role} ${s.artifactId} v${s.version}`).join(', ')}`,
    userSections: [
      `TARGET\nSuno model ${sunoModel}.`,
      `LYRICS (fixed: rendered from the approved lyrics artifact and submitted exactly as shown; not yours to change)\n${rendered}`,
      ...(structure ? [`SONG STRUCTURE (artifact ${structure.id} v${structure.version})\n${JSON.stringify(withoutTrace(structure.body))}`] : []),
      ...(genre ? [`GENRE/STYLE TARGET (artifact ${genre.id} v${genre.version})\n${JSON.stringify(withoutTrace(genre.body))}`] : []),
    ],
    state,
  };
};

const admit = (e: ContextEntry, p: Prepared): boolean => appliesTo(scopeOf(e), (p.state as SunoState).sunoModel);

const finalize: CreativeSpec['finalize'] = (reply, p, entries) => {
  const s = p.state as SunoState;
  const measured = measureSunoText({ title: reply.title, style: reply.style, excludeStyles: reply.excludeStyles, lyrics: s.lyrics });
  const limits = entries.flatMap((e) => {
    const m = e.kind === 'claim' ? LIMIT_TOPIC.exec(e.topic) : null;
    if (!m || e.kind !== 'claim' || !Number.isInteger(e.value) || !(m[1]! in measured)) return [];
    return [{ field: m[1]!, max: e.value as number, actual: measured[m[1]!]!, ref: e.ref }];
  });
  return {
    body: {
      sunoModel: s.sunoModel, title: reply.title, style: reply.style, excludeStyles: reply.excludeStyles, lyrics: s.lyrics,
      sources: s.sources, limits, rulesApplied: reply.rulesApplied, ungroundedChoices: reply.ungroundedChoices,
    },
    violations: limits.filter((l) => l.actual > l.max).map((l) => `${l.field} is ${l.actual} chars; canonical limit ${l.max} (${l.ref})`),
  };
};

export const SUNO_FORMULA_SPEC: CreativeSpec = {
  schemaId: SUNO_PROMPT_SCHEMA_ID,
  schema: SUNO_PROMPT_SCHEMA,
  llmSchema: { id: SUNO_PROMPT_LLM_SCHEMA_ID, schema: SUNO_PROMPT_LLM_SCHEMA },
  task: 'Write the Suno prompt for the song in the source artifacts: its title, the "Style of Music" text, and the styles to exclude. The lyrics are fixed (see LYRICS) and are not part of your reply.',
  modules: ['x3lius-suno', 'x3lius-genre-style', VOICE_MODULE],
  claimNamespaces: [CLAIM_NAMESPACE, 'suno.'],
  prepare,
  admit,
  exclusionReason: 'scoped to another model or tool',
  finalize,
  // What suno-submitter sends. The lyrics are checked here too, so an older artifact can't pass one on.
  sunoTextPaths: [/^\$\.(title|style|lyrics)$/, /^\$\.excludeStyles\[\d+\]$/],
};
