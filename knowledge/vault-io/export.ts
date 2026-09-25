import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../core/db/client.ts';
import { appliedVersions } from '../../core/db/migrate.ts';
import type { VaultStore } from '../source-registry/vault-store.ts';
import { EXCLUDED_COLUMNS, recordLine, readSchema, rowKey, VAULT_EXPORT_FORMAT, type ExportTable, type Manifest, type Schema } from './spec.ts';

export { VAULT_EXPORT_FORMAT } from './spec.ts';

type Row = { readonly table: ExportTable; readonly key: string; readonly text: string; readonly obj: Record<string, unknown> };

const fetchRows = async (tx: postgres.TransactionSql, table: ExportTable, where: string, params: readonly unknown[]): Promise<{ text: string }[]> =>
  tx.unsafe<{ text: string }[]>(
    `select (to_jsonb(t) - $1::text[])::text as text from public.${quoteIdent(table)} t where ${where}`,
    [[...EXCLUDED_COLUMNS], ...params] as never[],
  );

/**
 * Collects the Vault and the closure of its links (§8): every song with its revisions, links and
 * retractions; every Vault file with its text and tags; every lineage a song links or a Vault file
 * was imported into, with all its versions and their approvals; then, repeatedly, every row an
 * exported row points at (a take's submission and formula, a track's release, every agent run…) and
 * the rows that belong to an exported one (a track's splits, a file's text and tags, a version's
 * approval) until nothing new is found. Since AOS-03 also the versions an artifact was built from
 * (body.sources), the submissions of an exported package, their takes and the takes' ratings.
 */
const collect = async (tx: postgres.TransactionSql, schema: Schema): Promise<Map<string, Row>> => {
  const rows = new Map<string, Row>();
  const add = (table: ExportTable, fetched: readonly { text: string }[]): number => {
    let n = 0;
    for (const f of fetched) {
      const obj = JSON.parse(f.text) as Record<string, unknown>;
      const key = rowKey(table, schema.pk[table], obj);
      if (!rows.has(key)) {
        rows.set(key, { table, key, text: f.text, obj });
        n++;
      }
    }
    return n;
  };
  const idsOf = (table: ExportTable, column = 'id') => [...rows.values()].filter((r) => r.table === table).map((r) => r.obj[column] as string);

  // The owner's own records, whole: songs and their links, and (AOS-02) the people they work with and
  // their to-dos; everything else comes in through the closure below.
  for (const t of ['songs', 'song_revisions', 'song_links', 'song_link_retractions', 'people', 'person_aliases', 'tasks', 'task_events'] as const) {
    add(t, await fetchRows(tx, t, 'true', []));
  }
  add('sources', await fetchRows(tx, 'sources', 'storage is not null', []));
  const cited = await tx<{ lineage_id: string }[]>`
    select distinct lineage_id from creative_artifacts a
    where exists (select from jsonb_array_elements(a.context_refs) r where r->>'kind' = 'vault-file' and r->>'sourceId' = any(${idsOf('sources')}::text[]))`;
  const lineages = [...new Set([...idsOf('song_links', 'artifact_lineage_id').filter(Boolean), ...cited.map((c) => c.lineage_id)])];
  add('creative_artifacts', await fetchRows(tx, 'creative_artifacts', 'lineage_id = any($2::uuid[])', [lineages]));

  for (;;) {
    let added = 0;
    for (const fk of schema.fks) {
      const want = [...new Set(idsOf(fk.table, fk.column).filter((v): v is string => typeof v === 'string'))]
        .filter((id) => !rows.has(`${fk.target}:${id}`));
      if (want.length === 0) continue;
      if (!(schema.pk as Record<string, readonly string[]>)[fk.target]) {
        throw new Error(`vault export: ${fk.table}.${fk.column} points into ${fk.target}, which a Vault export does not hold`);
      }
      added += add(fk.target as ExportTable, await fetchRows(tx, fk.target as ExportTable, 'id = any($2::uuid[])', [want]));
    }
    added += add('source_texts', await fetchRows(tx, 'source_texts', 'source_id = any($2::uuid[])', [idsOf('sources')]));
    added += add('source_tags', await fetchRows(tx, 'source_tags', 'source_id = any($2::uuid[])', [idsOf('sources')]));
    added += add('approval_queue', await fetchRows(tx, 'approval_queue', `item_type::text = 'artifact_version' and item_id = any($2::uuid[])`, [idsOf('creative_artifacts')]));
    added += add('rights_splits', await fetchRows(tx, 'rights_splits', 'track_id = any($2::uuid[])', [idsOf('tracks')]));
    // AOS-02: what belongs to an exported song, track or release.
    added += add('credits', await fetchRows(tx, 'credits', 'song_id = any($2::uuid[]) or track_id = any($3::uuid[])', [idsOf('songs'), idsOf('tracks')]));
    added += add('credit_retractions', await fetchRows(tx, 'credit_retractions', 'credit_id = any($2::uuid[])', [idsOf('credits')]));
    added += add('platform_links', await fetchRows(tx, 'platform_links', 'release_id = any($2::uuid[]) or track_id = any($3::uuid[])', [idsOf('releases'), idsOf('tracks')]));
    added += add('platform_link_retractions', await fetchRows(tx, 'platform_link_retractions', 'platform_link_id = any($2::uuid[])', [idsOf('platform_links')]));
    added += add('release_artwork', await fetchRows(tx, 'release_artwork', 'release_id = any($2::uuid[])', [idsOf('releases')]));
    added += add('release_deliveries', await fetchRows(tx, 'release_deliveries', 'release_id = any($2::uuid[])', [idsOf('releases')]));
    // AOS-03: the versions an exported artifact was built from (a package's lyric, recipe and tag set, a
    // Phase 9 formula's lyrics), as whole lineages; the attempts of an exported package, their takes, and
    // the owner's ratings of those takes.
    const built = await tx<{ lineage_id: string }[]>`
      select distinct c.lineage_id from creative_artifacts a
      cross join jsonb_array_elements(case when jsonb_typeof(a.body->'sources') = 'array' then a.body->'sources' else '[]'::jsonb end) x
      join creative_artifacts c on c.id::text = x->>'artifactId'
      where a.id = any(${idsOf('creative_artifacts')}::uuid[])`;
    added += add('creative_artifacts', await fetchRows(tx, 'creative_artifacts', 'lineage_id = any($2::uuid[])', [built.map((b) => b.lineage_id)]));
    added += add('suno_submissions', await fetchRows(tx, 'suno_submissions', 'formula_artifact_id = any($2::uuid[])', [idsOf('creative_artifacts')]));
    added += add('suno_takes', await fetchRows(tx, 'suno_takes', 'submission_id = any($2::uuid[])', [idsOf('suno_submissions')]));
    added += add('take_ratings', await fetchRows(tx, 'take_ratings', 'take_id = any($2::uuid[])', [idsOf('suno_takes')]));
    if (added === 0) return rows;
  }
};

