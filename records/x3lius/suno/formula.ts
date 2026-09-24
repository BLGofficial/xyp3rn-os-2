import {
  GENRE_STYLE_SCHEMA_ID, LYRICS_SCHEMA_ID, SONG_STRUCTURE_SCHEMA_ID, SUNO_PROMPT_LLM_SCHEMA, SUNO_PROMPT_LLM_SCHEMA_ID,
  SUNO_PROMPT_SCHEMA, SUNO_PROMPT_SCHEMA_ID,
} from '../creative/schemas.ts';
import { CLAIM_NAMESPACE, VOICE_MODULE, type ContextEntry, type CreativeSpec, type Prepared } from '../creative/types.ts';

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

type ArtifactRow = { readonly id: string; readonly schemaId: string; readonly version: number; readonly body: Record<string, unknown> };
type LyricsBody = { readonly section: { readonly kind: string; readonly label: string }; readonly bars: readonly { readonly text: string }[] };
type Source = { readonly role: 'lyrics' | 'structure' | 'genre-style'; readonly artifactId: string; readonly schemaId: string; readonly version: number };
type SunoState = { readonly sunoModel: string; readonly lyrics: string; readonly sources: readonly Source[] };

const SUNO_MODEL = /^v\d+(\.\d+)?[a-z]*$/;
const LIMIT_TOPIC = /^suno\.limit\.([a-z]+(?:-[a-z]+)*)-chars$/;

/**
 * Renders lyrics artifacts into Suno's lyrics field: a `[Section label]` meta-tag, then one line
 * per bar; sections separated by a blank line. Formatting only — the words are the artifact's.
 * @param bodies - x3lius.lyrics/v1 bodies, in song order
 * @returns the lyrics text submitted to Suno
 */
export const renderLyrics = (bodies: readonly LyricsBody[]): string =>
  bodies.map((b) => `[${b.section.label.trim() || b.section.kind}]\n${b.bars.map((x) => x.text).join('\n')}`).join('\n\n');

/** A `suno-<version>` tag applies only to that version; anything else (model-agnostic, other tools) applies. */
const appliesTo = (tag: string | null, sunoModel: string): boolean => !tag?.startsWith('suno-') || tag === `suno-${sunoModel}`;

const withoutTrace = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'rulesApplied' && k !== 'ungroundedChoices'));

const prepare: CreativeSpec['prepare'] = async (ctx, input) => {
  const sunoModel = typeof input.sunoModel === 'string' ? input.sunoModel.toLowerCase() : '';
  if (!SUNO_MODEL.test(sunoModel)) throw new Error('x3lius-suno needs sunoModel, the target Suno version, e.g. "v5" or "v4.5"');
  const lyricsIds = input.lyricsArtifactIds;
  if (!Array.isArray(lyricsIds) || lyricsIds.length === 0 || !lyricsIds.every((i) => typeof i === 'string')) {
    throw new Error(`x3lius-suno needs lyricsArtifactIds: the Phase 8 lyrics artifacts to render, in song order (or run ${SONG_TO_SUNO_WORKFLOW})`);
  }
  const read = async (id: string, expected: string) => {
    const a = (await ctx.useTool('read_artifact', { id })) as ArtifactRow;
    if (a.schemaId !== expected) throw new Error(`artifact ${id} is ${a.schemaId}, expected ${expected}`);
    return a;
  };
  const optional = async (key: string, expected: string) => (typeof input[key] === 'string' ? read(input[key] as string, expected) : null);

  const lyrics = await Promise.all((lyricsIds as string[]).map((id) => read(id, LYRICS_SCHEMA_ID)));
  const structure = await optional('structureArtifactId', SONG_STRUCTURE_SCHEMA_ID);
  const genre = await optional('genreStyleArtifactId', GENRE_STYLE_SCHEMA_ID);
  const rendered = renderLyrics(lyrics.map((l) => l.body as unknown as LyricsBody));
  const source = (role: Source['role'], a: ArtifactRow): Source => ({ role, artifactId: a.id, schemaId: a.schemaId, version: a.version });
  const sources = [...lyrics.map((l) => source('lyrics', l)), ...(structure ? [source('structure', structure)] : []), ...(genre ? [source('genre-style', genre)] : [])];

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

const admit = (e: ContextEntry, p: Prepared): boolean => appliesTo(e.kind === 'rule' ? e.modelTag : e.modelScope, (p.state as SunoState).sunoModel);

const finalize: CreativeSpec['finalize'] = (reply, p, entries) => {
  const s = p.state as SunoState;
  const measured: Record<string, number> = {
    title: String(reply.title).length,
    style: String(reply.style).length,
    'exclude-styles': (reply.excludeStyles as string[]).join(', ').length,
    lyrics: s.lyrics.length,
  };
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
  exclusionReason: 'scoped to another Suno version',
  finalize,
};
