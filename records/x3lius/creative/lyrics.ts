import { readArtifact, sourceOf, withoutTrace, type ArtifactSource } from './artifacts.ts';
import { LYRICS_LLM_SCHEMA, LYRICS_LLM_SCHEMA_ID, LYRICS_SCHEMA, LYRICS_SCHEMA_ID, SONG_STRUCTURE_SCHEMA_ID } from './schemas.ts';
import type { CreativeSpec } from './types.ts';

/**
 * Lyrics (agent x3lius-lyrics): the whole song in one reply (x3lius.lyrics/v2, user decision after
 * the Phase 9 live run, where lyrics written from the brief alone gave Suno one verse and no hook).
 * Given a song-structure artifact, the reply must cover every one of its sections in its order,
 * each either written or listed as instrumental, with the structure's kinds. Code, not the model,
 * records which structure version was followed. Without one (a bare brief from `pnpm ask`), the
 * model writes the sections the brief asks for.
 */

type Section = { readonly sectionId: string; readonly kind: string; readonly bars: readonly { readonly n: number }[] };
type StructureSection = { readonly id: string; readonly kind: string };
type LyricsState = { readonly structure: { readonly source: ArtifactSource<'structure'>; readonly sections: readonly StructureSection[] } | null };

const prepare: CreativeSpec['prepare'] = async (ctx, input) => {
  const request = input.request;
  if (typeof request !== 'string' || request.trim() === '') throw new Error('request must be a non-empty string');
  if (input.structureArtifactId === undefined) return { brief: request, userSections: [], state: { structure: null } satisfies LyricsState };
  if (typeof input.structureArtifactId !== 'string') throw new Error('structureArtifactId must be an artifact id (a uuid string)');
  const a = await readArtifact(ctx, input.structureArtifactId, [SONG_STRUCTURE_SCHEMA_ID]);
  const state: LyricsState = { structure: { source: sourceOf('structure', a), sections: (a.body.sections as StructureSection[]).map(({ id, kind }) => ({ id, kind })) } };
  return {
    brief: request,
    userSections: [`SONG STRUCTURE (artifact ${a.id} v${a.version})\n${JSON.stringify(withoutTrace(a.body))}`],
    state,
  };
};

/** Every structure section exactly once (written or instrumental), nothing else, in its order, with its kind. */
const coverage = (structure: readonly StructureSection[], sections: readonly Section[], instrumental: readonly string[]): string[] => {
  const kinds = new Map(structure.map((s) => [s.id, s.kind]));
  const order = structure.map((s) => s.id);
  const covered = new Set([...sections.map((s) => s.sectionId), ...instrumental]);
  const written = sections.map((s) => s.sectionId).filter((id) => kinds.has(id));
  const expected = order.filter((id) => written.includes(id));
  return [
    ...[...covered].filter((id) => !kinds.has(id)).map((id) => `section ${id} is not in the structure (${order.join(', ')})`),
    ...order.filter((id) => !covered.has(id)).map((id) => `structure section ${id} has no lyrics and is not listed as instrumental`),
    ...(written.join() === expected.join() ? [] : [`sections are out of structure order: got ${written.join(', ')}; expected ${expected.join(', ')}`]),
    ...sections.filter((s) => kinds.has(s.sectionId) && kinds.get(s.sectionId) !== s.kind).map((s) => `section ${s.sectionId} is ${s.kind}; the structure says ${kinds.get(s.sectionId)}`),
  ];
};

const finalize: CreativeSpec['finalize'] = (reply, p) => {
  const { structure } = p.state as LyricsState;
  const sections = reply.sections as Section[];
  const instrumental = reply.instrumental as string[];
  return {
    body: { sections, instrumental, sources: structure ? [structure.source] : [], rulesApplied: reply.rulesApplied, ungroundedChoices: reply.ungroundedChoices },
    violations: structure ? coverage(structure.sections, sections, instrumental) : [],
  };
};

const check: CreativeSpec['check'] = (b) => {
  const sections = b.sections as Section[];
  const ids = [...sections.map((s) => s.sectionId), ...(b.instrumental as string[])];
  return [
    ...(sections.length === 0 ? ['sections is empty'] : []),
    ...[...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].map((id) => `section id ${id} appears more than once`),
    ...sections.filter((s) => s.bars.length === 0).map((s) => `section ${s.sectionId} has no bars`),
    ...sections.filter((s) => !s.bars.every((x, i) => x.n === i + 1)).map((s) => `section ${s.sectionId}: bars[].n must count 1, 2, 3… in order`),
  ];
};

export const LYRICS_SPEC: CreativeSpec = {
  schemaId: LYRICS_SCHEMA_ID,
  schema: LYRICS_SCHEMA,
  llmSchema: { id: LYRICS_LLM_SCHEMA_ID, schema: LYRICS_LLM_SCHEMA },
  task: [
    'Write the lyrics the brief asks for, section by section.',
    'When a SONG STRUCTURE is given, cover every one of its sections in its order: a section with vocals goes in sections (sectionId = its id, same kind), one without goes in instrumental, and the hook it selected is the hook you write.',
    'Without a structure, write the sections the brief asks for (one verse if it does not say).',
    'For each section, bar by bar: the words of each bar, its language and the rhyme tag it ends on; then the section’s rhyme scheme and the devices used.',
  ].join(' '),
  prepare,
  finalize,
  check,
  // Rendered into Suno's lyrics field as-is: each bar, and the label as the [label] meta-tag.
  sunoTextPaths: [/^\$\.sections\[\d+\]\.bars\[\d+\]\.text$/, /^\$\.sections\[\d+\]\.label$/],
};
