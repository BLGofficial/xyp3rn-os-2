import { LYRICS_SCHEMA_ID, SUNO_PROMPT_SCHEMA_ID } from '../creative/schemas.ts';
import type { ContextEntry } from '../creative/types.ts';
import type { MixCheck } from '../mix-master/agent.ts';
import { LIMIT_TOPIC, measureSunoText } from '../suno/formula.ts';
import { violationKey, type CheckedRule, type Violation } from './schemas.ts';

/**
 * The Critic's code checks (spec §5.2): rules with a structured value code can compare. Every other
 * rule goes to the model. Each check reuses the phase that owns the value, so there is one way to
 * measure it.
 */

export type CodeCheckResult = { readonly rules: readonly CheckedRule[]; readonly violations: readonly Violation[] };

/** Where each measured Suno field lives in a x3lius.suno-prompt/v1 body. */
const SUNO_FIELD_PATH: Readonly<Record<string, string>> = { title: '/title', style: '/style', 'exclude-styles': '/excludeStyles', lyrics: '/lyrics' };
const excerpt = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : String(v)).slice(0, 200);

export const BLACKLIST_TOPIC = 'lyrics.word-blacklist';

/** A blacklist term as a whole-word, case-insensitive pattern; `[x]` stands for any one word. */
const termPattern = (term: string): string =>
  `\\b${term.trim().split(/\s+/).map((w) => (w === '[x]' ? "[\\p{L}\\p{N}'’]+" : w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('\\s+')}\\b`;

/**
 * The lyrics word blacklist (`lyrics.word-blacklist` = `{ maxHits, terms }`): counts hits across every
 * sung bar. Overlapping hits count once, longest first ("lost in darkness" is one hit, not "lost" too).
 * Over maxHits, each bar with a hit is a violation quoting its first hit.
 */
const blacklistCheck = (e: ContextEntry & { kind: 'claim' }, body: Record<string, unknown>): CodeCheckResult | null => {
  const v = e.value as { maxHits?: unknown; terms?: unknown };
  if (!Number.isInteger(v?.maxHits) || !Array.isArray(v.terms) || !v.terms.every((t) => typeof t === 'string' && t.trim() !== '')) return null;
  const terms = (v.terms as string[]).map((t) => new RegExp(termPattern(t), 'giu'));
  const bars = ((body.sections ?? []) as { bars?: { text?: unknown }[] }[]).flatMap((s, i) =>
    (s.bars ?? []).map((b, j) => ({ path: `/sections/${i}/bars/${j}/text`, text: typeof b.text === 'string' ? b.text : '' })));
  const hits = bars.map((b) => {
    const found = terms.flatMap((re) => [...b.text.matchAll(re)].map((m) => ({ at: m.index, end: m.index + m[0].length, text: m[0] })))
      .sort((x, y) => x.at - y.at || y.end - x.end);
    const kept: typeof found = [];
    for (const h of found) if (!kept.some((k) => h.at < k.end && k.at < h.end)) kept.push(h);
    return { path: b.path, words: kept.map((h) => h.text) };
  }).filter((b) => b.words.length > 0);
  const total = hits.reduce((n, b) => n + b.words.length, 0);
  const max = v.maxHits as number;
  return {
    rules: [{ ref: e.ref, kind: 'claim', method: 'code' }],
    violations: total <= max ? [] : hits.map((b) => ({
      key: violationKey(e.ref, b.path), ruleRef: e.ref, method: 'code' as const, path: b.path, quote: b.words[0]!,
      expected: `at most ${max} blacklisted words or phrases in the song (${BLACKLIST_TOPIC})`,
      found: `${total} in the song; here: ${b.words.map((w) => `"${w}"`).join(', ')}`,
    })),
  };
};

/**
 * Code checks for the entries that have one: `suno.limit.<field>-chars` claims on a Suno prompt,
 * measured from the text itself (never from the stored `limits`, which a later rule change leaves
 * stale), and the `lyrics.word-blacklist` claim on lyrics.
 * @param schemaId - the artifact's schema id
 * @param entries - rules and claims in force for it
 * @param body - the artifact body
 * @returns the code-checked rules and the violations among them
 */
export const codeChecks = (schemaId: string, entries: readonly ContextEntry[], body: Record<string, unknown>): CodeCheckResult => {
  if (schemaId === LYRICS_SCHEMA_ID) {
    const r = entries.flatMap((e) => (e.kind === 'claim' && e.topic === BLACKLIST_TOPIC ? [blacklistCheck(e, body)] : [])).filter((x) => x !== null);
    return { rules: r.flatMap((x) => x.rules), violations: r.flatMap((x) => x.violations) };
  }
  if (schemaId !== SUNO_PROMPT_SCHEMA_ID) return { rules: [], violations: [] };
  const measured = measureSunoText(body);
  const rules: CheckedRule[] = [];
  const violations: Violation[] = [];
  for (const e of entries) {
    const m = e.kind === 'claim' ? LIMIT_TOPIC.exec(e.topic) : null;
    if (!m || e.kind !== 'claim' || !Number.isInteger(e.value) || !(m[1]! in measured)) continue;
    rules.push({ ref: e.ref, kind: 'claim', method: 'code' });
    const field = m[1]!;
    const max = e.value as number;
    const actual = measured[field]!;
    if (actual <= max) continue;
    const path = SUNO_FIELD_PATH[field]!;
    violations.push({
      key: violationKey(e.ref, path), ruleRef: e.ref, method: 'code', path,
      quote: excerpt(body[path.slice(1)]), expected: `at most ${max} characters (${e.topic})`, found: `${actual} characters`,
    });
  }
  return { rules, violations };
};

/**
 * A mix report's own checks as the Critic's rules (spec §5.1): each bounded metric is a rule with
 * its claim ref and version, and each raise/lower is a violation. An `unset` metric has no check.
 * @param body - a x3lius.mix-report/v1 body
 * @returns rules and violations, all found by code
 */
export const mixReportChecks = (body: Record<string, unknown>): CodeCheckResult => {
  const checks = body.checks as MixCheck[];
  const range = (c: MixCheck) => [c.rubric.min !== undefined ? `≥ ${c.rubric.min}` : null, c.rubric.max !== undefined ? `≤ ${c.rubric.max}` : null].filter(Boolean).join(' and ');
  return {
    rules: checks.map((c) => ({ ref: c.ref, kind: 'claim' as const, method: 'code' as const, version: c.version })),
    violations: checks.flatMap((c, i) => (c.action === 'keep' ? [] : [{
      key: violationKey(c.ref, `/checks/${i}`), ruleRef: c.ref, ruleVersion: c.version, method: 'code' as const, path: `/checks/${i}`,
      quote: `${c.metric} ${c.measured} ${c.unit}`, expected: `${c.metric} ${range(c)} ${c.unit}`, found: `${c.measured} ${c.unit}: ${c.action} by ${c.by}`,
    }])),
  };
};
