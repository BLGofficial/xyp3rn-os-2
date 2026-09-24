import type { AgentHandler } from '../orchestrator/dispatch.ts';

/**
 * Deterministic extractive summarizer (user decision while no ANTHROPIC_API_KEY exists).
 * For each ranked context item, picks the sentence sharing the most query terms and cites the
 * row it came from. No generation, no paraphrase — output is labelled `method: extractive`.
 * Swap for an LLM summarizer when the key exists; the output shape stays the same.
 */

// Function words that carry no topical signal. Content words are never listed here.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'was', 'were',
  'who', 'what', 'which', 'how', 'when', 'where', 'why', 'can', 'could', 'do', 'does', 'did', 'it', 'its',
  'as', 'at', 'by', 'from', 'that', 'this', 'these', 'those', 'you', 'your', 'we', 'our', 'any', 'all',
]);

const tokens = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
/** Minimal plural folding so "prompts" matches "prompt"; nothing cleverer, on purpose. */
const fold = (t: string): string => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);

export type SummaryItem = {
  readonly ref: { readonly table: string; readonly id: string };
  readonly slug?: string | null;
  readonly title?: string;
  readonly snippet: string;
  /** Full row text when the caller has it; preferred over the display snippet. */
  readonly text?: string;
  readonly score: number;
};

// Structural lines in prompt bodies ("CONTEXT", "TASK", "{{PRIOR_PHASE_SUMMARY}}") are
// boundaries, never content.
const HEADER_LINE = /^(?:[A-Z][A-Z0-9 /+&>—-]*|\{\{[A-Z_]+\}\})$/;
const LIST_MARKER = /^(?:\d+\.|[-•])\s+/;

/**
 * Splits text into complete sentences, verbatim apart from whitespace: header lines break
 * units, list items start new units, wrapped lines are joined with a space. A fragment that
 * doesn't end in . ! ? or : (e.g. a snippet cut off with "…") is not a sentence.
 */
const sentencesOf = (text: string): string[] => {
  const units: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur.trim()) units.push(cur.trim());
    cur = '';
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || HEADER_LINE.test(line)) {
      flush();
      continue;
    }
    if (LIST_MARKER.test(line)) {
      flush();
      cur = line.replace(LIST_MARKER, '');
    } else {
      cur = cur ? `${cur} ${line}` : line;
    }
  }
  flush();
  return units.flatMap((u) => u.split(/(?<=[.!?])\s+/)).filter((sentence) => /[.!?:]$/.test(sentence));
};

export type ExtractiveSummary = {
  readonly method: 'extractive';
  readonly query: string;
  readonly bullets: ReadonlyArray<{
    readonly text: string;
    readonly cite: { readonly table: string; readonly id: string; readonly slug: string | null; readonly score: number };
    readonly matchedTerms: readonly string[];
  }>;
  readonly itemsConsidered: number;
  readonly note: string;
};

const isItem = (v: unknown): v is SummaryItem => {
  const o = v as SummaryItem;
  return !!o && typeof o === 'object' && !!o.ref && typeof o.ref.table === 'string' && typeof o.ref.id === 'string' && typeof o.snippet === 'string';
};

/**
 * Builds the summary.
 * @param query - the question being answered
 * @param items - ranked context items (Context Engine order)
 * @param maxBullets - stop after this many cited sentences
 * @returns cited sentences, best-matching sentence per item, in rank order
 * @throws Error when items isn't a list of context items
 */
export const summarizeExtractive = (query: string, items: readonly SummaryItem[], maxBullets: number): ExtractiveSummary => {
  if (!Array.isArray(items) || !items.every(isItem)) throw new Error('items must be an array of context items');
  const queryTerms = [...new Set(tokens(query))];
  const bullets: ExtractiveSummary['bullets'][number][] = [];

  for (const item of items) {
    if (bullets.length >= maxBullets) break;
    const sentences = sentencesOf(item.text ?? item.snippet);
    let best: { text: string; matched: string[] } | undefined;
    for (const s of sentences) {
      const have = new Set(tokens(s).map(fold));
      const matched = queryTerms.filter((q) => have.has(fold(q))).sort();
      if (matched.length > 0 && (!best || matched.length > best.matched.length)) best = { text: s, matched };
    }
    if (best) {
      bullets.push({
        text: best.text,
        cite: { table: item.ref.table, id: item.ref.id, slug: item.slug ?? null, score: item.score },
        matchedTerms: best.matched,
      });
    }
  }

  return {
    method: 'extractive',
    query,
    bullets,
    itemsConsidered: items.length,
    note: 'Deterministic extractive summary: sentences quoted verbatim from cited rows, no LLM. Replaced by an LLM summarizer once ANTHROPIC_API_KEY is configured.',
  };
};

/** Default cap: enough to cover the direct hits without restating the whole bundle. */
export const DEFAULT_MAX_BULLETS = 5;

/**
 * Handler for agents/extractive-summarizer.agent.md.
 * @param ctx - run context
 * @param input - `{ query, items, maxBullets? }`
 * @returns the extractive summary
 */
export const extractiveSummarizer: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as { query?: unknown; items?: unknown; maxBullets?: unknown };
  if (typeof i.query !== 'string') throw new Error('query must be a string');
  const summary = summarizeExtractive(i.query, i.items as SummaryItem[], typeof i.maxBullets === 'number' ? i.maxBullets : DEFAULT_MAX_BULLETS);
  await ctx.useTool('log_message', { message: `extractive summary: ${summary.bullets.length} cited sentence(s) from ${summary.itemsConsidered} item(s)` });
  return { output: summary, tokensUsed: 0 };
};
