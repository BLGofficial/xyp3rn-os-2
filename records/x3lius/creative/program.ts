import type { ClaimBundle, ContextBundle } from '../../../core/context-engine/context-engine.ts';
import type { JsonSchema } from '../../../core/llm/json-schema.ts';
import type { LlmProgram } from '../../../core/llm/runner.ts';
import { loadMusicSystem } from '../music-system.ts';
import {
  COMPOSITION_SCHEMA, COMPOSITION_SCHEMA_ID, LYRICS_SCHEMA, LYRICS_SCHEMA_ID, SONG_STRUCTURE_SCHEMA, SONG_STRUCTURE_SCHEMA_ID,
} from './schemas.ts';

/**
 * Phase 8 Creative agents: Songwriting, Lyrics and (F15) Composition. One program, three specs.
 *
 * Every run: pull canonical rules from the sub-domain's own module and from Vocal DNA (scoped
 * Context Engine, current versions only) plus the artist's canonical claims (exact topic lookup)
 * → measure how much knowledge that is → ask the model for a schema-shaped artifact built only
 * from those rules → validate shape, refs and semantics → append the artifact → return it.
 *
 * The voice is never in this file (ARCHITECTURE.md invariant 5): it arrives as data at run time,
 * so a rule the Research → Promotion Gate path adds changes the next output with no code change.
 */

/** Scoped rules below this count mark the artifact `sparse`: expect output close to generic. */
export const MIN_SCOPED_RULES = 3;
/** Voice rules live in Vocal DNA (Phase 7 handoff): every creative agent reads it besides its own module. */
export const VOICE_MODULE = 'x3lius-vocal-dna';
/**
 * The artist's claim namespace: canonical claim topics are `<slugified artist>.<topic>` (set by
 * the build-guide normalizer and by research claim topics). A namespace, not a voice.
 */
export const CLAIM_NAMESPACE = 'x3lius.';

type CreativeSpec = {
  readonly schemaId: string;
  readonly schema: JsonSchema;
  /** What to produce: the task's shape, never its style. */
  readonly task: string;
  /** Checks the schema subset can't express; returns violations. */
  readonly check?: (body: Record<string, unknown>) => string[];
};

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
  'x3lius-lyrics': {
    schemaId: LYRICS_SCHEMA_ID,
    schema: LYRICS_SCHEMA,
    task: 'Write the lyric section the brief asks for (one verse if it does not say), bar by bar: the words of each bar, its language and the rhyme tag it ends on, then the rhyme scheme and the devices used.',
    check: (b) => {
      const bars = b.bars as { n: number }[];
      return [
        ...(bars.length === 0 ? ['bars is empty'] : []),
        ...(bars.every((x, i) => x.n === i + 1) ? [] : ['bars[].n must count 1, 2, 3… in order']),
      ];
    },
  },
  'x3lius-composition': {
    schemaId: COMPOSITION_SCHEMA_ID,
    schema: COMPOSITION_SCHEMA,
    task: 'Make the harmony and melody decisions the brief asks for: key and mode, tempo, time signature, a chord progression per section, and the melody (its range, contour and recurring motif).',
    check: (b) => [
      ...((b.tempoBpm as number) > 0 ? [] : ['tempoBpm must be positive']),
      ...((b.progressions as { chords: unknown[] }[]).some((p) => p.chords.length === 0) ? ['every progression needs at least one chord'] : []),
    ],
  },
};

export const CREATIVE_SUBDOMAINS: readonly string[] = Object.keys(SPECS);

type ContextEntry =
  | { readonly kind: 'rule'; readonly ref: string; readonly module: string; readonly slug: string | null; readonly title: string; readonly text: string; readonly score: number; readonly why: string; readonly source: { readonly id: string; readonly uri: string } | null }
  | { readonly kind: 'claim'; readonly ref: string; readonly module: string; readonly slug: string; readonly title: string; readonly topic: string; readonly value: unknown; readonly source: { readonly id: string; readonly uri: string } | null };

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
    ? { kind: e.kind, ref: e.ref, module: e.module, slug: e.slug, title: e.title, score: e.score, why: e.why, source: e.source }
    : { kind: e.kind, ref: e.ref, module: e.module, slug: e.slug, topic: e.topic, value: e.value, source: e.source };

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
  '- In rulesApplied, list every rule you applied, with its ref copied exactly, and how it shaped the output.',
  '- In ungroundedChoices, list every creative decision no rule covers. When the rules are thin this list is long; that is expected, not a failure.',
  '- Reply with JSON only, matching the response schema.',
].join('\n');

