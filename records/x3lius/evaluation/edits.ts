import { SUNO_PROMPT_SCHEMA_ID } from '../creative/schemas.ts';
import { measureSunoText } from '../suno/formula.ts';
import { getAt, isAtOrUnder, setAt } from './pointer.ts';
import type { Violation } from './schemas.ts';

/** One edit as the Revision model proposes it (x3lius.revision-llm/v1). */
export type Edit = { readonly path: string; readonly replacement: string; readonly violationKeys: readonly string[] };

/** Fields code owns in every body (the trace and the upstream record): never a revision's to edit. */
const DERIVED_ALL: readonly RegExp[] = [/^\/sources(\/|$)/, /^\/rulesApplied(\/|$)/, /^\/ungroundedChoices(\/|$)/];
/** Per schema: a Suno prompt's lyrics are rendered from the lyrics artifacts and its limits are measured. */
const DERIVED: Readonly<Record<string, readonly RegExp[]>> = {
  [SUNO_PROMPT_SCHEMA_ID]: [/^\/limits(\/|$)/, /^\/sunoModel$/, /^\/lyrics$/],
};

/** @returns true when code derives the field at `path`, so a revision may not edit it */
export const isDerived = (schemaId: string, path: string): boolean =>
  [...DERIVED_ALL, ...(DERIVED[schemaId] ?? [])].some((re) => re.test(path));

/** The replacement as a value of the current field's type, or the reason it isn't one. */
const convert = (current: unknown, replacement: string): { readonly value: unknown } | { readonly why: string } => {
  if (typeof current === 'string') return { value: replacement };
  const t = replacement.trim();
  if (typeof current === 'number') return t !== '' && Number.isFinite(Number(t)) ? { value: Number(t) } : { why: `"${replacement}" is not a number` };
  if (typeof current === 'boolean') return t === 'true' ? { value: true } : t === 'false' ? { value: false } : { why: `"${replacement}" is not true or false` };
  return { why: 'replaces an object or list, not a text, number or true/false field' };
};

/**
 * Applies a revision's edits to a copy of the body, or refuses the lot (spec §6). An edit must cite
 * violations of this critique, name an existing field that code doesn't derive, sit at or inside a
 * field a violation points to, keep the field's type, change something, not empty a text field, and
 * not repeat a field.
 * @param schemaId - the artifact's schema id (for derived fields)
 * @param body - the reviewed version's body
 * @param edits - the model's edits
 * @param violations - the critique's violations
 * @returns the edited body (a copy)
 * @throws Error `revision refused: …` naming every refused edit; nothing is applied
 */
export const applyEdits = (schemaId: string, body: Record<string, unknown>, edits: readonly Edit[], violations: readonly Violation[]): Record<string, unknown> => {
  if (edits.length === 0) throw new Error('revision refused: no edits: nothing to revise');
  const known = new Set(violations.map((v) => v.key));
  const refusals: string[] = [];
  const planned: { path: string; value: unknown }[] = [];
  const firstEdit = new Map<string, number>();
  edits.forEach((e, i) => {
    const refuse = (why: string) => refusals.push(`edit ${i} (${e.path}) ${why}`);
    const unknown = e.violationKeys.find((k) => !known.has(k));
    if (e.violationKeys.length === 0) return refuse('cites no violation');
    if (unknown !== undefined) return refuse(`cites ${unknown}, which is not a violation of this critique`);
    const at = getAt(body, e.path);
    if (!at.found) return refuse('names no field of the artifact');
    if (isDerived(schemaId, e.path)) return refuse('targets a field code derives');
    if (!violations.some((v) => isAtOrUnder(e.path, v.path))) return refuse('is not at or inside a field a violation points to');
    const c = convert(at.value, e.replacement);
    if ('why' in c) return refuse(c.why);
    if (c.value === at.value) return refuse('changes nothing');
    // Deleting the words would make the Critic's quote vanish and read as a fix (a sung bar left empty).
    if (typeof at.value === 'string' && at.value.trim() !== '' && String(c.value).trim() === '') return refuse('empties a text field: rewrite it, do not delete it');
    const prior = firstEdit.get(e.path);
    if (prior !== undefined) return refuse(`repeats a field edit ${prior} changes`);
    firstEdit.set(e.path, i);
    planned.push({ path: e.path, value: c.value });
  });
  if (refusals.length > 0) throw new Error(`revision refused: ${refusals.join('; ')}`);
  return planned.reduce((doc, p) => setAt(doc, p.path, p.value), body);
};

/**
 * Recomputes what a body stores about its own fields after edits. Today: a Suno prompt's measured
 * lengths (`limits[].actual`), from the edited text.
 * @returns the body with derived fields refreshed (the same object when the schema has none)
 */
export const rederive = (schemaId: string, body: Record<string, unknown>): Record<string, unknown> => {
  if (schemaId !== SUNO_PROMPT_SCHEMA_ID) return body;
  const measured = measureSunoText(body);
  return { ...body, limits: (body.limits as { field: string }[]).map((l) => ({ ...l, actual: measured[l.field] })) };
};