/**
 * Orders rows so each comes after every row it depends on: its foreign keys, plus the order the
 * insert-time triggers need (a revision after the previous one; a split set after the previous
 * version; a re-link after the retraction that freed it). Ties go by created_at, table, key, so
 * the same data always gives the same file.
 */
const order = (rows: Map<string, Row>, schema: Schema): Row[] => {
  const deps = new Map<string, Set<string>>([...rows.keys()].map((k) => [k, new Set<string>()]));
  const dep = (k: string, on: string) => {
    if (rows.has(on) && on !== k) deps.get(k)!.add(on);
  };
  for (const r of rows.values()) {
    for (const fk of schema.fks.filter((f) => f.table === r.table)) {
      const v = r.obj[fk.column];
      if (typeof v === 'string') dep(r.key, `${fk.target}:${v}`);
    }
  }
  const all = [...rows.values()];
  const byCreated = (x: Row, y: Row) => String(x.obj.created_at).localeCompare(String(y.obj.created_at)) || x.key.localeCompare(y.key);
  const groups = <K>(table: ExportTable, keyOf: (r: Row) => K) => {
    const m = new Map<K, Row[]>();
    for (const r of all.filter((x) => x.table === table)) m.set(keyOf(r), [...(m.get(keyOf(r)) ?? []), r]);
    return [...m.values()];
  };
  for (const g of groups('song_revisions', (r) => r.obj.song_id)) {
    g.sort((x, y) => Number(x.obj.revision) - Number(y.obj.revision)).forEach((r, i) => i > 0 && dep(r.key, g[i - 1]!.key));
  }
  for (const g of groups('rights_splits', (r) => r.obj.track_id)) {
    for (const r of g) for (const p of g.filter((x) => Number(x.obj.version) === Number(r.obj.version) - 1)) dep(r.key, p.key);
  }
  const target = (r: Row) => `${r.obj.song_id}|${r.obj.artifact_lineage_id ?? r.obj.source_id ?? r.obj.take_id ?? r.obj.track_id ?? r.obj.research_question_id}`;
  // One live row per key (song_links, and since AOS-02 credits and platform links): a row re-added
  // after a retraction must follow the retraction that freed its key.
  const relinks = (table: ExportTable, retractions: ExportTable, keyOf: (r: Row) => string) => {
    for (const g of groups(table, keyOf)) g.sort(byCreated).forEach((r, i) => i > 0 && dep(r.key, `${retractions}:${g[i - 1]!.obj.id}`));
  };
  relinks('song_links', 'song_link_retractions', target);
  relinks('credits', 'credit_retractions', (r) => `${r.obj.person_id}|${r.obj.role}|${r.obj.song_id ?? r.obj.track_id}`);
  relinks('platform_links', 'platform_link_retractions', (r) => `${r.obj.platform}|${r.obj.release_id ?? r.obj.track_id}`);
  // AOS-03: the submission gate runs on import too, so a submission follows the versions its package
  // names and the owner's decisions on them (neither is a foreign key of the submission).
  const decisionOf = new Map(all.filter((r) => r.table === 'approval_queue').map((r) => [String(r.obj.item_id), r.key]));
  for (const s of all.filter((r) => r.table === 'suno_submissions')) {
    const sources = (rows.get(`creative_artifacts:${String(s.obj.formula_artifact_id)}`)?.obj.body as { sources?: unknown } | undefined)?.sources;
    for (const src of Array.isArray(sources) ? sources : []) {
      const id = String((src as { artifactId?: unknown }).artifactId);
      dep(s.key, `creative_artifacts:${id}`);
      const decision = decisionOf.get(id);
      if (decision) dep(s.key, decision);
    }
  }

  // Kahn's algorithm; the ready set is kept sorted, so the order is a function of the data alone.
  const cmp = (x: Row, y: Row) => byCreated(x, y) || x.table.localeCompare(y.table);
  const waiting = new Map([...deps].map(([k, d]) => [k, d.size]));
  const dependents = new Map<string, string[]>();
  for (const [k, d] of deps) for (const on of d) dependents.set(on, [...(dependents.get(on) ?? []), k]);
  const ready = all.filter((r) => waiting.get(r.key) === 0).sort(cmp);
  const out: Row[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    out.push(next);
    for (const k of dependents.get(next.key) ?? []) {
      const left = waiting.get(k)! - 1;
      waiting.set(k, left);
      if (left === 0) {
        const r = rows.get(k)!;
        const at = ready.findIndex((x) => cmp(r, x) < 0);
        ready.splice(at === -1 ? ready.length : at, 0, r);
      }
    }
  }
  if (out.length < all.length) throw new Error('vault export: the rows depend on each other in a cycle; nothing written');
  return out;
};