const knowledgeReport = (slug: string, perModule: Record<string, number>, claims: ClaimBundle): KnowledgeReport => {
  const scopedRules = Object.values(perModule).reduce((a, b) => a + b, 0);
  const sparse = scopedRules < MIN_SCOPED_RULES;
  const topics = [...new Set(claims.items.map((c) => c.topic))];
  return {
    sparse,
    threshold: MIN_SCOPED_RULES,
    scopedRules,
    perModule,
    voiceClaims: claims.items.length,
    reasons: [
      ...Object.entries(perModule).map(([m, n]) => `${m}: ${n} rules on the scoped context path`),
      claims.items.length > 0
        ? `voice: ${claims.items.length} claim(s) under ${CLAIM_NAMESPACE}* from outside the sub-domain scope (${topics.join(', ')})`
        : `voice: no canonical claim under ${CLAIM_NAMESPACE}*`,
      ...(sparse
        ? [`fewer than ${MIN_SCOPED_RULES} scoped rules: expect output close to generic. Promote rules tagged ${slug} or ${VOICE_MODULE} through the gate to change that.`]
        : []),
    ],
  };
};

/**
 * Builds the program for one creative sub-domain.
 * @param slug - sub-domain module slug, which is also the agent name
 * @returns the LlmProgram run by the shared LLM runner
 */
const creativeProgram = (slug: string): LlmProgram => {
  const spec = SPECS[slug]!;
  return async (ctx, input, llm) => {
    const request = (input as { request?: unknown } | null)?.request;
    if (typeof request !== 'string' || request.trim() === '') throw new Error('request must be a non-empty string');
    const sub = loadMusicSystem().subdomains.find((s) => s.slug === slug);
    if (!sub) throw new Error(`${slug} is not an X3LIUS sub-domain in the manifest`);

    // One scoped read per module, so each count is exact and one module can't crowd out the other.
    const modules = [slug, VOICE_MODULE];
    const perModule: Record<string, number> = {};
    const entries: ContextEntry[] = [];
    for (const module of modules) {
      const bundle = (await ctx.useTool('retrieve_context', { query: request, scope: { modules: [module] } })) as ContextBundle;
      const rules = bundle.items.filter((i) => i.ref.table === 'canonical_prompts');
      perModule[module] = rules.length;
      for (const r of rules) {
        entries.push({ kind: 'rule', ref: `canonical_prompts:${r.ref.id}`, module, slug: r.slug, title: r.title, text: r.text, score: r.score, why: r.why, source: r.source });
      }
    }
    const claims = (await ctx.useTool('retrieve_claims', { topicPrefix: CLAIM_NAMESPACE })) as ClaimBundle;
    for (const c of claims.items) {
      entries.push({ kind: 'claim', ref: `canonical_prompts:${c.ref.id}#${c.topic}`, module: c.module, slug: c.slug, title: c.title, topic: c.topic, value: c.value, source: c.source });
    }

    const knowledge = knowledgeReport(slug, perModule, claims);
    await ctx.useTool('log_message', { message: `${slug}: context pulled: ${entries.length > 0 ? entries.map((e) => e.ref).join(', ') : 'none'}` });
    if (knowledge.sparse) await ctx.useTool('log_message', { level: 'warn', message: `${slug}: SPARSE canonical knowledge — ${knowledge.reasons.join(' | ')}` });

    const res = await llm.complete({
      system: systemPrompt(sub.title, slug, spec, entries),
      user: `BRIEF\n${request}`,
      schema: { name: spec.schemaId, schema: spec.schema },
      signal: ctx.signal,
    });
    const body = res.json as Record<string, unknown>;

    const given = new Set(entries.map((e) => e.ref));
    const unknown = (body.rulesApplied as { ref: string }[]).map((r) => r.ref).filter((r) => !given.has(r));
    if (unknown.length > 0) throw new Error(`${slug} reply cites refs it was not given: ${unknown.join(', ')}`);
    const violations = spec.check?.(body) ?? [];
    if (violations.length > 0) throw new Error(`${slug} reply failed checks: ${violations.join('; ')}`);

    const context = entries.map(contextRef);
    const written = (await ctx.useTool('write_artifact', {
      schemaId: spec.schemaId, brief: request, body, contextRefs: context, knowledge, model: ctx.agent.model,
    })) as { artifact_id: string; lineage_id: string; version: number };

    return {
      output: {
        subdomain: slug,
        status: 'generated',
        artifact: { id: written.artifact_id, lineageId: written.lineage_id, version: written.version, schemaId: spec.schemaId },
        body,
        knowledge,
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
