import { PROVIDERS } from '../../core/llm/providers.ts';

// FAKE MODEL for creative-agent tests (Phase 9+). It speaks both wire formats the real runner
// sends (Anthropic Messages and OpenAI-compatible chat completions), records every request, and
// answers with a schema-shaped reply whose text fields are prefixed "[FAKE]" and whose
// rulesApplied cites the first canonical ref it was given. It proves wiring, never writing.

type Json = Record<string, unknown>;
export type FakeCall = { readonly url: string; readonly system: string; readonly user: string; readonly schema: Json };

/** Every provider key set to a dummy, so the runner reaches the fake fetch whatever `model:` says. */
export const FAKE_KEYS: Readonly<Record<string, string>> = Object.fromEntries(Object.values(PROVIDERS).map((p) => [p.keyEnv, 'fake-key']));
export const FAKE_USAGE = { input: 100, output: 20 } as const;
const REF = /\[(canonical_prompts:[0-9a-f-]{36}(?:#[a-z0-9.-]+)?)\]/g;

/**
 * A schema-valid [FAKE] body for whichever creative schema a request carries.
 * @param schema - the JSON schema the request asked for
 * @param cited - refs to put in rulesApplied
 * @param user - the request's user message (a per-section lyrics call names its section there)
 * @returns the reply object
 */
export const fakeBody = (schema: Json, cited: readonly string[], user = ''): Json => {
  const props = (schema.properties ?? {}) as Json;
  const common = { rulesApplied: cited.map((ref) => ({ ref, how: '[FAKE] cited to exercise traceability' })), ungroundedChoices: ['[FAKE] everything not covered by a cited rule'] };
  if ('instrumental' in props && 'bars' in props) {
    // One section of lyrics written against a structure (x3lius.lyrics-section-llm/v2): the section named under WRITE NOW.
    const [, id = 's', kind = 'verse'] = /WRITE NOW: section (\S+) \(([a-z-]+)/.exec(user) ?? [];
    return {
      instrumental: false, rhymeScheme: 'AABB', devices: [], directions: [],
      bars: [1, 2, 3, 4].map((n) => ({ n, text: `[FAKE] ${id} bar ${n}`, language: 'en', rhymeTag: n <= 2 ? 'A' : 'B' })), ...common,
    };
  }
  if ('instrumental' in props) {
    // Whole-song lyrics (x3lius.lyrics/v2): covers the fake structure below (v1 verse, c1 chorus) in order.
    const section = (sectionId: string, kind: string) => ({
      sectionId, kind, rhymeScheme: 'AABB', devices: [], directions: [],
      bars: [1, 2, 3, 4].map((n) => ({ n, text: `[FAKE] ${sectionId} bar ${n}`, language: 'en', rhymeTag: n <= 2 ? 'A' : 'B' })),
    });
    return { sections: [section('v1', 'verse'), section('c1', 'chorus')], instrumental: [], ...common };
  }
  if ('flStudio' in props) {
    return {
      tempoBpm: 140,
      drums: [{ element: '[FAKE] 808', sound: '[FAKE]', pattern: '[FAKE]' }],
      soundDesign: [{ element: '[FAKE] lead', source: '[FAKE]', processing: ['[FAKE] eq'] }],
      flStudio: { channels: [{ name: '[FAKE] 808', generator: '[FAKE] sampler', mixerTrack: 1 }], mixerTracks: [{ track: 1, name: '[FAKE] 808 bus', effects: ['[FAKE] eq'] }] },
      ...common,
    };
  }
  if ('sections' in props && !('hook' in props)) {
    // Arrangement (x3lius.arrangement-llm/v1): covers the fake structure below (v1 verse, c1 chorus) in order.
    const section = (sectionId: string, kind: string, bars: number, energy: number) => ({ sectionId, kind, bars, energy, elements: [{ element: '[FAKE] 808', role: '[FAKE]' }], transitionIn: '[FAKE]' });
    return { sections: [section('v1', 'verse', 16, 4), section('c1', 'chorus', 8, 8)], ...common };
  }
  if ('sections' in props) {
    return {
      title: '[FAKE] Title', theme: { statement: '[FAKE] theme', perspective: 'first person' },
      sections: [{ id: 'v1', kind: 'verse', bars: 16, purpose: '[FAKE]' }, { id: 'c1', kind: 'chorus', bars: 8, purpose: '[FAKE]' }],
      hook: { candidates: [{ text: '[FAKE] hook a', language: 'en', rationale: '[FAKE]' }, { text: '[FAKE] hook b', language: 'mixed', rationale: '[FAKE]' }], selectedIndex: 0, selectionReason: '[FAKE]' },
      ...common,
    };
  }
  if ('progressions' in props) {
    return {
      key: { tonic: 'C#', mode: 'minor' }, tempoBpm: 140, timeSignature: '4/4',
      progressions: [{ section: 'verse', chords: ['C#m', 'A'], barsPerChord: 2 }],
      melody: { range: '[FAKE]', contour: '[FAKE]', motif: '[FAKE]' }, ...common,
    };
  }
  if ('primaryGenre' in props) {
    return {
      primaryGenre: '[FAKE] genre', subgenres: ['[FAKE] sub'], tempoBpm: { min: 130, max: 150 }, mood: ['[FAKE] mood'],
      soundPalette: [{ element: '[FAKE] drums', descriptor: '[FAKE]' }], referenceDescriptors: [{ descriptor: '[FAKE] descriptor', why: '[FAKE]' }],
      avoid: ['[FAKE] avoid'], ...common,
    };
  }
  if ('excludeStyles' in props) {
    return { title: '[FAKE] Suno Title', style: '[FAKE] style prompt', excludeStyles: ['[FAKE] excluded'], ...common };
  }
  throw new Error(`fake model: unknown schema ${JSON.stringify(Object.keys(props))}`);
};

/**
 * FAKE fetch for the LLM runner.
 * @param opts - `cite` picks refs from the prompt; `override` replaces the reply for a schema
 * @returns `fn` to pass as the runner's fetch, and the recorded `calls`
 */
export const fakeModel = (opts: { readonly cite?: (refs: string[]) => string[]; readonly override?: (schema: Json, refs: string[], user: string) => unknown } = {}) => {
  const calls: FakeCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body)) as Json;
    const anthropic = url.startsWith('https://api.anthropic.com');
    const messages = body.messages as { role: string; content: string }[];
    const call: FakeCall = anthropic
      ? { url, system: body.system as string, user: messages[0]!.content, schema: ((body.output_config as Json).format as Json).schema as Json }
      : { url, system: messages[0]!.content, user: messages[1]!.content, schema: ((body.response_format as Json).json_schema as Json).schema as Json };
    calls.push(call);
    const refs = [...call.system.matchAll(REF)].map((m) => m[1]!);
    const reply = opts.override?.(call.schema, refs, call.user) ?? fakeBody(call.schema, (opts.cite ?? ((r) => r.slice(0, 1)))(refs), call.user);
    const text = JSON.stringify(reply);
    const payload = anthropic
      ? { id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: { input_tokens: FAKE_USAGE.input, output_tokens: FAKE_USAGE.output } }
      : { id: 'fake', object: 'chat.completion', model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: FAKE_USAGE.input, completion_tokens: FAKE_USAGE.output } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn: fn as typeof fetch, calls };
};
