import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The web app's one door into the OS (AOS-01 spike result): OS modules are imported at run time,
 * outside the webpack bundle, so Node runs them natively (.ts via type stripping, import.meta.dirname,
 * the repo's own node_modules). The app never re-implements an OS module; it only calls them.
 * @param rel - repo-relative module path, e.g. `core/db/client.ts`
 * @returns the module
 */
export const osImport = <T>(rel: string): Promise<T> =>
  import(/* webpackIgnore: true */ pathToFileURL(join(process.cwd(), '..', '..', rel)).href) as Promise<T>;
