import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { quoteIdent, type Sql } from '../../core/db/client.ts';
import { appliedVersions } from '../../core/db/migrate.ts';
import type { VaultStore } from '../source-registry/vault-store.ts';
import { EXCLUDED_COLUMNS, isExportTable, readSchema, rowKey, VAULT_EXPORT_FORMAT, type ExportTable, type Manifest } from './spec.ts';

type Record_ = { readonly table: ExportTable; readonly raw: string; readonly obj: Record<string, unknown> };

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** Splits records.ndjson, keeping each row's text exactly as exported (numeric scale included). */
const parseRecords = (text: string): Record_[] =>
  text.split('\n').filter((l) => l !== '').map((line, i) => {
    const m = /^\{"type":"([a-z_]+)","row":(.*)\}$/.exec(line);
    if (!m) throw new Error(`vault import: records.ndjson line ${i + 1} is not a {"type","row"} record`);
    const table = m[1]!;
    if (!isExportTable(table)) throw new Error(`vault import: line ${i + 1}: ${table} is not a Vault export table`);
    const obj = JSON.parse(m[2]!) as unknown;
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`vault import: line ${i + 1}: row is not an object`);
    return { table, raw: m[2]!, obj: obj as Record<string, unknown> };
  });

/**
 * `pnpm vault import <dir>` (AOS-01 §8): a restore, run as the migration role. Verifies the
 * manifest, the records hash and every blob before touching anything; puts the blobs; then, in one
 * transaction, inserts every record with its original id and in export order. A row already here
 * and identical is skipped; one that differs refuses the whole import, listing every conflict.
 * The triggers stay on, so immutability, derived versions, link roots and split sums hold, and
 * each inserted row is checked against its record after the triggers ran.
 * @param sql - pool connected as the migration role
 * @param store - the Vault byte store the blobs go into
 * @param dir - an xyp-vault-export/v1 directory
 * @returns records, inserted, skipped, blobs
 * @throws on any verification failure or conflict; nothing is written to the database then
 */
export const importVault = async (sql: Sql, store: VaultStore, dir: string): Promise<{ readonly records: number; readonly inserted: number; readonly skipped: number; readonly blobs: number }> => {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.format !== VAULT_EXPORT_FORMAT) throw new Error(`vault import: ${dir} is not ${VAULT_EXPORT_FORMAT} (format ${String(manifest.format)})`);
  const head = (await appliedVersions(sql)).at(-1) ?? '';
  if (manifest.migrationHead !== head) {
    throw new Error(`vault import: the export was taken at migration ${manifest.migrationHead}, this database is at ${head}; migrate both to the same version first`);
  }
  const text = await readFile(join(dir, 'records.ndjson'), 'utf8');
  if (sha256(text) !== manifest.recordsSha256) throw new Error(`vault import: records.ndjson does not match the manifest's sha256; the file was changed or truncated`);
  const records = parseRecords(text);
  if (records.length !== manifest.records) throw new Error(`vault import: manifest says ${manifest.records} records, records.ndjson has ${records.length}`);

  // Every stored file's bytes are here and are what their name says, before anything is written.
  const present = new Set(await readdir(join(dir, 'blobs')));
  const needed = [...new Set(records.filter((r) => r.table === 'sources' && r.obj.storage !== null).map((r) => String(r.obj.checksum_sha256)))];
  const blobs = new Map<string, Uint8Array>();
  for (const s of needed) {
    if (!present.has(s)) throw new Error(`vault import: blob ${s} is missing from ${join(dir, 'blobs')}`);
    const bytes = new Uint8Array(await readFile(join(dir, 'blobs', s)));
    if (sha256(bytes) !== s) throw new Error(`vault import: blob ${s} is corrupt: its bytes hash to ${sha256(bytes)}`);
    blobs.set(s, bytes);
  }

  // Bytes before rows (as register_vault_file): a row never points at bytes the store lacks; bytes
  // whose rows then fail to commit are harmless (content-addressed, reused by a retry).
  for (const bytes of blobs.values()) await store.put(bytes);

  const result = await sql.begin(async (tx) => {
    await tx`set local timezone = 'UTC'`;
    const schema = await readSchema(tx);
    for (const r of records) {
      const unknown = Object.keys(r.obj).filter((c) => !schema.columns[r.table].includes(c));
      if (unknown.length > 0) throw new Error(`vault import: ${r.table} has no column ${unknown.join(', ')}`);
    }
    const excluded = [...EXCLUDED_COLUMNS];
    const pkMatch = (table: ExportTable) => schema.pk[table].map((c) => `t.${quoteIdent(c)} = r.${quoteIdent(c)}`).join(' and ');
    const existing = new Map<string, boolean>();
    const conflicts: string[] = [];
    for (const r of records) {
      const [row] = await tx.unsafe<{ same: boolean }[]>(
        `select (to_jsonb(t) - $2::text[]) = ($1::text)::jsonb as same
         from public.${quoteIdent(r.table)} t, jsonb_populate_record(null::public.${quoteIdent(r.table)}, ($1::text)::jsonb) r
         where ${pkMatch(r.table)}`,
        [r.raw, excluded] as never[],
      );
      if (!row) continue;
      existing.set(rowKey(r.table, schema.pk[r.table], r.obj), true);
      if (!row.same) conflicts.push(`${r.table} ${schema.pk[r.table].map((c) => String(r.obj[c])).join('/')}`);
    }
    if (conflicts.length > 0) {
      throw new Error(`vault import: ${conflicts.length} conflict(s) with rows already in this database; nothing imported:\n  ${conflicts.join('\n  ')}`);
    }
    let inserted = 0;
    for (const r of records) {
      if (existing.has(rowKey(r.table, schema.pk[r.table], r.obj))) continue;
      const cols = Object.keys(r.obj).map(quoteIdent).join(', ');
      const [row] = await tx.unsafe<{ same: boolean }[]>(
        `insert into public.${quoteIdent(r.table)} as t (${cols})
         select ${cols} from jsonb_populate_record(null::public.${quoteIdent(r.table)}, ($1::text)::jsonb)
         returning (to_jsonb(t) - $2::text[]) = ($1::text)::jsonb as same`,
        [r.raw, excluded] as never[],
      );
      if (!row!.same) throw new Error(`vault import: ${r.table} ${String(r.obj.id ?? '')} was stored differently from its record (a trigger derived another value); nothing imported`);
      inserted++;
    }
    return { records: records.length, inserted, skipped: records.length - inserted };
  });
  return { ...(result as { records: number; inserted: number; skipped: number }), blobs: blobs.size };
};
