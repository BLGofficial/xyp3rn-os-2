import { arr, int, num, obj, str, type JsonSchema } from '../../../core/llm/json-schema.ts';
import { TRACE_ANALYSIS_SCHEMA } from '../../../tech/trace/analysis.ts';

/**
 * Output contracts of the Phase 8 Creative agents. Structured on purpose: the Phase 12 Critic
 * diffs an artifact against a rubric field by field, which a prose blob would not allow. Every
 * schema ends with the same traceability pair — which canonical rules shaped the output, and
 * which decisions no rule covered — so thin knowledge shows up in the artifact, not just a log.
 *
 * Nothing here describes an artist's voice: languages are free ISO codes, not a fixed list, and
 * every stylistic choice is left to the canonical rules the agent is given at run time.
 */

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
// No label here: code derives each section's Suno tag from its kind (the model wrote section ids
// as tags live). Directions give production notes a place outside the sung bars (seen live too).
const SECTION_WRITTEN = {
  bars: arr(BAR, 'Only the words that are sung or spoken'),
  rhymeScheme: str('The pattern across this section’s bars, e.g. AABB'),
  devices: arr(obj({ bar: int('Bar number within this section'), device: str('Named technique, e.g. internal rhyme'), note: str('Where and how it is used') })),
  directions: arr(str('A production or performance note for this section (instruments, effects, a fade): never sung, so never a bar')),
};
const SECTION_ID = str('The id of the SONG STRUCTURE section this covers (e.g. v1); a short id of your own when no structure is given');
const INSTRUMENTAL = arr(str('Id of a SONG STRUCTURE section that has no vocals'));
const LYRICS_WRITTEN = {
  sections: arr(obj({ sectionId: SECTION_ID, kind: SECTION_KIND, ...SECTION_WRITTEN }), 'In song order'),
  instrumental: INSTRUMENTAL,
};
export const LYRICS_LLM_SCHEMA = obj({ ...LYRICS_WRITTEN, ...TRACEABILITY });
export const LYRICS_SECTION_LLM_SCHEMA = obj({
  instrumental: { type: 'boolean', description: 'true when this section has no vocals; bars is then empty' },
  ...SECTION_WRITTEN,
  ...TRACEABILITY,
});
export const LYRICS_SCHEMA = obj({
  sections: arr(obj({
    sectionId: SECTION_ID,
    kind: SECTION_KIND,
    label: str('The section tag Suno sees, derived by code from the kind, e.g. "Verse 1", "Chorus"'),
    ...SECTION_WRITTEN,
  }), 'In song order'),
  instrumental: INSTRUMENTAL,
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

// Phase 11: arrangement and production (LLM, code adds `sources`), and the Mix/Master report
// (deterministic: a TRACE analysis checked against the canonical rubric claims).
const upstream = (role: string, description: string) =>
  arr(obj({ role: { type: 'string', enum: [role] }, artifactId: str(), schemaId: str(), version: int('Artifact version') }), description);

export const ARRANGEMENT_SCHEMA_ID = 'x3lius.arrangement/v1';
export const ARRANGEMENT_LLM_SCHEMA_ID = 'x3lius.arrangement-llm/v1';
const ARRANGEMENT_WRITTEN = {
  sections: arr(obj({
    sectionId: SECTION_ID,
    kind: SECTION_KIND,
    bars: int('Length in bars'),
    energy: int('Relative intensity, from 1 (sparsest) to 10 (fullest)'),
    elements: arr(obj({ element: str('An instrument or sound, e.g. 808, hi-hats, pad, lead vocal'), role: str('What it plays or does in this section') })),
    transitionIn: str('How the song moves into this section (e.g. riser, drop-out, fill); "none" for the first'),
  }), 'In song order'),
};
export const ARRANGEMENT_LLM_SCHEMA = obj({ ...ARRANGEMENT_WRITTEN, ...TRACEABILITY });
export const ARRANGEMENT_SCHEMA = obj({ ...ARRANGEMENT_WRITTEN, sources: upstream('structure', 'The song structure followed; empty when none was given'), ...TRACEABILITY });

export const PRODUCTION_SCHEMA_ID = 'x3lius.production/v1';
export const PRODUCTION_LLM_SCHEMA_ID = 'x3lius.production-llm/v1';
const PRODUCTION_WRITTEN = {
  tempoBpm: num('Beats per minute'),
  drums: arr(obj({ element: str('e.g. kick, 808, snare, hi-hat, percussion'), sound: str('How it should sound and how it is made'), pattern: str('Rhythm and programming notes') })),
  soundDesign: arr(obj({ element: str('A non-drum sound, e.g. bass, lead, pad'), source: str('The synth, sample or recording it comes from'), processing: arr(str('One processing step, in chain order')) })),
  flStudio: obj({
    channels: arr(obj({ name: str('Channel Rack name'), generator: str('Plugin or sampler that makes the sound'), mixerTrack: int('Mixer track it is routed to: one of mixerTracks') })),
    mixerTracks: arr(obj({ track: int('Mixer track number'), name: str('Mixer track name'), effects: arr(str('Effect plugin, in slot order')) })),
  }, 'The FL Studio project layout'),
};
export const PRODUCTION_LLM_SCHEMA = obj({ ...PRODUCTION_WRITTEN, ...TRACEABILITY });
export const PRODUCTION_SCHEMA = obj({ ...PRODUCTION_WRITTEN, sources: upstream('arrangement', 'The arrangement produced; empty when none was given'), ...TRACEABILITY });

export const MIX_REPORT_SCHEMA_ID = 'x3lius.mix-report/v1';
const RUBRIC_BOUND: JsonSchema = { type: 'object', properties: { min: num('Lowest value in range'), max: num('Highest value in range') }, required: [], additionalProperties: false };
export const MIX_REPORT_SCHEMA = obj({
  stage: { type: 'string', enum: ['mix', 'master'] },
  analysis: TRACE_ANALYSIS_SCHEMA,
  checks: arr(obj({
    metric: str('trace.analysis/v1 metric id'),
    unit: str(),
    measured: num('The analysis value'),
    rubric: RUBRIC_BOUND,
    action: { type: 'string', enum: ['keep', 'raise', 'lower'] },
    by: num('How far to move it to reach the nearest bound, in unit (0 when kept)'),
    ref: str('The rubric claim: canonical_prompts:<id>#<topic>'),
    version: int('Version of that canonical row'),
  }), 'One per metric the rubric bounds, in contract order'),
  unset: arr(str('A metric no rubric claim bounds: reported, never defaulted')),
});

/** schema id → schema: what write_artifact accepts. */
export const ARTIFACT_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  [SONG_STRUCTURE_SCHEMA_ID]: SONG_STRUCTURE_SCHEMA,
  [LYRICS_V1_SCHEMA_ID]: LYRICS_V1_SCHEMA,
  [LYRICS_SCHEMA_ID]: LYRICS_SCHEMA,
  [COMPOSITION_SCHEMA_ID]: COMPOSITION_SCHEMA,
  [GENRE_STYLE_SCHEMA_ID]: GENRE_STYLE_SCHEMA,
  [SUNO_PROMPT_SCHEMA_ID]: SUNO_PROMPT_SCHEMA,
  [ARRANGEMENT_SCHEMA_ID]: ARRANGEMENT_SCHEMA,
  [PRODUCTION_SCHEMA_ID]: PRODUCTION_SCHEMA,
  [MIX_REPORT_SCHEMA_ID]: MIX_REPORT_SCHEMA,
};
