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
