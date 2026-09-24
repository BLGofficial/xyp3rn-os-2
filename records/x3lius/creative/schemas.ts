import type { JsonSchema } from '../../../core/llm/json-schema.ts';

/**
 * Output contracts of the Phase 8 Creative agents. Structured on purpose: the Phase 12 Critic
 * diffs an artifact against a rubric field by field, which a prose blob would not allow. Every
 * schema ends with the same traceability pair — which canonical rules shaped the output, and
 * which decisions no rule covered — so thin knowledge shows up in the artifact, not just a log.
 *
 * Nothing here describes an artist's voice: languages are free ISO codes, not a fixed list, and
 * every stylistic choice is left to the canonical rules the agent is given at run time.
 */

const str = (description?: string): JsonSchema => (description ? { type: 'string', description } : { type: 'string' });
const int = (description: string): JsonSchema => ({ type: 'integer', description });
const arr = (items: JsonSchema, description?: string): JsonSchema => (description ? { type: 'array', items, description } : { type: 'array', items });
const obj = (properties: Record<string, JsonSchema>, description?: string): JsonSchema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false, ...(description ? { description } : {}),
});

const SECTION_KIND: JsonSchema = { type: 'string', enum: ['intro', 'verse', 'pre-chorus', 'chorus', 'post-chorus', 'hook', 'bridge', 'breakdown', 'outro'] };
const LANGUAGE = str('Language of this text: an ISO 639-1 code, or "mixed" when it switches within the line');

const TRACEABILITY = {
  rulesApplied: arr(obj({ ref: str('A ref copied exactly from CANONICAL RULES'), how: str('How that rule shaped this output') })),
  ungroundedChoices: arr(str('A creative decision no given rule covers')),
};

export const SONG_STRUCTURE_SCHEMA_ID = 'x3lius.song-structure/v1';
export const LYRICS_SCHEMA_ID = 'x3lius.lyrics/v1';
export const COMPOSITION_SCHEMA_ID = 'x3lius.composition/v1';

export const SONG_STRUCTURE_SCHEMA = obj({
  title: str('Working title'),
  theme: obj({ statement: str('What the song is about, in one sentence'), perspective: str('Who speaks, to whom') }),
  sections: arr(obj({ id: str('Unique id, e.g. v1, c1'), kind: SECTION_KIND, bars: int('Length in bars'), purpose: str('What this section does for the song') })),
  hook: obj({
    candidates: arr(obj({ text: str('The hook line'), language: LANGUAGE, rationale: str('Why it could carry the song') }), 'At least two candidates'),
    selectedIndex: int('0-based index into candidates'),
    selectionReason: str('Why this candidate wins'),
  }),
  ...TRACEABILITY,
});

export const LYRICS_SCHEMA = obj({
  section: obj({ kind: SECTION_KIND, label: str('e.g. "Verse 1"') }),
  bars: arr(obj({ n: int('1-based bar number'), text: str('The words of this bar'), language: LANGUAGE, rhymeTag: str('Rhyme-scheme letter this bar ends on, e.g. A') })),
  rhymeScheme: str('The pattern across the bars, e.g. AABB'),
  devices: arr(obj({ bar: int('Bar number'), device: str('Named technique, e.g. internal rhyme'), note: str('Where and how it is used') })),
  ...TRACEABILITY,
});

export const COMPOSITION_SCHEMA = obj({
  key: obj({ tonic: str('e.g. C#'), mode: str('e.g. minor, phrygian') }),
  tempoBpm: { type: 'number', description: 'Beats per minute' },
  timeSignature: str('e.g. 4/4'),
  progressions: arr(obj({ section: str('Section it serves, e.g. verse'), chords: arr(str('Chord symbol')), barsPerChord: { type: 'number', description: 'Bars each chord lasts' } })),
  melody: obj({ range: str('Lowest to highest note'), contour: str('Overall shape'), motif: str('The recurring figure') }),
  ...TRACEABILITY,
});

/** schema id → schema: what write_artifact accepts. */
export const ARTIFACT_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  [SONG_STRUCTURE_SCHEMA_ID]: SONG_STRUCTURE_SCHEMA,
  [LYRICS_SCHEMA_ID]: LYRICS_SCHEMA,
  [COMPOSITION_SCHEMA_ID]: COMPOSITION_SCHEMA,
};
