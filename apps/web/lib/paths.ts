/**
 * A return path taken from a form, kept on this origin: `/…`, but never `//host` or `/\host`, which
 * browsers treat as another origin (an open redirect otherwise). Control characters and whitespace
 * are refused anywhere: the URL parser drops tabs and newlines, so `/\t/host` would become `//host`.
 * @param path - the submitted path
 * @param fallback - where to go instead
 * @returns path when it is local, else fallback
 */
export const local = (path: string, fallback: string): string =>
  path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') && !/[\u0000- \u007f]/.test(path) ? path : fallback;
