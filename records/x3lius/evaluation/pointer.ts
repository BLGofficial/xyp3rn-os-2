/**
 * JSON Pointer (RFC 6901) over artifact bodies: how a critique names a field and a revision edits
 * one. "/a/0/b"; inside a segment "~1" is "/" and "~0" is "~". The root "" is never a field, and a
 * JSONPath ("$.a") is not a pointer.
 */

const segments = (pointer: string): string[] | null =>
  pointer.startsWith('/') ? pointer.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')) : null;

const INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * @param doc - parsed JSON
 * @param pointer - JSON Pointer
 * @returns the value there, or `{ found: false }` for a malformed pointer, the root or any missing step
 */
export const getAt = (doc: unknown, pointer: string): { readonly found: true; readonly value: unknown } | { readonly found: false } => {
  const segs = segments(pointer);
  if (!segs) return { found: false };
  let cur: unknown = doc;
  for (const s of segs) {
    if (Array.isArray(cur)) {
      if (!INDEX.test(s) || Number(s) >= cur.length) return { found: false };
      cur = cur[Number(s)];
    } else if (cur !== null && typeof cur === 'object' && Object.hasOwn(cur, s)) {
      cur = (cur as Record<string, unknown>)[s];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
};

/**
 * @param doc - parsed JSON
 * @param pointer - JSON Pointer of an existing field
 * @param value - its new value
 * @returns a deep copy of `doc` with that field replaced
 * @throws Error when the field doesn't exist (a revision never adds fields)
 */
export const setAt = <T>(doc: T, pointer: string, value: unknown): T => {
  if (!getAt(doc, pointer).found) throw new Error(`no field at ${pointer}`);
  const copy = structuredClone(doc);
  const segs = segments(pointer)!;
  let cur = copy as unknown as Record<string, unknown>;
  for (const s of segs.slice(0, -1)) cur = cur[s] as Record<string, unknown>;
  cur[segs.at(-1)!] = value;
  return copy;
};

/** @returns true when `pointer` is `parent` or a field inside it */
export const isAtOrUnder = (pointer: string, parent: string): boolean => pointer === parent || pointer.startsWith(`${parent}/`);

/** @returns every string at or under a value, depth first */
export const stringsIn = (value: unknown): string[] =>
  typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.flatMap(stringsIn)
      : value !== null && typeof value === 'object' ? Object.values(value).flatMap(stringsIn)
        : [];

/** @returns every number and true/false at or under a value, as its JSON text (140 → "140"), depth first */
export const scalarsIn = (value: unknown): string[] =>
  typeof value === 'number' || typeof value === 'boolean' ? [String(value)]
    : Array.isArray(value) ? value.flatMap(scalarsIn)
      : value !== null && typeof value === 'object' ? Object.values(value).flatMap(scalarsIn)
        : [];
