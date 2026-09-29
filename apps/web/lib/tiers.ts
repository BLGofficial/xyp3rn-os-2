import { isSkillName, matchSkill, type SkillName } from './skills';

/**
 * Deterministic tier selection for Mercury requests (no model call). First match wins:
 * explicit or spoken skill (1) → explicit deep trigger (3) → question about stored data (2) → planRequest.
 * Tier 2 needs both a question opener and a data noun, so creative requests that mention
 * "latest" or "release" still go to the domain agents.
 */
export type Tier =
  | { readonly kind: 'skill'; readonly skill: SkillName; readonly text: string }
  | { readonly kind: 'deep'; readonly text: string }
  | { readonly kind: 'lookup' }
  | { readonly kind: 'plan' }
  | { readonly kind: 'invalid-skill' };

const DEEP = /^\s*claude\s*[,:]\s+(\S[\s\S]*)$/i;
const QUESTION = /^\s*(what|which|how many|how much|is|are|did|was|were|show|list|any|status)\b/i;
const DATA = /\b(findings?|research|releases?|approvals?|runs?|workflows?|pending)\b/i;

export const selectTier = (text: string, opts: { readonly skill?: unknown; readonly deep?: boolean } = {}): Tier => {
  if (opts.skill !== undefined) return isSkillName(opts.skill) ? { kind: 'skill', skill: opts.skill, text } : { kind: 'invalid-skill' };
  const spoken = matchSkill(text);
  if (spoken) return { kind: 'skill', ...spoken };
  if (opts.deep) return { kind: 'deep', text };
  const deep = DEEP.exec(text);
  if (deep) return { kind: 'deep', text: deep[1]!.trim() };
  if (QUESTION.test(text) && DATA.test(text)) return { kind: 'lookup' };
  return { kind: 'plan' };
};
