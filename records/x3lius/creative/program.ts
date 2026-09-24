import type { ClaimBundle, ContextBundle } from '../../../core/context-engine/context-engine.ts';
import type { LlmProgram } from '../../../core/llm/runner.ts';
import { loadMusicSystem } from '../music-system.ts';
import { SUNO_FORMULA_SPEC } from '../suno/formula.ts';
import { LYRICS_SPEC } from './lyrics.ts';
import { ARRANGEMENT_SPEC, PRODUCTION_SPEC } from './production.ts';
import {
  COMPOSITION_SCHEMA, COMPOSITION_SCHEMA_ID, GENRE_STYLE_SCHEMA, GENRE_STYLE_SCHEMA_ID, SONG_STRUCTURE_SCHEMA, SONG_STRUCTURE_SCHEMA_ID,
} from './schemas.ts';
import { mixedScriptWords, type MixedScriptWord } from './script-check.ts';
import { CLAIM_NAMESPACE, isModelAgnostic, MIN_SCOPED_RULES, VOICE_MODULE, type ContextEntry, type CreativeSpec, type ModelCall, type Prepared } from './types.ts';

export { CLAIM_NAMESPACE, MIN_SCOPED_RULES, VOICE_MODULE } from './types.ts';

/**
 * X3LIUS Creative agents: Songwriting, Lyrics, Composition (Phase 8), Genre/Style and the Suno
 * Prompt-Formula (Phase 9), Arrangement and Production (Phase 11). One program, one spec per sub-domain.
 *
 * Every run: derive the brief → pull canonical rules from the spec's modules (scoped Context
 * Engine, current versions only) plus canonical claims (exact topic lookup) → drop entries that
 * don't apply to this run → measure how much knowledge is left → ask the model for a
 * schema-shaped reply built only from those rules → validate shape, refs and semantics → append
 * the artifact → return it.
 *
 * The voice is never in this file (ARCHITECTURE.md invariant 5): it arrives as data at run time,
 * so a rule the Research → Promotion Gate path adds changes the next output with no code change.
 */

const SPECS: Readonly<Record<string, CreativeSpec>> = {
  'x3lius-songwriting': {
    schemaId: SONG_STRUCTURE_SCHEMA_ID,
    schema: SONG_STRUCTURE_SCHEMA,
    task: 'Design the song the brief asks for: its theme, its section structure (kind, length in bars, purpose of each section) and its hook. Offer at least two hook candidates, then select one and say why.',
    check: (b) => {
      const hook = b.hook as { candidates: unknown[]; selectedIndex: number };
      const n = hook.candidates.length;
      return [
        ...(n < 2 ? [`hook.candidates has ${n}; at least 2 are required`] : []),
        ...(hook.selectedIndex >= 0 && hook.selectedIndex < n ? [] : [`hook.selectedIndex ${hook.selectedIndex} is not one of ${n} candidate(s)`]),
      ];
    },
  },
  'x3lius-lyrics': LYRICS_SPEC,
  'x3lius-composition': {
    schemaId: COMPOSITION_SCHEMA_ID,
    schema: COMPOSITION_SCHEMA,
    task: 'Make the harmony and melody decisions the brief asks for: key and mode, tempo, time signature, a chord progression per section, and the melody (its range, contour and recurring motif).',
    check: (b) => [
      ...((b.tempoBpm as number) > 0 ? [] : ['tempoBpm must be positive']),
      ...((b.progressions as { chords: unknown[] }[]).some((p) => p.chords.length === 0) ? ['every progression needs at least one chord'] : []),
    ],
  },
  'x3lius-genre-style': {
    schemaId: GENRE_STYLE_SCHEMA_ID,
    schema: GENRE_STYLE_SCHEMA,
    task: 'Set the genre and style target for the brief: the primary genre, subgenres, a tempo range, mood words, the sound palette (element and how it should sound), reference descriptors (describe sounds; never name an artist, song or album) and what to avoid.',
    check: (b) => {
      const t = b.tempoBpm as { min: number; max: number };
      return t.min > 0 && t.min <= t.max ? [] : [`tempoBpm must satisfy 0 < min <= max, got ${t.min}–${t.max}`];
    },
  },
  'x3lius-suno': SUNO_FORMULA_SPEC,
  'x3lius-arrangement': ARRANGEMENT_SPEC,
  'x3lius-production': PRODUCTION_SPEC,
};

