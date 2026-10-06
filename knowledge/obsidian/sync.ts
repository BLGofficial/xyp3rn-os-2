import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { stringify as toYaml } from 'yaml';
import type { Sql } from '../../core/db/client.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { addToVault } from '../ingestion/vault.ts';
import { sha256Hex } from '../source-registry/acquire.ts';
import { asRole } from '../source-registry/vault-tools.ts';
import { OBSIDIAN_SYNC_AGENT } from './agent.ts';
import { exportFileName, parseNote, resolveVaultRoot, scanVault, type NoteFile } from './notes.ts';
import { buildPlan, type DesiredExport, type LedgerState, type SyncPlan } from './plan.ts';

/**
 * Two-way Obsidian sync (F54): preview, then apply by the previewed hash. A controller over dispatch with
 * no authority of its own (as addToVault): every write is an agent run. Reads run as xyp_web, read only.
 */

const READ_ROLE = 'xyp_web';

/** Env var naming the vault (the vault folder, or its `.obsidian` folder). */
export const VAULT_ENV = 'XYP_OBSIDIAN_VAULT';

/** One OS record as the note it exports to. */
type ExportNote = DesiredExport & { readonly title: string };

const frontmatter = (fields: Readonly<Record<string, unknown>>): string => `---\n${toYaml(fields, { lineWidth: 0 }).trimEnd()}\n---\n`;
const FOOTER = '\n---\nExported by XYP3RN OS. Edit freely: your edit comes back into the Creative Vault as a document, and the OS stops updating this note.\n';

const songNote = (s: { id: string; title: string; artist: string; status: string; language: string | null; genre: string | null; notes: string | null; revision: number }): string =>
  frontmatter({ xyp3rn_id: s.id, xyp3rn_kind: 'song', xyp3rn_revision: s.revision, title: s.title, status: s.status, tags: ['xyp3rn', 'song'] })
  + `\n# ${s.title}\n\n- Artist: ${s.artist}\n- Status: ${s.status}\n- Language: ${s.language ?? 'not set'}\n- Genre: ${s.genre ?? 'not set'}\n- Revision: ${s.revision}\n`
  + (s.notes ? `\n## Notes\n\n${s.notes}\n` : '') + FOOTER;

const findingNote = (f: { id: string; claim: string; topic: string; modelTag: string; confidence: string; question: string; evidence: number; canonical: string }): string =>
  frontmatter({ xyp3rn_id: f.id, xyp3rn_kind: 'finding', title: f.topic, model_tag: f.modelTag, confidence: Number(f.confidence), tags: ['xyp3rn', 'finding'] })
  + `\n# ${f.topic}\n\n${f.claim}\n\n- Model/version: ${f.modelTag}\n- Confidence: ${f.confidence}\n- Evidence quotes: ${f.evidence}\n- Canonical status: ${f.canonical}\n- Brief: ${f.question}\n`
  + FOOTER;

const desired = (rel: string, content: string, kind: string, id: string, title: string): ExportNote =>
  ({ rel, content, sha256: sha256Hex(new TextEncoder().encode(content)), kind, id, title });

/**
 * The OS records the sync exports: every song (its current revision) and every finding the owner accepted.
 * @param sql - pool
 * @returns one desired note per record
 */
export const desiredExports = (sql: Sql): Promise<readonly ExportNote[]> =>
  asRole(sql, READ_ROLE, async (tx) => {
    const songs = await tx<{ id: string; title: string; artist: string; status: string; language: string | null; genre: string | null; notes: string | null; revision: number }[]>`
      select id, title, artist, status::text, language, genre, notes, revision from current_songs order by id`;
    const findings = await tx<{ finding_id: string; claim: string; claim_topic: string; model_tag: string; confidence: string; question: string; evidence_count: number; canonical_status: string }[]>`
      select finding_id, claim, claim_topic, model_tag, confidence::text, question, evidence_count, canonical_status from findings_library order by finding_id`;
    return [
      ...songs.map((s) => desired(exportFileName('Song', s.title, s.id), songNote(s), 'song', s.id, s.title)),
      ...findings.map((f) => desired(exportFileName('Finding', f.claim_topic, f.finding_id), findingNote({
        id: f.finding_id, claim: f.claim, topic: f.claim_topic, modelTag: f.model_tag, confidence: f.confidence, question: f.question,
        evidence: f.evidence_count, canonical: f.canonical_status,
      }), 'finding', f.finding_id, f.claim_topic)),
    ];
  }, 'read only');

/**
 * @param sql - pool
 * @param root - the vault root the ledger is keyed by
 * @returns the latest imported and exported sha per note path
 */
