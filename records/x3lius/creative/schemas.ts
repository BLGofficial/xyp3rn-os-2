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
export const LYRICS_V1_SCHEMA_ID = 'x3lius.lyrics/v1';
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

const BAR = obj({ n: int('1-based bar number'), text: str('The words of this bar'), language: LANGUAGE, rhymeTag: str('Rhyme-scheme letter this bar ends on, e.g. A') });

/** Phase 8's one-section lyrics. No agent writes it any more; kept so existing artifacts stay readable and revisable. */
export const LYRICS_V1_SCHEMA = obj({
  section: obj({ kind: SECTION_KIND, label: str('e.g. "Verse 1"') }),
  bars: arr(BAR),
  rhymeScheme: str('The pattern across the bars, e.g. AABB'),
  devices: arr(obj({ bar: int('Bar number'), device: str('Named technique, e.g. internal rhyme'), note: str('Where and how it is used') })),
  ...TRACEABILITY,
});

// Whole-song lyrics (after the Phase 9 live run showed one verse reaching Suno with no chorus): every
// section of the song structure, written one section per model call (LYRICS_SECTION_LLM; a whole
// song in one reply proved unreliable on the free route) and assembled by code, which sets each
// section's id and kind from the structure and records the structure followed (sources). A bare
// brief with no structure is one call on LYRICS_LLM.
export const LYRICS_SCHEMA_ID = 'x3lius.lyrics/v2';
export const LYRICS_LLM_SCHEMA_ID = 'x3lius.lyrics-llm/v2';
export const LYRICS_SECTION_LLM_SCHEMA_ID = 'x3lius.lyrics-section-llm/v2';
const SECTION_WRITTEN = {
  label: str('e.g. "Verse 1", "Chorus"'),
  bars: arr(BAR),
  rhymeScheme: str('The pattern across this section’s bars, e.g. AABB'),
  devices: arr(obj({ bar: int('Bar number within this section'), device: str('Named technique, e.g. internal rhyme'), note: str('Where and how it is used') })),
};
const LYRICS_WRITTEN = {
  sections: arr(obj({
    sectionId: str('The id of the SONG STRUCTURE section this covers (e.g. v1); a short id of your own when no structure is given'),
    kind: SECTION_KIND,
    ...SECTION_WRITTEN,
  }), 'In song order'),
  instrumental: arr(str('Id of a SONG STRUCTURE section that has no vocals')),
};
export const LYRICS_LLM_SCHEMA = obj({ ...LYRICS_WRITTEN, ...TRACEABILITY });
export const LYRICS_SECTION_LLM_SCHEMA = obj({
  instrumental: { type: 'boolean', description: 'true when this section has no vocals; bars is then empty' },
  ...SECTION_WRITTEN,
  ...TRACEABILITY,
});
export const LYRICS_SCHEMA = obj({
  ...LYRICS_WRITTEN,
  sources: arr(obj({ role: { type: 'string', enum: ['structure'] }, artifactId: str(), schemaId: str(), version: int('Artifact version') }), 'The song structure followed; empty when none was given'),
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

// Phase 9 (F15): the genre/style target the Suno formula builds on.
export const GENRE_STYLE_SCHEMA_ID = 'x3lius.genre-style/v1';
export const GENRE_STYLE_SCHEMA = obj({
  primaryGenre: str('The main genre'),
  subgenres: arr(str('A subgenre or fusion')),
  tempoBpm: obj({ min: { type: 'number', description: 'Lowest BPM' }, max: { type: 'number', description: 'Highest BPM' } }),
  mood: arr(str('A mood word')),
  soundPalette: arr(obj({ element: str('e.g. drums, bass, pads, vocal chain'), descriptor: str('How it should sound') })),
  referenceDescriptors: arr(obj({ descriptor: str('A described sound — never an artist, song or album name'), why: str('What it contributes') })),
  avoid: arr(str('A sound or style to keep out')),
  ...TRACEABILITY,
});

// Phase 9: the Suno-ready prompt. The model writes only title/style/exclusions (SUNO_PROMPT_LLM);
// the lyrics are rendered from the approved lyrics artifact, and sources/limits are filled by code.
export const SUNO_PROMPT_SCHEMA_ID = 'x3lius.suno-prompt/v1';
export const SUNO_PROMPT_LLM_SCHEMA_ID = 'x3lius.suno-prompt-llm/v1';
const SUNO_WRITTEN = {
  title: str('Track title'),
  style: str('The "Style of Music" field'),
  excludeStyles: arr(str('A style to exclude (negative prompt)')),
};
export const SUNO_PROMPT_LLM_SCHEMA = obj({ ...SUNO_WRITTEN, ...TRACEABILITY });
export const SUNO_PROMPT_SCHEMA = obj({
  sunoModel: str('Target Suno model version, e.g. v5'),
  ...SUNO_WRITTEN,
  lyrics: str('The lyrics field, rendered from the lyrics artifact(s)'),
  sources: arr(obj({ role: { type: 'string', enum: ['lyrics', 'structure', 'genre-style'] }, artifactId: str(), schemaId: str(), version: int('Artifact version') })),
  limits: arr(obj({ field: str(), max: int('Canonical limit'), actual: int('Measured length'), ref: str('Claim ref stating the limit') })),
  ...TRACEABILITY,
});

/** schema id → schema: what write_artifact accepts. */
export const ARTIFACT_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  [SONG_STRUCTURE_SCHEMA_ID]: SONG_STRUCTURE_SCHEMA,
  [LYRICS_V1_SCHEMA_ID]: LYRICS_V1_SCHEMA,
  [LYRICS_SCHEMA_ID]: LYRICS_SCHEMA,
  [COMPOSITION_SCHEMA_ID]: COMPOSITION_SCHEMA,
  [GENRE_STYLE_SCHEMA_ID]: GENRE_STYLE_SCHEMA,
  [SUNO_PROMPT_SCHEMA_ID]: SUNO_PROMPT_SCHEMA,
};