export const CREATIVE_SUBDOMAINS: readonly string[] = Object.keys(SPECS);

export type KnowledgeReport = {
  readonly sparse: boolean;
  readonly threshold: number;
  readonly scopedRules: number;
  readonly perModule: Readonly<Record<string, number>>;
  readonly voiceClaims: number;
  readonly reasons: readonly string[];
};

/** What the artifact records per entry. Rule text is left out: the ref names an immutable canonical version. */
const contextRef = (e: ContextEntry) =>
  e.kind === 'rule'
    ? { kind: e.kind, ref: e.ref, module: e.module, slug: e.slug, title: e.title, modelTag: e.modelTag, score: e.score, why: e.why, source: e.source }
    : { kind: e.kind, ref: e.ref, module: e.module, slug: e.slug, topic: e.topic, value: e.value, modelScope: e.modelScope, source: e.source };

const normalizeRef = (ref: string): string => ref.trim().replace(/^\[(.*)\]$/, '$1').trim();

/**
 * Maps a cited ref to a given one. Exact refs pass; otherwise a claim topic or rule slug is
 * accepted only when exactly one given entry carries it (models abbreviate refs — seen live).
 * Anything else is returned unchanged, so the exact-match check refuses it.
 */
const resolveRef = (cited: string, entries: readonly ContextEntry[]): string => {
  const ref = normalizeRef(cited);
  if (entries.some((e) => e.ref === ref)) return ref;
  const byAlias = entries.filter((e) => (e.kind === 'claim' ? e.topic === ref : e.slug === ref));
  return byAlias.length === 1 ? byAlias[0]!.ref : ref;
};

const render = (v: unknown): string => (Array.isArray(v) ? v.map(render).join(', ') : typeof v === 'string' ? v : JSON.stringify(v));

const promptLine = (e: ContextEntry): string =>
  e.kind === 'rule'
    ? `[${e.ref}] ${e.slug ?? e.title} (${e.module}): ${e.text}`
    : `[${e.ref}] ${e.topic} = ${render(e.value)} (claim in ${e.slug}, ${e.module})`;

const systemPrompt = (title: string, slug: string, spec: CreativeSpec, entries: readonly ContextEntry[]): string => [
  `You are the ${title} agent of the X3LIUS Music System (sub-domain ${slug}).`,
  '',
  'TASK',
  spec.task,
  '',
  'CANONICAL RULES',
  'These are the only source of the artist’s voice and style. Each starts with its ref in brackets.',
  ...(entries.length > 0 ? entries.map(promptLine) : ['(none: the canonical knowledge base holds no rule for this sub-domain yet)']),
  '',
  'HOW TO USE THEM',
  '- Voice, style, tone and language choices must come from CANONICAL RULES. Do not add traits they do not state.',
  '- In rulesApplied, list every rule you applied, with its full ref copied exactly as shown inside the brackets (it starts with "canonical_prompts:"), and how it shaped the output.',
  '- In ungroundedChoices, list every creative decision no rule covers. When the rules are thin this list is long; that is expected, not a failure.',
  // Text integrity, not style: seen live in 4 of 4 long outputs (F22).
  '- Write every word in a single alphabet: never mix Latin and Cyrillic letters inside one word.',
  '- Reply with JSON only, matching the response schema.',
].join('\n');