/**
 * `pnpm vault export <dir>` (AOS-01 §8): writes xyp-vault-export/v1: manifest.json, records.ndjson
 * (one `{ type, row }` per line, in dependency order) and blobs/<sha256> for every stored file.
 * Reads one consistent snapshot (repeatable read), as the connecting (migration) role.
 * @param sql - pool connected as the migration role
 * @param store - the Vault byte store the blobs are read from (verified on read)
 * @param dir - an empty or new directory
 * @returns the record and blob counts
 * @throws on a non-empty dir, a missing or corrupt blob, and a linked release that is not a draft
 */
export const exportVault = async (sql: Sql, store: VaultStore, dir: string): Promise<{ readonly dir: string; readonly records: number; readonly blobs: number }> => {
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length > 0) throw new Error(`vault export: ${dir} is not empty`);
  const head = (await appliedVersions(sql)).at(-1) ?? '';
  const rows = (await sql.begin('isolation level repeatable read read only', async (tx) => {
    // Timestamps render in UTC, so the same data always gives the same bytes.
    await tx`set local timezone = 'UTC'`;
    const schema = await readSchema(tx);
    return order(await collect(tx, schema), schema);
  })) as Row[];

  // A release is registered as a draft (xyp_releases_guard); a restore can't recreate a scheduled or
  // released one while its triggers apply. Refused here rather than failing half way into an import.
  for (const r of rows.filter((x) => x.table === 'releases' && x.obj.status !== 'draft')) {
    throw new Error(`vault export: release ${String(r.obj.id)} is ${String(r.obj.status)}; a restore can recreate draft releases only (release history is AOS-08)`);
  }

  const records = rows.map((r) => `${recordLine(r.table, r.text)}\n`).join('');
  const shas = [...new Set(rows.filter((r) => r.table === 'sources' && r.obj.storage !== null).map((r) => String(r.obj.checksum_sha256)))].sort();
  await mkdir(join(dir, 'blobs'));
  for (const s of shas) await writeFile(join(dir, 'blobs', s), await store.get(s));
  await writeFile(join(dir, 'records.ndjson'), records);
  const counts = Object.fromEntries([...new Set(rows.map((r) => r.table))].sort().map((t) => [t, rows.filter((r) => r.table === t).length]));
  const manifest: Manifest = {
    format: VAULT_EXPORT_FORMAT, createdAt: new Date().toISOString(), migrationHead: head, records: rows.length, counts,
    recordsSha256: createHash('sha256').update(records).digest('hex'), blobs: shas,
  };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, records: rows.length, blobs: shas.length };
};
