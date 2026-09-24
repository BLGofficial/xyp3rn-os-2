import { readArtifact, sourceOf, withoutTrace, type ArtifactSource } from './artifacts.ts';
import {
  ARRANGEMENT_LLM_SCHEMA, ARRANGEMENT_LLM_SCHEMA_ID, ARRANGEMENT_SCHEMA, ARRANGEMENT_SCHEMA_ID, PRODUCTION_LLM_SCHEMA, PRODUCTION_LLM_SCHEMA_ID,
  PRODUCTION_SCHEMA, PRODUCTION_SCHEMA_ID, SONG_STRUCTURE_SCHEMA_ID,
} from './schemas.ts';
import { VOICE_MODULE, type CreativeSpec } from './types.ts';

/**
 * Phase 11 Creative specs on the shared program (ARCHITECTURE F10: single-class agents, no hybrid).
 * - Arrangement (x3lius-arrangement): section order, energy, instrumentation and transitions,
 *   optionally against a song-structure artifact, whose section ids, kinds and bars it then follows.
 * - Production (x3lius-production): drums, sound design and the FL Studio project layout, optionally
 *   for an arrangement artifact. It reads the Production and Arrangement modules, so FL Studio
 *   project conventions arrive as canonical rules, never as constants here.
 */

type Upstream = { readonly source: ArtifactSource<string> | null; readonly body: Record<string, unknown> | null };

/**
 * `{ request, <field>? }`: the brief, plus the upstream artifact named by `field` when given.
 * @returns a prepare that reads it (refusing another kind) and hands it to the model without its trace
 */
const withUpstream = (field: string, schemaId: string, role: string, label: string): NonNullable<CreativeSpec['prepare']> => async (ctx, input) => {
  const request = input.request;
  if (typeof request !== 'string' || request.trim() === '') throw new Error('request must be a non-empty string');
  const id = input[field];
  if (id === undefined) return { brief: request, userSections: [], state: { source: null, body: null } satisfies Upstream };
  if (typeof id !== 'string') throw new Error(`${field} must be an artifact id (a uuid string)`);
  const a = await readArtifact(ctx, id, [schemaId]);
  return {
    brief: request,
    userSections: [`${label} (artifact ${a.id} v${a.version})\n${JSON.stringify(withoutTrace(a.body))}`],
    state: { source: sourceOf(role, a), body: a.body } satisfies Upstream,
  };
};

type ArrangedSection = { readonly sectionId: string; readonly kind: string; readonly bars: number; readonly energy: number };
type StructureSection = { readonly id: string; readonly kind: string; readonly bars: number };

export const ARRANGEMENT_SPEC: CreativeSpec = {
  schemaId: ARRANGEMENT_SCHEMA_ID,
  schema: ARRANGEMENT_SCHEMA,
  llmSchema: { id: ARRANGEMENT_LLM_SCHEMA_ID, schema: ARRANGEMENT_LLM_SCHEMA },
  task: 'Arrange the song the brief asks for, section by section in song order: its length in bars, its energy, the elements playing (instrument or sound, and what each does) and how the song moves into it. When a SONG STRUCTURE is given, cover exactly its sections, in its order, under its section ids.',
  prepare: withUpstream('structureArtifactId', SONG_STRUCTURE_SCHEMA_ID, 'structure', 'SONG STRUCTURE'),
  // The structure is the source of truth for which sections exist: ids must match in order, and kind
  // and bars are copied from it (as whole-song lyrics do), so the arrangement can't drift from it.
  finalize: (reply, p) => {
    const up = p.state as Upstream;
    const sections = reply.sections as ArrangedSection[];
    if (!up.source) return { body: { ...reply, sources: [] }, violations: [] };
    const structure = up.body!.sections as StructureSection[];
    const got = sections.map((s) => s.sectionId);
    const want = structure.map((s) => s.id);
    // Compared one by one: ids are free text, so two different lists can join to the same string.
    const follows = got.length === want.length && got.every((id, i) => id === want[i]);
    const byId = new Map(structure.map((s) => [s.id, s]));
    return {
      body: { ...reply, sections: sections.map((s) => ({ ...s, kind: byId.get(s.sectionId)?.kind ?? s.kind, bars: byId.get(s.sectionId)?.bars ?? s.bars })), sources: [up.source] },
      violations: follows ? [] : [`sections [${got.join(', ')}] do not follow the song structure [${want.join(', ')}] in order`],
    };
  },
  check: (b) => {
    const sections = b.sections as ArrangedSection[];
    const ids = sections.map((s) => s.sectionId);
    return [
      ...(sections.length === 0 ? ['sections must not be empty'] : []),
      ...(new Set(ids).size === ids.length ? [] : [`section ids repeat: ${ids.join(', ')}`]),
      ...sections.filter((s) => !(s.energy >= 1 && s.energy <= 10)).map((s) => `section ${s.sectionId}: energy ${s.energy} is outside 1–10`),
      ...sections.filter((s) => !(s.bars > 0)).map((s) => `section ${s.sectionId}: bars must be positive`),
    ];
  },
};

type Channel = { readonly name: string; readonly mixerTrack: number };

export const PRODUCTION_SPEC: CreativeSpec = {
  schemaId: PRODUCTION_SCHEMA_ID,
  schema: PRODUCTION_SCHEMA,
  llmSchema: { id: PRODUCTION_LLM_SCHEMA_ID, schema: PRODUCTION_LLM_SCHEMA },
  task: 'Produce the track the brief asks for: the tempo, each drum element (its sound and pattern), each non-drum sound (its source and processing chain), and the FL Studio project layout — Channel Rack channels, each routed to a mixer track, and the mixer tracks with their effect chains. When an ARRANGEMENT is given, produce the elements it uses.',
  modules: ['x3lius-production', 'x3lius-arrangement', VOICE_MODULE],
  prepare: withUpstream('arrangementArtifactId', ARRANGEMENT_SCHEMA_ID, 'arrangement', 'ARRANGEMENT'),
  // An arrangement that uses elements can't yield an empty production. Which production element
  // covers which arrangement element is not code-checked: names vary ("hi-hats" / "hi-hat") and
  // some elements (a lead vocal) aren't made in drums or sound design.
  finalize: (reply, p) => {
    const up = p.state as Upstream;
    const used = up.body ? (up.body.sections as { elements: unknown[] }[]).reduce((n, s) => n + s.elements.length, 0) : 0;
    const fl = reply.flStudio as { channels: unknown[] };
    const violations = used === 0 ? [] : [
      ...((reply.drums as unknown[]).length + (reply.soundDesign as unknown[]).length === 0 ? [`the arrangement lists ${used} element(s), but drums and soundDesign are both empty`] : []),
      ...(fl.channels.length === 0 ? [`the arrangement lists ${used} element(s), but flStudio.channels is empty`] : []),
    ];
    return { body: { ...reply, sources: up.source ? [up.source] : [] }, violations };
  },
  check: (b) => {
    const fl = b.flStudio as { channels: Channel[]; mixerTracks: { track: number }[] };
    const tracks = fl.mixerTracks.map((t) => t.track);
    return [
      ...((b.tempoBpm as number) > 0 ? [] : ['tempoBpm must be positive']),
      ...(new Set(tracks).size === tracks.length ? [] : [`mixer track numbers repeat: ${tracks.join(', ')}`]),
      ...tracks.filter((t) => t < 0).map((t) => `mixer track ${t} is negative`),
      ...fl.channels.filter((c) => !tracks.includes(c.mixerTrack)).map((c) => `channel "${c.name}" routes to mixer track ${c.mixerTrack}, which mixerTracks does not list`),
    ];
  },
};
