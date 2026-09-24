import { resolveRef } from '../creative/program.ts';
import type { ContextEntry } from '../creative/types.ts';
import { getAt, stringsIn } from './pointer.ts';
import { violationKey, type Unverified, type Violation } from './schemas.ts';

/** One violation as the Critic's model reported it (x3lius.critique-llm/v1). */
export type ReportedViolation = { readonly ruleRef: string; readonly path: string; readonly quote: string; readonly expected: string; readonly found: string };

/**
 * Keeps a model-reported violation only when code can confirm it (spec §5.3): the rule is one the
 * model was asked to judge, the path names a field of the body, and the quote appears there word for
 * word. Everything else is returned as unverified with its reason, and never counts. Two reports of
 * the same key merge.
 * @param reported - the model's violations
 * @param modelRules - the rules the model was asked to judge
 * @param codeRefs - refs code already checked (a model report against one is refused)
 * @param body - the artifact body the model saw
 * @returns verified violations and dropped reports
 */
export const verifyReported = (
  reported: readonly ReportedViolation[],
  modelRules: readonly ContextEntry[],
  codeRefs: ReadonlySet<string>,
  body: Record<string, unknown>,
): { violations: Violation[]; unverified: Unverified[] } => {
  const violations = new Map<string, Violation>();
  const unverified: Unverified[] = [];
  for (const r of reported) {
    const ref = resolveRef(r.ruleRef, modelRules);
    const at = getAt(body, r.path);
    const reason = codeRefs.has(ref) ? 'the rule is checked by code, not by the model'
      : !modelRules.some((e) => e.ref === ref) ? 'not one of the rules given'
        : !at.found ? 'the path does not name a field of the artifact'
          : r.quote.trim() === '' || !stringsIn(at.value).some((s) => s.includes(r.quote)) ? 'the quote does not appear at that path'
            : null;
    if (reason) {
      unverified.push({ ruleRef: r.ruleRef, path: r.path, quote: r.quote, reason });
      continue;
    }
    const key = violationKey(ref, r.path);
    if (!violations.has(key)) violations.set(key, { key, ruleRef: ref, method: 'model', path: r.path, quote: r.quote, expected: r.expected, found: r.found });
  }
  return { violations: [...violations.values()], unverified };
};
