import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../source-registry/acquire.ts';
import { EXPORT_DIR } from './notes.ts';
import { buildPlan, type DesiredExport, type LedgerState, type NoteOnDisk } from './plan.ts';

const sha = (s: string) => sha256Hex(new TextEncoder().encode(s));
const note = (rel: string, content: string): NoteOnDisk => ({ rel, sha256: sha(content) });
const want = (rel: string, content: string): DesiredExport => ({ rel, content, sha256: sha(content), kind: 'song', id: rel });
const SONG = `${EXPORT_DIR}/Songs/A (00000001).md`;

describe('buildPlan', () => {
  it('imports new and changed notes outside the export folder, and skips unchanged ones', () => {
    const ledger: LedgerState = { imported: new Map([['Old.md', sha('old')], ['Same.md', sha('same')]]), exported: new Map() };
    const p = buildPlan([note('New.md', 'new'), note('Old.md', 'old v2'), note('Same.md', 'same')], ledger, []);
    expect(p.actions.map((a) => [a.kind, a.rel])).toEqual([['import', 'New.md'], ['import', 'Old.md']]);
    expect(p.unchanged).toBe(1);
  });

  it('creates an export the vault does not have, and updates one the owner did not touch', () => {
    const ledger: LedgerState = { imported: new Map(), exported: new Map([[SONG, sha('v1')]]) };
    const p = buildPlan([note(SONG, 'v1')], ledger, [want(SONG, 'v2'), want(`${EXPORT_DIR}/Songs/B (00000002).md`, 'b')]);
    expect(p.actions.map((a) => [a.kind, a.rel, a.kind === 'import' ? null : a.expectedSha])).toEqual([
      ['export', SONG, sha('v1')],
      ['export', `${EXPORT_DIR}/Songs/B (00000002).md`, null],
    ]);
  });

  it('never overwrites an exported note the owner edited: a conflict, and the edit comes in as an import', () => {
    const ledger: LedgerState = { imported: new Map(), exported: new Map([[SONG, sha('v1')]]) };
    const p = buildPlan([note(SONG, 'owner edit')], ledger, [want(SONG, 'v2')]);
    expect(p.actions.map((a) => [a.kind, a.rel])).toEqual([['import', SONG]]);
    expect(p.conflicts).toEqual([{ rel: SONG, reason: 'edited in Obsidian since the last export; the OS version was not written' }]);
  });

  it('treats a file at an export path the OS never wrote as the owner\'s: conflict, not overwrite', () => {
    const p = buildPlan([note(SONG, 'mine')], { imported: new Map(), exported: new Map() }, [want(SONG, 'os')]);
    expect(p.conflicts.map((c) => c.rel)).toEqual([SONG]);
    expect(p.actions.some((a) => a.kind === 'export')).toBe(false);
  });

  it('does not re-import its own export, and does nothing when the export is already current', () => {
    const ledger: LedgerState = { imported: new Map(), exported: new Map([[SONG, sha('v1')]]) };
    const p = buildPlan([note(SONG, 'v1')], ledger, [want(SONG, 'v1')]);
    expect(p.actions).toEqual([]);
    expect(p.unchanged).toBe(1);
  });

  it('lists notes that disappeared since they were synced, and changes nothing for them', () => {
    const ledger: LedgerState = { imported: new Map([['Gone.md', sha('x')]]), exported: new Map() };
    expect(buildPlan([], ledger, []).gone).toEqual(['Gone.md']);
  });

  it('hashes the plan: same inputs, same hash; any change on disk, a different hash', () => {
    const l: LedgerState = { imported: new Map(), exported: new Map() };
    const a = buildPlan([note('A.md', 'a')], l, []);
    expect(buildPlan([note('A.md', 'a')], l, []).hash).toBe(a.hash);
    expect(buildPlan([note('A.md', 'a2')], l, []).hash).not.toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
