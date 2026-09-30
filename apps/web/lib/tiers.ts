import { isSkillName, matchSkill, type SkillName } from './skills';

/**
 * Deterministic tier selection for Mercury requests (no model call). First match wins:
 * explicit or spoken skill (1) → explicit deep trigger (3) → question about stored data (2) → planRequest.
 * Tier 2 needs both a question opener and a data-about-existing-work noun (spec: latest, last,
 * status, pending, findings, releases, approvals, or "what did"); bare research/run/workflow
 * mentions alone still go to the domain agents.
 *
 * Skill and deep tiers run Claude Code headless (`apps/web/lib/claude-headless.ts`), which inherits
 * `childEnv`'s stripped ANTHROPIC_API_KEY: with the claude-code engine off, that leaves every
 * Anthropic agent a skill run touches with no credentials at all. `opts.engine` (the caller's
 * `LLM_ENGINE === 'claude-code'` check) gates them: off, a spoken skill name or "Claude," is just
 * text (falls through to lookup/plan); an explicit skill or `deep: true` is refused outright.
 */
export type Tier =
  | { readonly kind: 'skill'; readonly skill: SkillName; readonly text: string }
  | { readonly kind: 'deep'; readonly text: string }
  | { readonly kind: 'lookup' }
  | { readonly kind: 'plan' }
  | { readonly kind: 'invalid-skill' }
  | { readonly kind: 'engine-off' };

const DEEP = /^\s*claude\s*[,:]\s+(\S[\s\S]*)$/i;
const QUESTION = /^\s*(what|which|how many|how much|is|are|did|was|were|show|list|any|status)\b/i;
const DATA = /\b(latest|last|status|pending|findings?|releases?|approvals?)\b|\bwhat did\b/i;

export const selectTier = (text: string, opts: { readonly skill?: unknown; readonly deep?: boolean; readonly engine?: boolean } = {}): Tier => {
  if (opts.skill !== undefined) return opts.engine !== true ? { kind: 'engine-off' } : isSkillName(opts.skill) ? { kind: 'skill', skill: opts.skill, text } : { kind: 'invalid-skill' };
  const spoken = opts.engine === true ? matchSkill(text) : undefined;
  if (spoken) return { kind: 'skill', ...spoken };
  if (opts.deep) return opts.engine === true ? { kind: 'deep', text } : { kind: 'engine-off' };
  const deep = opts.engine === true ? DEEP.exec(text) : null;
  if (deep) return { kind: 'deep', text: deep[1]!.trim() };
  if (QUESTION.test(text) && DATA.test(text)) return { kind: 'lookup' };
  return { kind: 'plan' };
};