const knowledgeReport = (slug: string, modules: readonly string[], perModule: Record<string, number>, claims: readonly ContextEntry[], excluded: number, spec: CreativeSpec): KnowledgeReport => {
  const scopedRules = Object.values(perModule).reduce((a, b) => a + b, 0);
  const sparse = scopedRules < MIN_SCOPED_RULES;
  const voice = claims.filter((c) => c.kind === 'claim' && c.topic.startsWith(CLAIM_NAMESPACE));
  const topics = [...new Set(voice.map((c) => (c.kind === 'claim' ? c.topic : '')))];
  return {
    sparse,
    threshold: MIN_SCOPED_RULES,
    scopedRules,
    perModule,
    voiceClaims: voice.length,
    reasons: [
      ...Object.entries(perModule).map(([m, n]) => `${m}: ${n} rules on the scoped context path`),
      voice.length > 0
        ? `voice: ${voice.length} claim(s) under ${CLAIM_NAMESPACE}* from outside the sub-domain scope (${topics.join(', ')})`
        : `voice: no canonical claim under ${CLAIM_NAMESPACE}*`,
      ...(excluded > 0 ? [`excluded ${excluded} canonical ${excluded === 1 ? 'entry' : 'entries'} ${spec.exclusionReason ?? (spec.admit ? 'that do not apply to this run' : 'scoped to a specific model or tool')}`] : []),
      ...(sparse
        ? [`fewer than ${MIN_SCOPED_RULES} scoped rules: expect output close to generic. Promote rules tagged ${modules.filter((m) => m !== slug).length > 0 ? `${slug} or ${modules.filter((m) => m !== slug).join(' / ')}` : slug} through the gate to change that.`]
        : []),
    ],
  };
};

const defaultPrepare = async (_ctx: unknown, input: Record<string, unknown>): Promise<Prepared> => {
  const request = input.request;
  if (typeof request !== 'string' || request.trim() === '') throw new Error('request must be a non-empty string');
  return { brief: request, userSections: [], state: null };
};

/**
 * Builds the program for one creative sub-domain.
 * @param slug - sub-domain module slug, which is also the agent name
 * @returns the LlmProgram run by the shared LLM runner
 */
