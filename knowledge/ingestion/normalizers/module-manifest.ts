import { parse as parseYaml } from 'yaml';
import { isDomain, type Domain } from '../../../core/contracts/taxonomy.ts';
import type { NormalizedDocument, NormalizedModule, NormalizedRelation } from '../types.ts';

/**
 * Module manifest normalizer (Phase 7). An operator-authored YAML file declares a parent module
 * and its sub-domains; ingestion admits them through the gate like any first-party document
 * (versioned, with history). Strict: any malformed entry fails the whole ingestion run.
 */

export const MODULE_MANIFEST_NORMALIZER_ID = 'xyp-module-manifest-v1';
const MARKER = /^manifest:\s*xyp-module-manifest\/v1\s*$/m;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ManifestModule = { readonly slug: string; readonly title: string; readonly description: string };
export type ManifestSubdomain = ManifestModule & { readonly builtIn: string | null };
export type ModuleManifest = {
  readonly title: string;
  readonly date: string;
  readonly domain: Domain;
  readonly module: ManifestModule;
  readonly subdomains: readonly ManifestSubdomain[];
};

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`module manifest: ${what} must be a non-empty string`);
  return v.trim();
};

const mod = (v: unknown, where: string): ManifestModule => {
  const o = (v ?? {}) as Record<string, unknown>;
  const slug = str(o.slug, `${where}.slug`);
  if (!SLUG.test(slug)) throw new Error(`module manifest: ${where}.slug "${slug}" is not a kebab-case slug`);
  return { slug, title: str(o.title, `${where}.title`), description: str(o.description, `${where}.description`) };
};

/**
 * Parses and validates a module manifest.
 * @param text - YAML source
 * @returns the manifest
 * @throws Error naming the first invalid field (slug, domain, duplicate, built_in, …)
 */
export const parseModuleManifest = (text: string): ModuleManifest => {
  const y = (parseYaml(text) ?? {}) as Record<string, unknown>;
  if (y.manifest !== 'xyp-module-manifest/v1') throw new Error('module manifest: manifest must be xyp-module-manifest/v1');
  const domain = y.domain;
  if (!isDomain(domain)) throw new Error(`module manifest: unknown domain ${String(domain)}`);
  const date = typeof y.date === 'string' ? y.date : y.date instanceof Date ? y.date.toISOString().slice(0, 10) : '';
  if (!DATE.test(date)) throw new Error('module manifest: date must be YYYY-MM-DD');
  if (!Array.isArray(y.subdomains) || y.subdomains.length === 0) throw new Error('module manifest: subdomains must be a non-empty list');
  const subdomains = y.subdomains.map((s, i): ManifestSubdomain => {
    const b = (s as Record<string, unknown>).built_in;
    if (b !== null && (typeof b !== 'string' || !/^\d+[A-E]?$/.test(b))) {
      throw new Error(`module manifest: subdomains[${i}].built_in must be a phase like '9' or null, got ${JSON.stringify(b)}`);
    }
    return { ...mod(s, `subdomains[${i}]`), builtIn: b };
  });
  const parent = mod(y.module, 'module');
  const seen = new Set<string>();
  for (const m of [parent, ...subdomains]) {
    if (seen.has(m.slug)) throw new Error(`module manifest: duplicate slug ${m.slug}`);
    seen.add(m.slug);
  }
  return { title: str(y.title, 'title'), date, domain, module: parent, subdomains };
};

/**
 * @param pages - extracted text; a manifest is a single text page
 * @returns true for a module manifest
 */
export const detectModuleManifest = (pages: readonly string[]): boolean => pages.length === 1 && MARKER.test(pages[0]!);

/**
 * Normalizes a manifest into modules (parent + sub-domains) and their edges. No prompts: the
 * sub-domains are registered-but-empty stubs until their phase fills them.
 * @param pages - single-page manifest text
 * @returns canonical-ready document
 */
export const normalizeModuleManifest = (pages: readonly string[]): NormalizedDocument => {
  const m = parseModuleManifest(pages[0] ?? '');
  const stubNote = (b: string | null) => (b ? `Stub until Phase ${b}.` : 'Stub: no build-guide phase implements it yet.');
  const modules: NormalizedModule[] = [
    { slug: m.module.slug, title: m.module.title, description: m.module.description, domain: m.domain },
    ...m.subdomains.map((s) => ({ slug: s.slug, title: s.title, description: `${s.description} ${stubNote(s.builtIn)}`, domain: m.domain })),
  ];
  const relations: NormalizedRelation[] = [
    ...m.subdomains.map((s) => ({ subject: { type: 'module', slug: s.slug }, predicate: 'subdomain_of', object: { type: 'module', slug: m.module.slug } }) as const),
    ...modules.map((x) => ({ subject: { type: 'module', slug: x.slug }, predicate: 'derived_from', object: { type: 'source' } }) as const),
  ];
  const declared = m.subdomains.map((s) => s.slug);
  return {
    normalizer: MODULE_MANIFEST_NORMALIZER_ID,
    title: m.title,
    documentDate: m.date,
    metadata: { manifest: 'xyp-module-manifest/v1', parent: m.module.slug, subdomains: declared.length },
    modules,
    prompts: [],
    relations,
    coverage: { expected: declared, present: modules.slice(1).map((x) => x.slug) },
  };
};
