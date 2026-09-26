import type { ContextBundle } from '../../core/context-engine/context-engine.ts';
import { arr, num, obj, str, type JsonSchema } from '../../core/llm/json-schema.ts';
import type { LlmProgram } from '../../core/llm/runner.ts';

/**
 * The 20 Research specialists' one program (AOS-04 R4). Deterministic steps around one model call:
 *   passages   canonical rows from retrieve_context that trace to an ingested source (citable through it)
 *              + the brief's URLs via fetch_source (the model never supplies a URL); capped at PASSAGE_BUDGET chars
 *   no sources no model call; the specialist declines (it never asserts from model memory)
 *   one call   the agent's own Role, Scope and Refuses as the system prompt; claims must quote a passage
 *   write      each claim through write_evidence; the DB verifies the quote verbatim. A claim that fails a
 *              check or the write is declined with the reason, never written.
 */

export const SPECIALISTS = [
  'ai-vocal-systems-researcher', 'artist-identity-researcher', 'benchmark-scoring-methodology-researcher', 'brand-persona-consistency-researcher',
  'composition-arrangement-researcher', 'evaluation-researcher', 'frontier-tool-scanner-researcher', 'genre-style-researcher',
  'lyrics-rhyme-systems-researcher', 'mix-master-ai-tooling-researcher', 'model-version-changelog-researcher', 'negative-prompt-failure-mode-researcher',
  'prompt-engineering-researcher', 'prompt-formula-template-researcher', 'release-strategy-platform-algo-researcher', 'rights-licensing-researcher',
  'songwriting-structure-researcher', 'suno-researcher', 'udio-alt-platform-researcher', 'voice-cloning-researcher',
] as const;

export const SPECIALIST_SCHEMA_ID = 'research.specialist-claims/v1';
/** Passage text handed to the model, in chars: about one full page plus a few canonical rows. */
export const PASSAGE_BUDGET = 24_000;
const TOPIC = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;
const MODEL_TAG = /^[a-z0-9][a-z0-9.-]*$/;

export const SPECIALIST_SCHEMA: JsonSchema = obj({
  claims: arr(obj({
    passage: num('The number of the passage the quote is from, as given in brackets'),
    quote: str('Copied verbatim from that passage: the exact words, no paraphrase, no ellipsis'),
    claim: str('What the quote shows, in one sentence, within your scope'),
    claim_topic: str('Dotted kebab topic, e.g. suno.vocal-descriptor-position'),
    claim_value: str('The claim\'s value as JSON text, e.g. "\\"first\\"", "true", "3"'),
    model_tag: str('<tool>-<version> the quote was observed on (e.g. suno-v5), or model-agnostic'),
    confidence: num('0 to 1'),
    confidence_inputs: obj({
      basis: str('Why this confidence'),
      directness: { type: 'string', enum: ['direct', 'inferred'], description: 'Does the quote state the claim, or is it inferred?' },
    }),
  })),
  declined: arr(obj({ reason: str('Why a relevant claim was not made (e.g. out of scope, no passage supports it)') })),
});

type Passage = { readonly n: number; readonly title: string; readonly text: string; readonly cite: { research_source_id: string } | { canonical_prompt_id: string } };
type Claim = { passage: number; quote: string; claim: string; claim_topic: string; claim_value: string; model_tag: string; confidence: number; confidence_inputs: { basis: string; directness: string } };
export type Declined = { readonly claim?: string; readonly reason: string };
export type SpecialistOutput = {
  readonly status: 'done' | 'no-sources';
  readonly evidenceIds: readonly string[];
  readonly declined: readonly Declined[];
  readonly failedUrls: readonly { url: string; reason: string }[];
  readonly passages: number;
};

const RULES = `RULES
- Answer only within your Scope. Decline what belongs to another specialist.
- Every claim quotes one numbered passage VERBATIM: copy the exact words; no paraphrase, no ellipsis, no changed quotation marks.
- One claim per quote. No claim without a passage. Context marked NOT CITABLE is background only.
- claim_topic is dotted kebab (a.b-c); claim_value is JSON text; model_tag is <tool>-<version> or model-agnostic.
- Confidence reflects the passage: a vendor's own page is a claim, a measured observation is stronger.`;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
// "suno-researcher" → "Suno Researcher", the way the agent file's H1 names it.
const titleOf = (name: string): string => name.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

/**
 * @param ctx - run context: retrieve_context, fetch_source, write_evidence, log_message
 * @param input - the brief: `{ question, intendedUse?, urls? }` (optional inputs arrive as null)
 * @param llm - the model client for the agent's frontmatter model (R1)
 * @returns evidence ids written, declined claims with reasons, failed URLs, passages given
 */
