import { sha256Hex } from '../source-registry/acquire.ts';

/**
 * The two-way sync plan (F54), pure: what is on disk, what the ledger says the OS last saw or wrote,
 * and what the OS would export. The owner previews the plan; Apply runs only with the same hash, so
 * nothing is written that the owner did not see.
 *
 * - A note the owner wrote or changed comes in (import), wherever it is, including an edited export.
 * - The OS writes only notes it wrote before and nobody changed since, or paths that are free.
 * - Anything else at an export path is a conflict: reported, never overwritten.
 * - A deleted note changes nothing: the Vault keeps what it imported.
 */

export type NoteOnDisk = { readonly rel: string; readonly sha256: string };
/** The latest ledger sha per note path, by direction. */
export type LedgerState = { readonly imported: ReadonlyMap<string, string>; readonly exported: ReadonlyMap<string, string> };
export type DesiredExport = { readonly rel: string; readonly content: string; readonly sha256: string; readonly kind: string; readonly id: string };

export type SyncAction =
  | { readonly kind: 'import'; readonly rel: string; readonly sha256: string }
  /** expectedSha: what must be on disk when it is written (null: the path must be free). */
  | { readonly kind: 'export'; readonly rel: string; readonly sha256: string; readonly expectedSha: string | null };

export type SyncPlan = {
  readonly actions: readonly SyncAction[];
  readonly conflicts: readonly { readonly rel: string; readonly reason: string }[];
  readonly unchanged: number;
  /** Ledger paths no longer on disk. Informational: nothing is deleted on either side. */
  readonly gone: readonly string[];
  readonly hash: string;
};

const byRel = <T extends { rel: string }>(a: T, b: T) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

/**
 * @param notes - the vault's notes as hashed now
 * @param ledger - the latest synced sha per path
 * @param desired - the OS records as the notes it would write
 * @returns the plan and its hash
 */
export const buildPlan = (notes: readonly NoteOnDisk[], ledger: LedgerState, desired: readonly DesiredExport[]): SyncPlan => {
  const disk = new Map(notes.map((n) => [n.rel, n.sha256]));
  const handled = new Set<string>();
  const exports: SyncAction[] = [];
  const conflicts: { rel: string; reason: string }[] = [];
  let unchanged = 0;

  for (const d of desired) {
    const now = disk.get(d.rel);
    const last = ledger.exported.get(d.rel);
    if (now === undefined) {
      if (last === undefined) exports.push({ kind: 'export', rel: d.rel, sha256: d.sha256, expectedSha: null });
      else conflicts.push({ rel: d.rel, reason: 'deleted in Obsidian since the last export; not re-created' });
    } else if (now === d.sha256) {
      unchanged++;
      handled.add(d.rel);
    } else if (last !== undefined && now === last) {
      exports.push({ kind: 'export', rel: d.rel, sha256: d.sha256, expectedSha: now });
      handled.add(d.rel);
    } else {
      conflicts.push({
        rel: d.rel,
        reason: last === undefined
          ? 'a note the OS did not write is at this path; the OS version was not written'
          : 'edited in Obsidian since the last export; the OS version was not written',
      });
    }
  }

  const imports: SyncAction[] = [];
  for (const n of notes) {
    if (handled.has(n.rel)) continue;
    // The OS's own untouched export is not owner material.
    if (ledger.exported.get(n.rel) === n.sha256) continue;
    if (ledger.imported.get(n.rel) === n.sha256) unchanged++;
    else imports.push({ kind: 'import', rel: n.rel, sha256: n.sha256 });
  }

  const actions = [...exports.sort(byRel), ...imports.sort(byRel)];
  conflicts.sort(byRel);
  const gone = [...new Set([...ledger.imported.keys(), ...ledger.exported.keys()])].filter((r) => !disk.has(r)).sort();
  const hash = sha256Hex(new TextEncoder().encode(JSON.stringify({ actions, conflicts: conflicts.map((c) => c.rel) })));
  return { actions, conflicts, unchanged, gone, hash };
};
