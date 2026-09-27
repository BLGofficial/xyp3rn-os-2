import { basename, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DOMAIN_META, DOMAINS, isDomain, type Domain } from '../../core/contracts/taxonomy.ts';

/**
 * What the file index may read and who owns what it reads (AOS-04 Plan C1, design §15.2 items 1–3).
 * The exclusions are counted by rule and never listed by name: a secret's filename is itself information.
 */

type Rule = 'vcs' | 'dependencies' | 'build-output' | 'runtime-state' | 'credentials' | 'backups';

// Directories never entered, at any depth. `.vault` holds the Vault's bytes, which are indexed as Vault files
// (by `sources` id), not as repository files.
const EXCLUDED_DIRS: Readonly<Record<string, Rule>> = {
  '.git': 'vcs',
  node_modules: 'dependencies',
  '.next': 'build-output',
  dist: 'build-output',
  coverage: 'build-output',
  '.local-db': 'runtime-state',
  '.local-models': 'runtime-state',
  '.vault': 'runtime-state',
};

// `.env.example` included: C1 has no rule that proves an example holds no value, so it stays out.
const EXCLUDED_FILES: readonly (readonly [RegExp, Rule])[] = [
  [/^\.env(\..*)?$/, 'credentials'],
  [/\.(pem|key|p12|pfx)$/i, 'credentials'],
  [/^id_(rsa|ed25519|ecdsa|dsa)/, 'credentials'],
  [/^\.(npmrc|netrc)$/, 'credentials'],
  [/\.tsbuildinfo$/, 'build-output'],
  [/(\.bak|\.orig|~)$/, 'backups'],
];

/**
 * The exclusion rule a path falls under.
 * @param rel - the path relative to its root ('/'-separated)
 * @param isDir - whether it is a directory
 * @returns the rule's name, or null when the path is eligible
 */
export const excludedBy = (rel: string, isDir: boolean): Rule | null => {
  const name = basename(rel);
  if (isDir) return EXCLUDED_DIRS[name] ?? null;
  return EXCLUDED_FILES.find(([re]) => re.test(name))?.[1] ?? null;
};

/**
 * The database's `indexed_files_path_check`, in JS: a path the index can hold. A legal filename that fails it
 * (a backslash, a leading drive letter) is counted as an unsupported path, never inserted or named.
 * @param p - a root-relative path
 * @returns true when the path is relative, '/'-separated and has no '.', '..' or empty segment
 */
export const validIndexPath = (p: string): boolean =>
  p !== '' && !p.startsWith('/') && !p.includes('\\') && !/^[A-Za-z]:/.test(p) && !/(^|\/)\.{1,2}(\/|$)/.test(p)
  && !p.includes('//') && !p.endsWith('/') && !/[\x00-\x1f\x7f]/.test(p);

export type Basis = 'frontmatter' | 'manifest' | 'domain-path' | 'shared';
export type Ownership = { readonly domain: Domain | null; readonly basis: Basis };

/**
 * A file's registered owner, read from its own text: an agent's frontmatter `domain`, a module manifest's `domain`.
 * @param rel - the path relative to its root
 * @param text - the file's text
 * @returns the registration, or null when the file registers nothing (or its registration doesn't parse)
 */
export const declaredOwner = (rel: string, text: string): { readonly domain: Domain; readonly basis: 'frontmatter' | 'manifest' } | null => {
  try {
    if (rel.endsWith('.agent.md')) {
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      const domain = fm ? (parseYaml(fm[1]!) as { domain?: unknown } | null)?.domain : undefined;
      return isDomain(domain) ? { domain, basis: 'frontmatter' } : null;
    }
    if (rel.endsWith('.manifest.yaml')) {
      const domain = (parseYaml(text) as { domain?: unknown } | null)?.domain;
      return isDomain(domain) ? { domain, basis: 'manifest' } : null;
    }
  } catch {
    return null;
  }
  return null;
};

/**
 * Who owns a file (§15.2 item 3): its registration first, then the taxonomy's domain directories, else Shared.
 * `docs/`, `apps/`, `tests/`, `supabase/`, `scripts/`, `agents/` without frontmatter and root files stay Shared.
 * @param rel - the path relative to its root
 * @param declared - the file's registration (declaredOwner), or null
 * @returns the owning domain (null = Shared/Unassigned) and the basis
 */
export const ownerOf = (rel: string, declared: { readonly domain: Domain; readonly basis: 'frontmatter' | 'manifest' } | null): Ownership => {
  if (declared) return declared;
  const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : null;
  const domain = DOMAINS.find((d) => DOMAIN_META[d].dir === top);
  return domain ? { domain, basis: 'domain-path' } : { domain: null, basis: 'shared' };
};

/** Text above this size is hashed and indexed as metadata only (plan choice 4). */
export const TEXT_LIMIT = 1_048_576;

const MIME: Readonly<Record<string, string>> = {
  '.ts': 'text/x-typescript', '.tsx': 'text/x-typescript', '.mts': 'text/x-typescript', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.cjs': 'text/javascript', '.json': 'application/json', '.md': 'text/markdown', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.sql': 'application/sql', '.css': 'text/css', '.html': 'text/html', '.txt': 'text/plain', '.sh': 'text/x-shellscript', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.woff2': 'font/woff2',
};

/**
 * @param rel - a path
 * @returns its MIME type by extension, or null when the extension is unknown
 */
export const mimeOf = (rel: string): string | null => MIME[extname(rel).toLowerCase()] ?? null;

/**
 * Whether bytes are text the index may read: not a known binary type and no NUL byte in the first 8 KiB.
 * @param bytes - the file's bytes
 * @param mime - its MIME type (mimeOf)
 * @returns true for text
 */
export const isText = (bytes: Uint8Array, mime: string | null): boolean => {
  if (mime && /^(image\/(?!svg)|audio\/|video\/|font\/|application\/pdf)/.test(mime)) return false;
  return !bytes.subarray(0, 8192).includes(0);
};