export const specialistProgram: LlmProgram = async (ctx, input, llm) => {
  const i = (input ?? {}) as { question?: unknown; intendedUse?: unknown; urls?: unknown };
  if (typeof i.question !== 'string' || i.question.trim() === '') throw new Error(`${ctx.agent.name}: question must be a non-empty string`);
  const intendedUse = typeof i.intendedUse === 'string' && i.intendedUse.trim() !== '' ? i.intendedUse.trim() : null;
  const urls = Array.isArray(i.urls) ? i.urls.filter((u): u is string => typeof u === 'string') : [];

  const passages: Passage[] = [];
  const context: string[] = [];
  const failedUrls: { url: string; reason: string }[] = [];
  let used = 0;
  let dropped = 0;
  const add = (title: string, text: string, cite: Passage['cite']) => {
    if (used + text.length > PASSAGE_BUDGET) {
      dropped += 1;
      return;
    }
    used += text.length;
    passages.push({ n: passages.length + 1, title, text, cite });
  };

  const bundle = (await ctx.useTool('retrieve_context', { query: i.question })) as Partial<ContextBundle>;
  for (const item of bundle.items ?? []) {
    // A canonical row is citable only through the ingested source it traces to (write_evidence refuses the rest).
    if (item.ref.table === 'canonical_prompts' && item.source) add(item.title, item.text, { canonical_prompt_id: item.ref.id });
    else context.push(`- ${item.title}: ${item.snippet}`);
  }
  for (const url of urls) {
    try {
      const page = (await ctx.useTool('fetch_source', { url })) as { research_source_id: string; title: string; uri: string; text: string };
      add(`${page.title} <${page.uri}>`, page.text, { research_source_id: page.research_source_id });
    } catch (e) {
      failedUrls.push({ url, reason: message(e) });
      await ctx.useTool('log_message', { level: 'warn', message: `${ctx.agent.name}: skipped ${url}: ${message(e)}` });
    }
  }
  if (dropped > 0) await ctx.useTool('log_message', { level: 'warn', message: `${ctx.agent.name}: ${dropped} passage(s) over the ${PASSAGE_BUDGET}-char budget dropped` });

  if (passages.length === 0) {
    const reason = `no sources: no citable canonical row matched and ${urls.length === 0 ? 'the brief lists no URL' : 'no URL could be read'}`;
    await ctx.useTool('log_message', { message: `${ctx.agent.name}: ${reason}; no model call` });
    const output: SpecialistOutput = { status: 'no-sources', evidenceIds: [], declined: [{ reason }], failedUrls, passages: 0 };
    return { output, tokensUsed: 0 };
  }

  const s = ctx.agent.sections;
  const res = await llm.complete({
    system: `You are the ${titleOf(ctx.agent.name)} (XYP3RN Research).\n## Role\n${s.Role ?? ''}\n## Scope\n${s.Scope ?? ''}\n## Refuses\n${s.Refuses ?? ''}\n\n${RULES}`,
    user: [
      `QUESTION: ${i.question.trim()}`,
      `INTENDED USE: ${intendedUse ?? 'not stated'}`,
      `PASSAGES (${passages.length}):`,
      ...passages.map((p) => `[${p.n}] ${p.title}\n${p.text}`),
      ...(context.length > 0 ? ['CONTEXT (NOT CITABLE):', ...context] : []),
    ].join('\n\n'),
    schema: { name: SPECIALIST_SCHEMA_ID, schema: SPECIALIST_SCHEMA },
    signal: ctx.signal,
  });
  const reply = res.json as { claims: Claim[]; declined: { reason: string }[] };

  const evidenceIds: string[] = [];
  const declined: Declined[] = reply.declined.map((d) => ({ reason: `model: ${d.reason}` }));
  for (const c of reply.claims) {
    const p = passages.find((x) => x.n === c.passage);
    let value: unknown;
    let reason: string | null =
      !p ? `passage ${c.passage} is not one of the ${passages.length} given`
        : c.quote.trim() === '' ? 'quote is blank'
          : !TOPIC.test(c.claim_topic) ? `claim_topic ${JSON.stringify(c.claim_topic)} is not dotted kebab`
            : !MODEL_TAG.test(c.model_tag) ? `model_tag ${JSON.stringify(c.model_tag)} is not <tool>-<version> or model-agnostic`
              : !(c.confidence >= 0 && c.confidence <= 1) ? `confidence ${c.confidence} is outside [0, 1]`
                : null;
    if (!reason) {
      try {
        value = JSON.parse(c.claim_value);
      } catch {
        reason = `claim_value is not JSON: ${c.claim_value}`;
      }
    }
    if (reason) {
      declined.push({ claim: c.claim, reason });
      continue;
    }
    try {
      const w = (await ctx.useTool('write_evidence', {
        ...p!.cite, quote: c.quote, claim: c.claim, claim_topic: c.claim_topic, claim_value: value, model_tag: c.model_tag,
        confidence: c.confidence, confidence_inputs: { ...c.confidence_inputs, passage: p!.n },
      })) as { evidence_id: string };
      evidenceIds.push(w.evidence_id);
    } catch (e) {
      declined.push({ claim: c.claim, reason: message(e) });
    }
  }
  await ctx.useTool('log_message', {
    message: `${ctx.agent.name}: ${passages.length} passage(s); ${evidenceIds.length} claim(s) written, ${declined.length} declined, ${failedUrls.length} URL(s) failed`,
  });
  const output: SpecialistOutput = { status: 'done', evidenceIds, declined, failedUrls, passages: passages.length };
  return { output, tokensUsed: res.usage.inputTokens + res.usage.outputTokens };
};