export const readLedger = (sql: Sql, root: string): Promise<LedgerState> =>
  asRole(sql, READ_ROLE, async (tx) => {
    const rows = await tx<{ note_path: string; direction: 'import' | 'export'; sha256: string }[]>`
      select note_path, direction, sha256 from current_obsidian_sync where vault_root = ${root}`;
    return {
      imported: new Map(rows.filter((r) => r.direction === 'import').map((r) => [r.note_path, r.sha256])),
      exported: new Map(rows.filter((r) => r.direction === 'export').map((r) => [r.note_path, r.sha256])),
    };
  }, 'read only');

/** A preview: the plan plus what the vault holds, for the owner to read before Apply. */
export type SyncPreview = {
  readonly root: string;
  /** True when the configured path pointed at `.obsidian` and the vault is its parent. */
  readonly adjusted: boolean;
  readonly plan: SyncPlan;
  readonly notes: readonly NoteFile[];
  readonly skipped: readonly string[];
  readonly exports: readonly ExportNote[];
};

/**
 * Reads the vault, the ledger and the OS records, and plans the sync. Writes nothing.
 * @param sql - pool
 * @param configured - XYP_OBSIDIAN_VAULT
 * @returns the preview
 */
export const previewSync = async (sql: Sql, configured: string): Promise<SyncPreview> => {
  const { root, adjusted } = resolveVaultRoot(configured);
  const [{ notes, skipped }, ledger, exports] = await Promise.all([scanVault(root), readLedger(sql, root), desiredExports(sql)]);
  return { root, adjusted, plan: buildPlan(notes, ledger, exports), notes, skipped, exports };
};

/** The receipt of an apply: what was written, by which runs, and what failed. */
export type SyncReceipt = {
  readonly root: string;
  readonly planHash: string;
  readonly imported: readonly { readonly rel: string; readonly sourceId: string; readonly status: string; readonly runIds: readonly string[]; readonly changedAfterPreview: boolean }[];
  readonly exported: readonly { readonly rel: string; readonly sha256: string; readonly runId: string }[];
  readonly failed: readonly { readonly rel: string; readonly kind: 'import' | 'export'; readonly error: string }[];
  readonly conflicts: SyncPlan['conflicts'];
};

let running = false;

/**
 * Applies the previewed plan. Re-plans first and refuses when the hash differs: something changed in the
 * vault or the OS since the owner looked, so they look again. Each step is independent: one failed note
 * is reported, the others still run. One sync per process at a time.
 * @param deps - dispatch deps (the tool set carries the Vault store)
 * @param configured - XYP_OBSIDIAN_VAULT
 * @param planHash - the hash the owner approved
 * @returns the receipt
 * @throws when the plan changed, or a sync is already running
 */
export const applySync = async (deps: DispatchDeps, configured: string, planHash: string): Promise<SyncReceipt> => {
  if (running) throw new Error('an Obsidian sync is already running; wait for it to finish');
  running = true;
  try {
    const p = await previewSync(deps.sql, configured);
    if (p.plan.hash !== planHash) throw new Error('the vault or the OS changed since the preview; preview the sync again before applying');
    const byRel = new Map(p.notes.map((n) => [n.rel, n]));
    const exports = new Map(p.exports.map((e) => [e.rel, e]));
    const imported: SyncReceipt['imported'][number][] = [];
    const exported: SyncReceipt['exported'][number][] = [];
    const failed: SyncReceipt['failed'][number][] = [];
    for (const a of p.plan.actions) {
      try {
        if (a.kind === 'import') {
          const note = byRel.get(a.rel)!;
          const parsed = parseNote(await readFile(note.abs, 'utf8'));
          const file = await addToVault(deps, {
            path: note.abs, as: 'document', title: parsed.title ?? basename(a.rel, '.md'), language: parsed.language,
            tags: ['obsidian', ...parsed.tags],
          });
          const r = await dispatch(deps, OBSIDIAN_SYNC_AGENT, { record: { vaultRoot: p.root, notePath: a.rel, sha256: file.sha256, sourceId: file.sourceId, planHash } });
          if (r.status !== 'success') throw new Error(r.error ?? `obsidian-sync failed (run ${r.runId})`);
          imported.push({ rel: a.rel, sourceId: file.sourceId, status: file.status, runIds: [...file.runIds, r.runId], changedAfterPreview: file.sha256 !== a.sha256 });
        } else {
          const e = exports.get(a.rel)!;
          const r = await dispatch(deps, OBSIDIAN_SYNC_AGENT, { export: { vaultRoot: p.root, notePath: a.rel, content: e.content, expectedSha: a.expectedSha, planHash } });
          if (r.status !== 'success') throw new Error(r.error ?? `obsidian-sync failed (run ${r.runId})`);
          exported.push({ rel: a.rel, sha256: (r.output as { sha256: string }).sha256, runId: r.runId });
        }
      } catch (err) {
        failed.push({ rel: a.rel, kind: a.kind, error: (err as Error).message });
      }
    }
    return { root: p.root, planHash, imported, exported, failed, conflicts: p.plan.conflicts };
  } finally {
    running = false;
  }
};
