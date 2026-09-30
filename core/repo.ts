import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
/** Server/CLI deployment root. Never accepts a path from an HTTP request. */
export const REPO_ROOT = process.env.XYP_REPO_ROOT ?? [process.cwd(), resolve(process.cwd(), '../..')].find(p => existsSync(resolve(p, 'core/contracts/taxonomy.ts'))) ?? process.cwd();
