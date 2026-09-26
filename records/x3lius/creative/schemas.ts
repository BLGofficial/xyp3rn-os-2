import { arr, int, num, obj, str, type JsonSchema } from '../../../core/llm/json-schema.ts';
import { TRACE_ANALYSIS_SCHEMA } from '../../../tech/trace/analysis.ts';
import { TRACE_CHECK_SCHEMA } from '../../../tech/trace/report.ts';

/**
 * Output contracts of the Phase 8 Creative agents. Structured on purpose: the Phase 12 Critic
 * diffs an artifact against a rubric field by field, which a prose blob would not allow. Every
 * schema ends with the same traceability pair — which canonical rules shaped the output, and
 * which decisions no rule covered — so thin knowledge shows up in the artifact, not just a log.
 *
 * Nothing here describes an artist's voice: languages are free ISO codes, not a fixed list, and
 * every stylistic choice is left to the canonical rules the agent is given at run time.
 */

/** Every section kind a structure, a lyric version or a meta-tag set (AOS-03) may name, in this order. */
export const SECTION_KINDS = ['intro', 'verse', 'pre-chorus', 'chorus', 'post-chorus', 'hook', 'bridge', 'breakdown', 'outro'] as const;
const SECTION_KIND: JsonSchema = { type: 'string', enum: SECTION_KINDS };
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
// The analysis and each check are the TRACE contract's own schemas (tech/trace), never copies (Phase 14).
export const MIX_REPORT_SCHEMA = obj({
  stage: { type: 'string', enum: ['mix', 'master'] },
  analysis: TRACE_ANALYSIS_SCHEMA,
  checks: arr(TRACE_CHECK_SCHEMA, 'One per metric the rubric bounds, in contract order'),
  unset: arr(str('A metric no rubric claim bounds: reported, never defaulted')),
});

// AOS-03 (S1): the owner's Studio records, versioned and approved like lyrics. Code writes them from
// the owner's input, so the traceability pair records "owner-authored" rather than rules.
const upstreamOf = (role: string) => obj({ role: { type: 'string', enum: [role] }, artifactId: str(), schemaId: str(), version: int('Artifact version') });
export const STYLE_RECIPE_SCHEMA_ID = 'x3lius.style-recipe/v1';
export const STYLE_RECIPE_SCHEMA = obj({
  name: str('The recipe’s name'),
  style: str('The "Style of Music" field, sent to Suno verbatim'),
  excludeStyles: arr(str('A style to exclude, sent to Suno verbatim')),
  mood: arr(str('A mood word; never sent to Suno')),
  production: arr(str('A production direction note; never sent to Suno')),
  notes: arr(str('A tested note: what worked and what did not; never sent to Suno')),
  sources: arr(upstreamOf('suno-prompt'), 'The model-written formula it was seeded from; empty when the owner wrote it'),
  ...TRACEABILITY,
});

// AOS-03 (S2): section tags as a versioned record. The default set is the code labels (sectionLabels).
export const META_TAG_SET_SCHEMA_ID = 'x3lius.meta-tag-set/v1';
export const META_TAG_SET_SCHEMA = obj({
  name: str('The tag set’s name'),
  sections: arr(obj({
    kind: SECTION_KIND,
    label: str('The section tag, e.g. "Chorus"'),
    numbered: { type: 'boolean', description: 'Occurrences are numbered in song order, e.g. "Verse 1", "Verse 2"' },
    cues: arr(str('A vocal, performance or arrangement tag rendered after the label, e.g. "Whispered"')),
  }), 'One entry per section kind it covers'),
  notes: arr(str('A usage note; never sent to Suno')),
  ...TRACEABILITY,
});

// AOS-03 (S3): the Suno prompt package. Code builds it from one lyric, one style recipe and one tag set
// version (x3lius-suno-package); submitting it requires each to be approved (S4, the DB gate).
export const SUNO_PACKAGE_SCHEMA_ID = 'x3lius.suno-package/v1';
export const SUNO_PACKAGE_SCHEMA = obj({
  sunoModel: str('Target Suno model version, e.g. v5'),
  title: str('Track title'),
  style: str('The "Style of Music" field: the recipe’s, verbatim'),
  excludeStyles: arr(str('A style to exclude: the recipe’s, verbatim')),
  lyrics: str('The lyrics field: the lyric version rendered with the tag set'),
  sources: arr(obj({ role: { type: 'string', enum: ['lyrics', 'style-recipe', 'meta-tag-set'] }, artifactId: str(), schemaId: str(), version: int('Artifact version') }),
    'Exactly one of each role'),
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
  [ARRANGEMENT_SCHEMA_ID]: ARRANGEMENT_SCHEMA,
  [PRODUCTION_SCHEMA_ID]: PRODUCTION_SCHEMA,
  [MIX_REPORT_SCHEMA_ID]: MIX_REPORT_SCHEMA,
  [STYLE_RECIPE_SCHEMA_ID]: STYLE_RECIPE_SCHEMA,
  [META_TAG_SET_SCHEMA_ID]: META_TAG_SET_SCHEMA,
  [SUNO_PACKAGE_SCHEMA_ID]: SUNO_PACKAGE_SCHEMA,
};
