import type { Domain } from '../../core/contracts/taxonomy.ts';

/** Canonical-ready output of a normalizer. Pure data: no ids, no DB state. */

export type NormalizedModule = {
  readonly slug: string;
  readonly title: string;
  readonly description: string | null;
  readonly domain: Domain;
};

export type NormalizedPrompt = {
  readonly moduleSlug: string;
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly structured: Readonly<Record<string, unknown>>;
  readonly modelTag: string | null;
  readonly tags: readonly string[];
  /** Fields this entry type should carry vs. the ones it does — feeds the quality rubric. */
  readonly completeness: { readonly expected: readonly string[]; readonly present: readonly string[] };
};

export type EntityRef =
  | { readonly type: 'module'; readonly slug: string }
  | { readonly type: 'canonical_prompt'; readonly slug: string }
  | { readonly type: 'source' };

export type NormalizedRelation = {
  readonly subject: EntityRef;
  readonly predicate: string;
  readonly object: EntityRef;
};

export type NormalizedDocument = {
  readonly normalizer: string;
  readonly title: string;
  /** ISO date the document states for itself, or null. Drives the freshness score. */
  readonly documentDate: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly modules: readonly NormalizedModule[];
  readonly prompts: readonly NormalizedPrompt[];
  readonly relations: readonly NormalizedRelation[];
  /** Document-level completeness: what the source says it contains vs. what was parsed. */
  readonly coverage: { readonly expected: readonly string[]; readonly present: readonly string[] };
};

/**
 * Lowercase kebab slug. Strips everything that isn't [a-z0-9].
 * @param text - human title
 * @returns slug matching the DB's kebab-case CHECK constraints
 */
export const slugify = (text: string): string =>
  text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
