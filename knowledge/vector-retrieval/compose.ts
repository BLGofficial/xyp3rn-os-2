/**
 * What text gets embedded for each row. gte-small only reads 512 tokens, so the most
 * discriminating parts go first: title, role, task items, constraints. The full body stays
 * in the row; this only shapes the vector.
 */

type PromptRow = { readonly title: string; readonly body: string; readonly structured: Readonly<Record<string, unknown>> | null };

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Builds the embedding input for a canonical prompt.
 * @param row - canonical_prompts title/body/structured
 * @returns structured-first text; falls back to the body when there is no structure
 */
export const composePromptInput = (row: PromptRow): string => {
  const s = row.structured ?? {};
  const role = typeof s.role === 'string' ? s.role : '';
  const task = list(s.task);
  const constraints = list(s.constraints);
  if (!role && task.length === 0 && constraints.length === 0) return `${row.title}\n${row.body}`;
  return [
    row.title,
    role,
    task.length ? `Task: ${task.join(' ')}` : '',
    constraints.length ? `Constraints: ${constraints.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
};

/**
 * Builds the embedding input for a source: its title, label and the titles of the modules
 * normalized from it (the document's own outline), since the raw bytes don't fit 512 tokens.
 * @param row - sources title/metadata
 * @param moduleTitles - titles of modules whose source_id is this source
 * @returns outline text
 */
export const composeSourceInput = (
  row: { readonly title: string; readonly metadata: Readonly<Record<string, unknown>> },
  moduleTitles: readonly string[],
): string =>
  [row.title, typeof row.metadata.doc_label === 'string' ? row.metadata.doc_label : '', ...moduleTitles]
    .filter(Boolean)
    .join('\n');

// ─── the vault corpus (AOS-01, A3) ──────────────────────────────────────────────────────────────

/** Characters of a Vault input kept for the vector (gte-small reads ~512 tokens; the rest is cut). */
export const VAULT_INPUT_CHARS = 4000;

// Bookkeeping, not content: traceability, provenance and per-bar metadata say nothing a search is for.
const ARTIFACT_SKIP = new Set(['rulesApplied', 'ungroundedChoices', 'sources', 'sectionId', 'kind', 'n', 'language', 'rhymeTag', 'instrumental', 'bar']);

const leaves = (v: unknown): string[] => {
  if (typeof v === 'string') return v.trim() === '' ? [] : [v];
  if (Array.isArray(v)) return v.flatMap(leaves);
  if (v !== null && typeof v === 'object') return Object.entries(v).filter(([k]) => !ARTIFACT_SKIP.has(k)).flatMap(([, x]) => leaves(x));
  return [];
};

/**
 * A creative artifact's text, schema-agnostic: every string in its body except bookkeeping
 * (traceability, sources, ids and per-bar metadata). For lyrics that is labels, lines and
 * directions; for a Suno prompt its title, style and lyrics.
 * @param body - creative_artifacts.body
 * @returns one line per string, in the body's stored order
 */
export const artifactText = (body: unknown): string => leaves(body).join('\n');

/** An input cut to VAULT_INPUT_CHARS, with whether it was cut. */
export type VaultInput = { readonly input: string; readonly cut: boolean };

const cap = (text: string): VaultInput => (text.length > VAULT_INPUT_CHARS ? { input: text.slice(0, VAULT_INPUT_CHARS), cut: true } : { input: text, cut: false });

/**
 * @param row - the artifact's brief and body
 * @returns brief, then its text
 */
export const composeArtifactInput = (row: { readonly brief: string; readonly body: unknown }): VaultInput => cap(`${row.brief}\n${artifactText(row.body)}`);

/**
 * A Vault file: its title and tags, then its extracted text. A file with no text (audio, an image)
 * is found by its name and tags.
 * @param row - title, tag labels and extracted text (null when none)
 * @returns the input
 */
export const composeVaultFileInput = (row: { readonly title: string; readonly tags: readonly string[]; readonly text: string | null }): VaultInput =>
  cap([row.title, row.tags.length ? `Tags: ${row.tags.join(', ')}` : '', row.text ?? ''].filter(Boolean).join('\n'));
