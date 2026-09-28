import type { Sql } from '../../core/db/client.ts';
import type { ScanCounts, ScanResult } from './scan.ts';

/**
 * What `pnpm index status` and the scan's output say (AOS-04 Plan C1 Task 4): the last scan, the files by status,
 * and the diagnostics, read through the web's read-only role (it holds SELECT on the graph views; the indexer
 * doesn't, since the views read the live records too).
 */

const READ_ROLE = 'xyp_web';

export type IndexStatus = {
  readonly lastScan: {
    readonly id: string; readonly trigger: string; readonly status: string; readonly startedAt: string;
    readonly finishedAt: string | null; readonly counts: ScanCounts | null; readonly error: string | null;
  } | null;
  readonly diagnostics: { readonly unresolved: number; readonly dangling: number };
  readonly files: { readonly present: number; readonly missing: number; readonly unreadable: number };
};

/**
 * @param sql - a pool that may `set role xyp_web`
 * @returns the last scan, the diagnostics count by problem, and the indexed files by status
 */
export const indexStatus = (sql: Sql): Promise<IndexStatus> =>
  sql.begin('read only', async (tx) => {
    await tx.unsafe(`set local role ${READ_ROLE}`);
    const [s] = await tx<{ id: string; trigger: string; status: string; started_at: Date; finished_at: Date | null; counts: ScanCounts | null; error: string | null }[]>`
      select id, trigger, status, started_at, finished_at, counts, error from index_scans order by started_at desc, id limit 1`;
    const [d] = await tx<{ unresolved: number; dangling: number }[]>`
      select count(*) filter (where problem = 'unresolved')::int as unresolved, count(*) filter (where problem = 'dangling')::int as dangling
      from graph_diagnostics`;
    const [f] = await tx<{ present: number; missing: number; unreadable: number }[]>`
      select count(*) filter (where status = 'present')::int as present, count(*) filter (where status = 'missing')::int as missing,
             count(*) filter (where status = 'unreadable')::int as unreadable
      from indexed_files`;
    return {
      lastScan: s ? { id: s.id, trigger: s.trigger, status: s.status, startedAt: s.started_at.toISOString(), finishedAt: s.finished_at?.toISOString() ?? null, counts: s.counts, error: s.error } : null,
      diagnostics: d!,
      files: f!,
    };
  }) as Promise<IndexStatus>;

const countsLines = (c: ScanCounts): string[] => {
  const excluded = Object.entries(c.excluded).sort(([a], [b]) => a.localeCompare(b)).map(([rule, n]) => `${rule} ${n}`);
  return [
    `  eligible ${c.eligible} · indexed ${c.indexed} · failed ${c.failed} (unsupported paths ${c.unsupportedPaths}) · missing ${c.missing}`,
    `  excluded: ${excluded.length > 0 ? excluded.join(' · ') : 'none'}`,
    `  vault: present ${c.vault.present} · missing ${c.vault.missing} · corrupt ${c.vault.corrupt}`,
  ];
};

/**
 * @param r - a scan's result
 * @returns the lines `pnpm index scan` prints: status, counts, excluded rules (counts only), failures by path
 */
export const formatScan = (r: ScanResult): string[] => [
  `index scan ${r.scanId}: ${r.status}${r.error ? ` (${r.error})` : ''}`,
  ...countsLines(r.counts),
  ...(r.failures.length > 0 ? ['  failures:', ...r.failures.map((f) => `    ${f.path}: ${f.error}`)] : []),
];

/**
 * @param s - indexStatus's result
 * @returns the lines `pnpm index status` prints
 */
export const formatStatus = (s: IndexStatus): string[] => {
  if (!s.lastScan) return ['no scan yet: run pnpm index scan'];
  const l = s.lastScan;
  return [
    `last scan ${l.id} (${l.trigger}): ${l.status}${l.error ? ` (${l.error})` : ''}, started ${l.startedAt}${l.finishedAt ? `, finished ${l.finishedAt}` : ''}`,
    ...(l.counts ? countsLines(l.counts) : []),
    `files present ${s.files.present} · missing ${s.files.missing} · unreadable ${s.files.unreadable}`,
    `diagnostics ${s.diagnostics.unresolved + s.diagnostics.dangling} (unresolved ${s.diagnostics.unresolved} · dangling ${s.diagnostics.dangling})`,
  ];
};
