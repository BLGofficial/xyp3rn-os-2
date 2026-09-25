import type postgres from 'postgres';

/**
 * xyp-vault-export/v1 (AOS-01 §8): what a Vault export holds and how its rows are rendered.
 * Shared by export and import so both read one definition.
 */

export const VAULT_EXPORT_FORMAT = 'xyp-vault-export/v1';

/**
 * The only tables a Vault export may hold: the Vault's own and the closure of its links. Import
 * refuses any other, so an edited file can't write canonical knowledge (that is the gate's path).
 */
export const EXPORT_TABLES = [
  'agent_runs', 'workflow_runs', 'research_projects', 'research_questions', 'research_runs',
  'songs', 'song_revisions', 'song_links', 'song_link_retractions',
  'sources', 'source_texts', 'source_tags', 'tags',
  'creative_artifacts', 'critiques', 'approval_queue',
  'suno_submissions', 'suno_takes', 'releases', 'tracks', 'rights_splits',
  // AOS-02 (design §7): the Command Center's records.
  'people', 'person_aliases', 'credits', 'credit_retractions', 'platform_links', 'platform_link_retractions',
  'release_artwork', 'release_deliveries', 'tasks', 'task_events',
  // AOS-03 (design §7): the owner's ratings of a generation's takes.
  'take_ratings',
] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];
export const isExportTable = (t: string): t is ExportTable => (EXPORT_TABLES as readonly string[]).includes(t);

/**
 * Left out of every row: derived or "last touched here", so they differ between two databases
 * holding the same data. updated_at is bumped by triggers (and by `pnpm embed` on a knowledge
 * source); the embedding columns are the knowledge index, rebuilt by `pnpm embed`.
 */
export const EXCLUDED_COLUMNS = ['updated_at', 'embedding', 'embedding_model', 'embedding_input_sha256', 'embedding_truncated', 'embedded_at'] as const;

export type Manifest = {
  readonly format: typeof VAULT_EXPORT_FORMAT;
  readonly createdAt: string;
  readonly migrationHead: string;
  readonly records: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly recordsSha256: string;
  readonly blobs: readonly string[];
};

export type Fk = { readonly table: ExportTable; readonly column: string; readonly target: string };
export type Schema = {
  readonly pk: Readonly<Record<ExportTable, readonly string[]>>;
  readonly columns: Readonly<Record<ExportTable, readonly string[]>>;
  readonly fks: readonly Fk[];
};

/**
 * Reads the primary keys, columns and single-column foreign keys of the export tables from the
 * catalog, so the closure follows the schema as migrated rather than a hand-kept list.
 * @param tx - any transaction
 * @returns the schema of the export tables
 * @throws when an export table has a primary key that is not uuid
 */
export const readSchema = async (tx: postgres.TransactionSql): Promise<Schema> => {
  const cols = await tx<{ tbl: string; col: string; typ: string; pk: boolean }[]>`
    select c.relname as tbl, a.attname as col, format_type(a.atttypid, a.atttypmod) as typ,
           coalesce(a.attnum = any(i.indkey::int2[]), false) as pk
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_index i on i.indrelid = c.oid and i.indisprimary
    where c.relname = any(${[...EXPORT_TABLES]}::text[])
    order by c.relname, a.attnum`;
  const pk = {} as Record<ExportTable, string[]>;
  const columns = {} as Record<ExportTable, string[]>;
  for (const t of EXPORT_TABLES) {
    pk[t] = cols.filter((c) => c.tbl === t && c.pk).map((c) => c.col);
    columns[t] = cols.filter((c) => c.tbl === t).map((c) => c.col);
    if (pk[t].length === 0) throw new Error(`vault export: table ${t} is missing or has no primary key`);
    const bad = cols.filter((c) => c.tbl === t && c.pk && c.typ !== 'uuid');
    if (bad.length > 0) throw new Error(`vault export: ${t}.${bad[0]!.col} is a ${bad[0]!.typ} key; the export keys rows by uuid`);
  }
  const fks = await tx<{ tbl: ExportTable; col: string; target: string }[]>`
    select c.conrelid::regclass::text as tbl, a.attname as col, c.confrelid::regclass::text as target
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1
      and c.conrelid::regclass::text = any(${[...EXPORT_TABLES]}::text[])
    order by 1, 2`;
  return { pk, columns, fks: fks.map((f) => ({ table: f.tbl, column: f.col, target: f.target })) };
};

/** A row's identity inside an export: `table:pk values`. */
export const rowKey = (table: string, pk: readonly string[], row: Readonly<Record<string, unknown>>): string =>
  `${table}:${pk.map((c) => String(row[c])).join('/')}`;

/** One records.ndjson line; the row text is Postgres's own jsonb rendering, kept verbatim. */
export const recordLine = (table: string, rowText: string): string => `{"type":"${table}","row":${rowText}}`;