const creativeProgram = (slug: string): LlmProgram => {
  const spec = SPECS[slug]!;
  const modules = spec.modules ?? [slug, VOICE_MODULE];
  const namespaces = spec.claimNamespaces ?? [CLAIM_NAMESPACE];
  const llmSchema = spec.llmSchema ?? { id: spec.schemaId, schema: spec.schema };
  return async (ctx, input, llm) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('input must be an object');
    const sub = loadMusicSystem().subdomains.find((s) => s.slug === slug);
    if (!sub) throw new Error(`${slug} is not an X3LIUS sub-domain in the manifest`);
    const prepared = await (spec.prepare ?? defaultPrepare)(ctx, input as Record<string, unknown>);

    // One scoped read per module, so each count is exact and one module can't crowd out another.
    const pulled: { entry: ContextEntry; module: string | null }[] = [];
    for (const module of modules) {
      const bundle = (await ctx.useTool('retrieve_context', { query: prepared.brief, scope: { modules: [module] } })) as ContextBundle;
      for (const r of bundle.items.filter((i) => i.ref.table === 'canonical_prompts')) {
        pulled.push({ module, entry: { kind: 'rule', ref: `canonical_prompts:${r.ref.id}`, module, slug: r.slug, title: r.title, text: r.text, modelTag: r.modelTag, score: r.score, why: r.why, source: r.source } });
      }
    }
    const seen = new Set<string>();
    for (const prefix of namespaces) {
      const claims = (await ctx.useTool('retrieve_claims', { topicPrefix: prefix })) as ClaimBundle;
      for (const c of claims.items) {
        const ref = `canonical_prompts:${c.ref.id}#${c.topic}`;
        if (seen.has(ref)) continue;
        seen.add(ref);
        pulled.push({ module: null, entry: { kind: 'claim', ref, module: c.module, slug: c.slug, title: c.title, topic: c.topic, value: c.value, modelScope: c.modelScope, source: c.source } });
      }
    }

    const kept = pulled.filter((p) => (spec.admit ? spec.admit(p.entry, prepared) : isModelAgnostic(p.entry)));
    const entries = kept.map((p) => p.entry);
    const perModule = Object.fromEntries(modules.map((m) => [m, kept.filter((p) => p.module === m).length]));
    const knowledge = knowledgeReport(slug, modules, perModule, entries, pulled.length - kept.length, spec);
    await ctx.useTool('log_message', { message: `${slug}: context pulled: ${entries.length > 0 ? entries.map((e) => e.ref).join(', ') : 'none'}` });
    if (knowledge.sparse) await ctx.useTool('log_message', { level: 'warn', message: `${slug}: SPARSE canonical knowledge — ${knowledge.reasons.join(' | ')}` });

    const system = systemPrompt(sub.title, slug, spec, entries);
    const call: ModelCall = (extra, schema = llmSchema) => llm.complete({
      system,
      user: [`BRIEF\n${prepared.brief}`, ...prepared.userSections, ...extra].join('\n\n'),
      schema: { name: schema.id, schema: schema.schema },
      signal: ctx.signal,
    });
    const log = async (message: string, level: 'info' | 'warn' = 'info') => {
      await ctx.useTool('log_message', { level, message: `${slug}: ${message}` });
    };
    const res = spec.generate ? await spec.generate(call, prepared, log) : await call([]);
    // Models copy refs loosely (brackets, bare topics — seen live with Nemotron): resolve to a given
    // ref when that is unambiguous, then require an exact match.
    const raw = res.json as Record<string, unknown>;
    const reply = { ...raw, rulesApplied: (raw.rulesApplied as { ref: string; how: string }[]).map((r) => ({ ...r, ref: resolveRef(r.ref, entries) })) };

    const given = new Set(entries.map((e) => e.ref));
    const unknown = reply.rulesApplied.map((r) => r.ref).filter((r) => !given.has(r));
    if (unknown.length > 0) throw new Error(`${slug} reply cites refs it was not given: ${unknown.join(', ')}`);
    const { body, violations } = spec.finalize?.(reply, prepared, entries) ?? { body: reply, violations: [] };
    // Checked on the final body, so text code copies in from upstream (the Suno lyrics) is covered too.
    const explain = (w: MixedScriptWord) => `mixed-script word "${w.word}" at ${w.path} (Latin and Cyrillic letters in one word)`;
    const toSuno = (w: MixedScriptWord) => (spec.sunoTextPaths ?? []).some((p) => p.test(w.path));
    const mixed = mixedScriptWords(body);
    const soft = mixed.filter((w) => !toSuno(w));
    const all = [...violations, ...(spec.check?.(body) ?? []), ...mixed.filter(toSuno).map(explain)];
    if (all.length > 0) throw new Error(`${slug} reply failed checks: ${all.join('; ')}`);
    const warnings = soft.map((w) => ({ kind: 'mixed-script', word: w.word, path: w.path }));
    if (soft.length > 0) await ctx.useTool('log_message', { level: 'warn', message: `${slug}: written with warnings — ${soft.map(explain).join('; ')}` });

    const context = entries.map(contextRef);
    const written = (await ctx.useTool('write_artifact', {
      schemaId: spec.schemaId, brief: prepared.brief, body, contextRefs: context, knowledge, model: ctx.agent.model, warnings,
    })) as { artifact_id: string; lineage_id: string; version: number };

    return {
      output: {
        subdomain: slug,
        status: 'generated',
        artifact: { id: written.artifact_id, lineageId: written.lineage_id, version: written.version, schemaId: spec.schemaId },
        body,
        knowledge,
        warnings,
        context,
        model: { ref: ctx.agent.model, served: res.model },
        usage: res.usage,
      },
      tokensUsed: res.usage.inputTokens + res.usage.outputTokens,
    };
  };
};

/** Agent name → program, for the shared LLM runner (core/runtime/programs.ts). */
export const CREATIVE_PROGRAMS: Readonly<Record<string, LlmProgram>> = Object.fromEntries(CREATIVE_SUBDOMAINS.map((s) => [s, creativeProgram(s)]));
