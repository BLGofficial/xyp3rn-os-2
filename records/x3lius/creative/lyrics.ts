import { readArtifact, sourceOf, withoutTrace, type ArtifactSource } from './artifacts.ts';
import {
  LYRICS_LLM_SCHEMA, LYRICS_LLM_SCHEMA_ID, LYRICS_SCHEMA, LYRICS_SCHEMA_ID, LYRICS_SECTION_LLM_SCHEMA, LYRICS_SECTION_LLM_SCHEMA_ID, SONG_STRUCTURE_SCHEMA_ID,
} from './schemas.ts';
import type { Completion, CreativeSpec } from './types.ts';

/**
 * Lyrics (agent x3lius-lyrics), x3lius.lyrics/v2: the whole song, against the song structure.
 * - With a song-structure artifact: one model call per structure section, in order (user decision
 *   after live runs where a whole song in one reply overflowed, stalled or was abandoned on the
 *   free route). Each call sees the structure and the lyrics written so far; code sets each
 *   section's id and kind from the structure, so coverage and order hold by construction, and
 *   records the structure version followed. A failed call stops the run: nothing is written.
 * - Without one (a bare brief from `pnpm ask`): one call writing the sections the brief asks for.
 */

type Bar = { readonly n: number; readonly text: string };
type Section = { readonly sectionId: string; readonly kind: string; readonly label: string; readonly bars: readonly Bar[]; readonly rhymeScheme: string; readonly devices: readonly unknown[] };
type SectionReply = Omit<Section, 'sectionId' | 'kind'> & { readonly instrumental: boolean; readonly rulesApplied: readonly { readonly ref: string; readonly how: string }[]; readonly ungroundedChoices: readonly string[] };
type StructureSection = { readonly id: string; readonly kind: string; readonly bars: number; readonly purpose: string };
type LyricsState = { readonly structure: { readonly source: ArtifactSource<'structure'>; readonly sections: readonly StructureSection[] } | null };

const SECTION_SCHEMA = { id: LYRICS_SECTION_LLM_SCHEMA_ID, schema: LYRICS_SECTION_LLM_SCHEMA };

const prepare: CreativeSpec['prepare'] = async (ctx, input) => {
  const request = input.request;
  if (typeof request !== 'string' || request.trim() === '') throw new Error('request must be a non-empty string');
  if (input.structureArtifactId === undefined) return { brief: request, userSections: [], state: { structure: null } satisfies LyricsState };
  if (typeof input.structureArtifactId !== 'string') throw new Error('structureArtifactId must be an artifact id (a uuid string)');
  const a = await readArtifact(ctx, input.structureArtifactId, [SONG_STRUCTURE_SCHEMA_ID]);
  const sections = (a.body.sections as StructureSection[]).map(({ id, kind, bars, purpose }) => ({ id, kind, bars, purpose }));
  const state: LyricsState = { structure: { source: sourceOf('structure', a), sections } };
  return {
    brief: request,
    userSections: [`SONG STRUCTURE (artifact ${a.id} v${a.version})\n${JSON.stringify(withoutTrace(a.body))}`],
    state,
  };
};

/** Prompt context for the next call: every section so far, sung ones with their words. */
const writtenSoFar = (done: readonly (Section | StructureSection)[]): string =>
  `LYRICS WRITTEN SO FAR\n${done.length === 0
    ? '(none yet: this is the first section)'
    : done.map((s) => ('sectionId' in s ? `[${s.label}] (${s.sectionId})\n${s.bars.map((b) => b.text).join('\n')}` : `(${s.id}, ${s.kind}: instrumental)`)).join('\n\n')}`;

/**
 * One call per structure section; the replies are combined into one v2 reply. Each call's trace is
 * kept, prefixed with its section, so the Critic can see which rule shaped which section.
 */
const generate: CreativeSpec['generate'] = async (call, p, log) => {
  const { structure } = p.state as LyricsState;
  if (!structure) return call([]);
  const done: (Section | StructureSection)[] = [];
  const traces: { rulesApplied: SectionReply['rulesApplied']; ungroundedChoices: string[] }[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let model = '';
  for (const [i, s] of structure.sections.entries()) {
    const started = Date.now();
    let res: Completion;
    try {
      res = await call([writtenSoFar(done), `WRITE NOW: section ${s.id} (${s.kind}, ${s.bars} bars): ${s.purpose}`], SECTION_SCHEMA);
    } catch (e) {
      throw new Error(`section ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const r = res.json as SectionReply;
    if (r.instrumental && r.bars.length > 0) throw new Error(`section ${s.id}: marked instrumental but has ${r.bars.length} bars`);
    done.push(r.instrumental ? s : { sectionId: s.id, kind: s.kind, label: r.label, bars: r.bars, rhymeScheme: r.rhymeScheme, devices: r.devices });
    traces.push({
      rulesApplied: r.rulesApplied.map((x) => ({ ref: x.ref, how: `[${s.id}] ${x.how}` })),
      ungroundedChoices: r.ungroundedChoices.map((u) => `[${s.id}] ${u}`),
    });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    model = res.model;
    await log(`section ${s.id} (${s.kind}) ${i + 1}/${structure.sections.length}: ${r.instrumental ? 'instrumental' : `${r.bars.length} bars`} in ${Date.now() - started}ms`);
  }
  return {
    json: {
      sections: done.filter((d): d is Section => 'sectionId' in d),
      instrumental: done.filter((d): d is StructureSection => !('sectionId' in d)).map((d) => d.id),
      rulesApplied: traces.flatMap((t) => t.rulesApplied),
      ungroundedChoices: traces.flatMap((t) => t.ungroundedChoices),
    },
    usage,
    model,
  };
};

const finalize: CreativeSpec['finalize'] = (reply, p) => {
  const { structure } = p.state as LyricsState;
  return {
    body: { sections: reply.sections, instrumental: reply.instrumental, sources: structure ? [structure.source] : [], rulesApplied: reply.rulesApplied, ungroundedChoices: reply.ungroundedChoices },
    violations: [],
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
    'Write the lyrics the brief asks for.',
    'When a SONG STRUCTURE is given, each reply is one section: the one under WRITE NOW, consistent with LYRICS WRITTEN SO FAR. Set instrumental to true, with no bars, if that section has no vocals; where the song carries its hook, use the hook the structure selected.',
    'Without a structure, write the sections the brief asks for (one verse if it does not say) in one reply.',
    'For each section, bar by bar: the words of each bar, its language and the rhyme tag it ends on; then the section’s rhyme scheme and the devices used.',
  ].join(' '),
  prepare,
  generate,
  finalize,
  check,
  // Rendered into Suno's lyrics field as-is: each bar, and the label as the [label] meta-tag.
  sunoTextPaths: [/^\$\.sections\[\d+\]\.bars\[\d+\]\.text$/, /^\$\.sections\[\d+\]\.label$/],
};
