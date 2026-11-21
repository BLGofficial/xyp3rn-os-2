import fs from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { parseFrontmatterDocument } from '../../core/vault-engine/frontmatter.ts';
import type { VaultEngine } from '../../core/vault-engine/vault-engine.ts';
import { DawMusicCatalogIntegrator } from '../daw-catalog-integration.ts';
import { validateRightsSharesMilli } from '../os3-records-catalog-ops.ts';
import { Os3RecordsEngine, isValidGs1Code, isValidIsrcCode } from '../os3-records-engine.ts';
import {
  CREDIT_ROLES,
  DELIVERY_STATUSES,
  PLATFORM_NAMES,
  isValidPlatformUrl,
  type Os2FullRecordsMusicExport,
  type RecordsLegacyScanItem,
  type RecordsMigrationDisposition,
  type RecordsMigrationEntityType,
  type RecordsMigrationItemResult,
  type RecordsMigrationReport,
  type RecordsParityDomainStats,
  type RecordsParityReport,
  type TransactionalBoundaryAssessment,
} from '../os3-records-types.ts';
import { mixedScriptWords } from '../x3lius/creative/script-check.ts';

const findById = (db: SqliteRuntimeDb, id: string) =>
  db.listIndexEntries(undefined, 20_000).find((e) => e.frontmatter.id === id) ?? null;

export const assessRecordsTransactionalBoundaries = (): readonly TransactionalBoundaryAssessment[] => [
  {
    os2Mechanism: 'Postgres BEFORE UPDATE/INSERT triggers on releases/tracks (write-once ISRC & UPC, draft-only track registration)',
    os3Guarantee: 'Os3RecordsEngine.assignIsrc / assignUpc / registerTrack + VaultEngine expectedSha256 optimistic concurrency + writeMode: reject-overwrite',
    status: 'preserved_via_sqlite_and_vault_cas',
    notes: 'ISRC (ISO 3901) and UPC (GS1 mod-10) are immutable once set and checked for global uniqueness across SQLite index_state.',
  },
  {
    os2Mechanism: 'Postgres DEFERRABLE INITIALLY DEFERRED split-sum constraint + advisory lock per track (`xyp_queue_split_proposal`)',
    os3Guarantee: 'validateRightsSharesMilli (exact 100.000% sum, no duplicate payees) + SqliteRuntimeDb.acquireLock/releaseLock + transaction() + currentVersion pinning',
    status: 'preserved_via_sqlite_and_vault_cas',
    notes: 'Concurrent or stale split proposals fail with STALE_SPLIT_VERSION or CONCURRENT_SPLIT_MODIFICATION without overwriting newer versions.',
  },
  {
    os2Mechanism: 'Postgres no-self-approval + append-only creative/critique/retraction history',
    os3Guarantee: 'pending_approvals in SQLite + F35 D2 distinct-actor check + separate APPR-*/CRET-*/PLRT-*/SLRT-* Vault notes with status: superseded',
    status: 'preserved_via_sqlite_and_vault_cas',
    notes: 'Proposer and approver cannot match case-insensitively; retractions append immutable evidence notes instead of deleting history.',
  },
  {
    os2Mechanism: 'Postgres multi-user relational command-center queue tables (tasks, task_events, public.sources storage RLS policies)',
    os3Guarantee: 'Retained in OS2 Postgres as read-only upstream reference while Vault-first catalog records remain local-first in 06_RECORDS & 09_X3LIUS_MUSIC',
    status: 'retained_read_only_in_os2_postgres',
    notes: 'OS2 Supabase/Postgres schemas and rows are never deleted or mutated during OS3 migration.',
  },
];

const OS3_REQUIRED_FIELDS_BY_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  'xyp3rn.song/v3': ['id', 'schema', 'title', 'artist', 'language'],
  'xyp3rn.lyric/v3': ['id', 'schema', 'lineage_id', 'title', 'language'],
  'xyp3rn.track/v3': ['id', 'schema', 'title', 'position'],
  'xyp3rn.release/v3': ['id', 'schema', 'title', 'artist', 'kind'],
  'xyp3rn.rights-split/v3': ['id', 'schema', 'title', 'total_percentage', 'has_unassigned_share', 'shares'],
  'xyp3rn.approval/v3': ['id', 'schema', 'title', 'item_type', 'item_id', 'proposer'],
  'xyp3rn.entity/v3': ['id', 'schema', 'title', 'domain'],
  'xyp3rn.decision-record/v3': ['id', 'schema', 'decision_key', 'title', 'decided_by'],
  'xyp3rn.knowledge/v3': ['id', 'schema', 'title', 'domain', 'status'],
};

export const scanLegacyRecordsVaultMarkdown = async (options: {
  readonly legacyMarkdownRootDirs: readonly string[];
  readonly db: SqliteRuntimeDb;
}): Promise<{
  readonly scannedDirs: readonly string[];
  readonly files: readonly RecordsLegacyScanItem[];
}> => {
  const files: RecordsLegacyScanItem[] = [];
  const scannedDirs: string[] = [];
  const indexedIds = new Set(
    options.db
      .listIndexEntries(undefined, 20_000)
      .map((e) => (typeof e.frontmatter.id === 'string' ? e.frontmatter.id : ''))
      .filter(Boolean),
  );

  for (const rootDir of options.legacyMarkdownRootDirs) {
    const stat = await fs.stat(rootDir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    scannedDirs.push(rootDir);
    const dirGroup: '06_RECORDS' | '09_X3LIUS_MUSIC' = rootDir.includes('09_X3LIUS_MUSIC')
      ? '09_X3LIUS_MUSIC'
      : '06_RECORDS';

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const abs = join(dir, ent.name);
        if (ent.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
        const rel = relative(rootDir, abs).split(sep).join('/');
        const raw = await fs.readFile(abs, 'utf8');
        const parsed = parseFrontmatterDocument(raw, { strict: false, vaultPath: rel });
        if (parsed.frontmatterError) {
          files.push({
            relativePath: rel,
            directoryGroup: dirGroup,
            hasOs3Schema: false,
            schema: null,
            entityId: null,
            title: null,
            missingOs3Fields: [],
            disposition: 'invalid_frontmatter',
          });
          continue;
        }
        const fm = parsed.rawFrontmatter;
        const schema = typeof fm.schema === 'string' ? fm.schema : null;
        const entityId = typeof fm.id === 'string' ? fm.id : null;
        const title = typeof fm.title === 'string' ? fm.title : null;
        const reqFields = schema ? OS3_REQUIRED_FIELDS_BY_SCHEMA[schema] : undefined;
        if (!reqFields) {
          files.push({
            relativePath: rel,
            directoryGroup: dirGroup,
            hasOs3Schema: false,
            schema,
            entityId,
            title,
            missingOs3Fields: schema ? [] : ['schema', 'id', 'domain', 'sector'],
            disposition: 'incomplete_legacy',
          });
          continue;
        }
        const missing = reqFields.filter((f) => fm[f] === undefined || fm[f] === null || String(fm[f]).trim() === '');
        const disposition =
          missing.length > 0
            ? 'incomplete_legacy'
            : entityId && indexedIds.has(entityId)
              ? 'idempotent_existing'
              : 'valid_os3';
        files.push({
          relativePath: rel,
          directoryGroup: dirGroup,
          hasOs3Schema: true,
          schema,
          entityId,
          title,
          missingOs3Fields: missing,
          disposition,
        });
      }
    };
    await walk(rootDir);
  }

  return { scannedDirs, files };
};

export type MigrateOs2RecordsOptions = {
  readonly payload: Os2FullRecordsMusicExport;
  readonly engine: Os3RecordsEngine;
  readonly integrator?: DawMusicCatalogIntegrator | undefined;
  readonly vault: VaultEngine;
  readonly db: SqliteRuntimeDb;
  readonly dryRun?: boolean | undefined;
  readonly legacyMarkdownRootDirs?: readonly string[] | undefined;
};

export const migrateOs2RecordsAndMusicToOs3 = async (
  options: MigrateOs2RecordsOptions,
): Promise<RecordsMigrationReport> => {
  const startedAt = new Date().toISOString();
  const { payload, engine, db } = options;
  const integrator = options.integrator ?? new DawMusicCatalogIntegrator({ vault: options.vault, db });
  const dryRun = Boolean(options.dryRun);
  const items: RecordsMigrationItemResult[] = [];

  const push = (
    entityType: RecordsMigrationEntityType,
    sourceTable: string,
    legacyId: string,
    disposition: RecordsMigrationDisposition,
    os3Id: string | null,
    vaultPath: string | null,
    reason: string,
  ) => {
    items.push({ entityType, sourceTable, legacyId, os3Id, disposition, vaultPath, reason });
  };

  // Track virtual IDs resolved during dryRun so downstream entities evaluate dependency integrity cleanly
  const knownContributors = new Map<string, string>(); // id -> lower displayName
  const knownAliases = new Set<string>();
  const knownSongs = new Map<string, { title: string; artist: string }>();
  const knownProjects = new Set<string>();
  const knownReleases = new Map<string, { title: string; kind: string; upc: string | null }>();
  const knownTracks = new Map<string, { releaseId: string; position: number; isrc: string | null }>();
  const knownSplits = new Set<string>(); // `${trackId}::v${version}`
  const knownTakes = new Set<string>();
  const knownMixes = new Set<string>();
  const knownMasters = new Set<string>();

  for (const e of db.listIndexEntries(undefined, 20_000)) {
    const id = typeof e.frontmatter.id === 'string' ? e.frontmatter.id : '';
    if (!id) continue;
    if (e.vaultPath.startsWith('06_RECORDS/PEOPLE/PER-')) {
      knownContributors.set(id, String(e.frontmatter.display_name ?? e.title).trim().toLowerCase());
    } else if (e.vaultPath.startsWith('06_RECORDS/PEOPLE/PALS-') && e.frontmatter.status !== 'superseded') {
      knownAliases.add(String(e.frontmatter.alias ?? '').trim().toLowerCase());
    } else if (e.vaultPath.startsWith('09_X3LIUS_MUSIC/SONGS/SONG-')) {
      knownSongs.set(id, { title: e.title, artist: String(e.frontmatter.artist ?? '') });
    } else if (e.vaultPath.startsWith('09_X3LIUS_MUSIC/PROJECTS/MPRJ-')) {
      knownProjects.add(id);
    } else if (e.vaultPath.startsWith('06_RECORDS/RELEASES/REL-')) {
      knownReleases.set(id, {
        title: e.title,
        kind: String(e.frontmatter.kind ?? 'single'),
        upc: e.frontmatter.upc ? String(e.frontmatter.upc) : null,
      });
    } else if (e.vaultPath.startsWith('06_RECORDS/TRACKS/TRK-')) {
      knownTracks.set(id, {
        releaseId: String(e.frontmatter.release_id ?? ''),
        position: Number(e.frontmatter.position ?? 0),
        isrc: e.frontmatter.isrc ? String(e.frontmatter.isrc) : null,
      });
    } else if (e.vaultPath.startsWith('06_RECORDS/RIGHTS/SPLT-')) {
      knownSplits.add(`${String(e.frontmatter.track_id)}::v${Number(e.frontmatter.version ?? 1)}`);
    } else if (e.vaultPath.startsWith('09_X3LIUS_MUSIC/TAKES/TAKE-')) {
      knownTakes.add(id);
    } else if (e.vaultPath.startsWith('09_X3LIUS_MUSIC/EVALUATION/MIX-')) {
      knownMixes.add(id);
    } else if (e.vaultPath.startsWith('09_X3LIUS_MUSIC/EVALUATION/MSTR-')) {
      knownMasters.add(id);
    }
  }

  // 1. Contributors (`people`) & Aliases (`person_aliases`)
  for (const p of payload.people ?? []) {
    if (!p.id.trim() || !p.displayName.trim()) {
      push('contributor', 'people', p.id || '(missing)', 'incomplete', null, null, 'Missing contributor id or displayName');
      continue;
    }
    const norm = p.displayName.trim().toLowerCase();
    const existing = knownContributors.get(p.id);
    if (existing !== undefined) {
      if (existing === norm) {
        push('contributor', 'people', p.id, 'skipped_idempotent', p.id, findById(db, p.id)?.vaultPath ?? null, 'Contributor already present identically');
      } else {
        push('contributor', 'people', p.id, 'conflicting', p.id, findById(db, p.id)?.vaultPath ?? null, `Display name differs from existing ("${existing}" vs "${norm}")`);
      }
      continue;
    }
    if ([...knownContributors.values()].includes(norm) || knownAliases.has(norm)) {
      push('contributor', 'people', p.id, 'conflicting', null, null, `Name "${p.displayName}" collides in people/person_aliases namespace`);
      continue;
    }
    if (dryRun) {
      knownContributors.set(p.id, norm);
      push('contributor', 'people', p.id, 'migrated', p.id, null, 'Dry-run validated contributor');
      continue;
    }
    try {
      const res = await engine.registerContributor({
        personId: p.id,
        displayName: p.displayName,
        kind: p.kind,
        ipi: p.ipi,
        pro: p.pro,
        isni: p.isni,
        bio: p.bio,
        provenance: payload.sourceSystem,
        actor: 'os2-migrator',
      });
      knownContributors.set(p.id, norm);
      push('contributor', 'people', p.id, 'migrated', res.personId, res.vaultPath, 'Migrated contributor');
    } catch (err) {
      push('contributor', 'people', p.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  for (const al of payload.personAliases ?? []) {
    if (!al.id.trim() || !al.personId.trim() || !al.alias.trim()) {
      push('contributor_alias', 'person_aliases', al.id || '(missing)', 'incomplete', null, null, 'Missing alias id/personId/alias');
      continue;
    }
    const norm = al.alias.trim().toLowerCase();
    const existing = findById(db, al.id);
    if (existing) {
      const same = String(existing.frontmatter.alias ?? '').trim().toLowerCase() === norm && existing.frontmatter.person_id === al.personId;
      push(
        'contributor_alias',
        'person_aliases',
        al.id,
        same ? 'skipped_idempotent' : 'conflicting',
        al.id,
        existing.vaultPath,
        same ? 'Alias already present' : 'Existing alias conflicts with export record',
      );
      continue;
    }
    if (!knownContributors.has(al.personId)) {
      push('contributor_alias', 'person_aliases', al.id, 'incomplete', null, null, `Referenced person "${al.personId}" missing`);
      continue;
    }
    if ([...knownContributors.values()].includes(norm) || knownAliases.has(norm)) {
      push('contributor_alias', 'person_aliases', al.id, 'conflicting', null, null, `Alias "${al.alias}" collides in people/person_aliases namespace`);
      continue;
    }
    if (dryRun) {
      knownAliases.add(norm);
      push('contributor_alias', 'person_aliases', al.id, 'migrated', al.id, null, 'Dry-run validated alias');
      continue;
    }
    try {
      const res = await engine.addContributorAlias({
        aliasId: al.id,
        personPathOrId: al.personId,
        alias: al.alias,
        provenance: payload.sourceSystem,
        actor: 'os2-migrator',
      });
      knownAliases.add(norm);
      push('contributor_alias', 'person_aliases', al.id, 'migrated', res.aliasId, res.vaultPath, 'Migrated alias');
    } catch (err) {
      push('contributor_alias', 'person_aliases', al.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  // 2. Music Projects
  for (const prj of payload.musicProjects ?? []) {
    if (!prj.id.trim() || !prj.title.trim()) {
      push('music_project', 'music_projects', prj.id || '(missing)', 'incomplete', null, null, 'Missing project id or title');
      continue;
    }
    const existing = findById(db, prj.id);
    if (existing || knownProjects.has(prj.id)) {
      const same = existing ? existing.title === prj.title.trim() : true;
      push('music_project', 'music_projects', prj.id, same ? 'skipped_idempotent' : 'conflicting', prj.id, existing?.vaultPath ?? null, same ? 'Project already present' : 'Project title conflict');
      continue;
    }
    if (dryRun) {
      knownProjects.add(prj.id);
      push('music_project', 'music_projects', prj.id, 'migrated', prj.id, null, 'Dry-run validated project');
      continue;
    }
    try {
      const res = await engine.createMusicProject({
        projectId: prj.id,
        title: prj.title,
        artist: prj.artist,
        releaseKind: prj.releaseKind,
        status: prj.status,
        description: prj.description,
        songIds: prj.songIds,
        releaseIds: prj.releaseIds,
        dawProjectPaths: prj.dawProjectPaths,
        provenance: payload.sourceSystem,
        actor: 'os2-migrator',
      });
      knownProjects.add(prj.id);
      push('music_project', 'music_projects', prj.id, 'migrated', res.projectId, res.vaultPath, 'Migrated music project');
    } catch (err) {
      push('music_project', 'music_projects', prj.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  // 3. Songs & Song Revisions
  for (const s of payload.songs) {
    if (!s.id.trim() || !s.title.trim() || !s.artist.trim() || !s.language.trim()) {
      push('song', 'songs', s.id || '(missing)', 'incomplete', null, null, 'Song missing required id/title/artist/language');
      continue;
    }
    const existing = knownSongs.get(s.id);
    if (existing) {
      const entry = findById(db, s.id);
      const same = existing.title === s.title.trim() && existing.artist === s.artist.trim();
      push('song', 'songs', s.id, same ? 'skipped_idempotent' : 'conflicting', s.id, entry?.vaultPath ?? null, same ? 'Song already present identically' : 'Existing song identity conflicts on title/artist');
      continue;
    }
    if (dryRun) {
      knownSongs.set(s.id, { title: s.title.trim(), artist: s.artist.trim() });
      push('song', 'songs', s.id, 'migrated', s.id, null, 'Dry-run validated song');
      continue;
    }
    try {
      const res = await engine.createSong({
        id: s.id,
        title: s.title,
        artist: s.artist,
        language: s.language,
        actor: 'os2-migrator',
      });
      knownSongs.set(s.id, { title: s.title.trim(), artist: s.artist.trim() });
      push('song', 'songs', s.id, 'migrated', s.id, res.vaultPath, 'Migrated song');
    } catch (err) {
      push('song', 'songs', s.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  for (const rev of payload.songRevisions ?? []) {
    const revKey = `${rev.songId}:rev-${rev.revision}`;
    const songEntry = findById(db, rev.songId);
    if (!knownSongs.has(rev.songId)) {
      push('song_revision', 'song_revisions', revKey, 'incomplete', null, null, `Song "${rev.songId}" missing`);
      continue;
    }
    if (songEntry && Number(songEntry.frontmatter.revision ?? 1) >= rev.revision) {
      push('song_revision', 'song_revisions', revKey, 'skipped_idempotent', rev.songId, songEntry.vaultPath, 'Revision already applied');
      continue;
    }
    if (dryRun) {
      push('song_revision', 'song_revisions', revKey, 'migrated', rev.songId, null, 'Dry-run validated song revision');
      continue;
    }
    try {
      const res = await engine.createSongRevision({
        songPathOrId: rev.songId,
        summary: rev.summary ?? `${rev.field}: ${rev.content.slice(0, 80)}`,
        metadataPatch: { [rev.field]: rev.content },
        actor: rev.author ?? 'os2-migrator',
      });
      push('song_revision', 'song_revisions', revKey, 'migrated', rev.songId, res.revisionWrite.vaultPath, 'Migrated song revision');
    } catch (err) {
      push('song_revision', 'song_revisions', revKey, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  // 4. Lyric Versions & Creative Approvals
  for (const lyr of payload.lyricVersions) {
    const legacyId = lyr.id ?? `${lyr.lineageId}-v${lyr.version}`;
    const targetSongId = lyr.songId ?? payload.songs[0]?.id;
    if (!targetSongId || !knownSongs.has(targetSongId)) {
      push('lyric_version', 'lyric_versions', legacyId, 'incomplete', null, null, 'No matching song for lyric version');
      continue;
    }
    const faults = mixedScriptWords(lyr.sections);
    if (faults.length > 0) {
      push(
        'lyric_version',
        'lyric_versions',
        legacyId,
        'rejected',
        null,
        null,
        `Homoglyph guard F22 rejected mixed-script word(s): ${faults.map((f) => f.word).join(', ')}`,
      );
      continue;
    }
    const existingLyr = db
      .listIndexEntries('09_X3LIUS_MUSIC', 10_000)
      .find(
        (e) =>
          e.vaultPath.startsWith('09_X3LIUS_MUSIC/LYRICS/LYR-') &&
          e.frontmatter.lineage_id === lyr.lineageId &&
          Number(e.frontmatter.version) === lyr.version,
      );
    if (existingLyr) {
      push('lyric_version', 'lyric_versions', legacyId, 'skipped_idempotent', String(existingLyr.frontmatter.id), existingLyr.vaultPath, 'Lyric version already exists identically');
      continue;
    }
    if (lyr.approved && lyr.proposer && lyr.approver && lyr.proposer.trim().toLowerCase() === lyr.approver.trim().toLowerCase()) {
      push('creative_approval', 'creative_approvals', legacyId, 'rejected', null, null, `Self-approval forbidden (${lyr.proposer})`);
      continue;
    }
    if (dryRun) {
      push('lyric_version', 'lyric_versions', legacyId, 'migrated', legacyId, null, 'Dry-run validated lyric version');
      continue;
    }
    try {
      const sections = Object.entries(lyr.sections).map(([label, text]) => ({
        label,
        lines: text.split(/\r?\n/),
      }));
      const created = await engine.createLyricVersion({
        songPathOrId: targetSongId,
        lineageId: lyr.lineageId,
        title: lyr.title,
        language: lyr.language,
        sections,
        author: lyr.proposer ?? 'os2-migrator',
      });
      push('lyric_version', 'lyric_versions', legacyId, 'migrated', created.id, created.vaultPath, 'Migrated immutable lyric version');
      if (lyr.approved) {
        const req = engine.requestCreativeApproval({
          artifactPathOrId: created.id,
          proposer: lyr.proposer ?? 'x3lius-lyrics',
        });
        const appr = await engine.approveCreativeVersion({
          artifactPathOrId: created.id,
          approvalId: req.id,
          approver: lyr.approver ?? 'human-reviewer',
          reason: lyr.reason ?? 'OS2 approved creative version migration',
        });
        push('creative_approval', 'creative_approvals', `${legacyId}-appr`, 'migrated', req.id, appr.pointerWrite.vaultPath, 'Migrated creative approval');
      }
    } catch (err) {
      push('lyric_version', 'lyric_versions', legacyId, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  // 5. Takes & Critiques
  for (const tk of payload.takes ?? []) {
    if (!knownSongs.has(tk.songId) || !tk.audioSha256.trim()) {
      push('suno_take', 'suno_takes', tk.id, 'incomplete', null, null, `Take missing song "${tk.songId}" or audioSha256`);
      continue;
    }
    const existing = findById(db, tk.id);
    if (existing || knownTakes.has(tk.id)) {
      push('suno_take', 'suno_takes', tk.id, 'skipped_idempotent', tk.id, existing?.vaultPath ?? null, 'Take already exists');
      continue;
    }
    if (dryRun) {
      knownTakes.add(tk.id);
      push('suno_take', 'suno_takes', tk.id, 'migrated', tk.id, null, 'Dry-run validated AI take');
      continue;
    }
    try {
      const res = await engine.recordGenerationAttemptAndTake({
        attemptId: tk.submissionId,
        takeId: tk.id,
        songPathOrId: tk.songId,
        sunoModel: tk.sunoModel,
        stylePrompt: tk.stylePrompt,
        promptText: tk.stylePrompt,
        audioSha256: tk.audioSha256,
      });
      knownTakes.add(tk.id);
      push('suno_take', 'suno_takes', tk.id, 'migrated', res.takeId, res.takePath, 'Migrated AI take');
      for (const crit of tk.critiques ?? []) {
        const critRes = await engine.recordCritiqueAndRevision({
          targetPathOrId: res.takeId,
          overallScore: crit.verdict === 'pass' ? 9 : crit.verdict === 'needs_revision' ? 6 : 3,
          findings: [`[${crit.dimension}:${crit.verdict}] ${crit.notes}`],
          revisionSummary: `Migrated OS2 critique (${crit.dimension}): ${crit.notes}`,
          criticActor: crit.actor,
        });
        push('critique', 'critiques', `${tk.id}-${crit.dimension}`, 'migrated', critRes.critiqueId, critRes.critiquePath, 'Migrated take critique');
      }
    } catch (err) {
      push('suno_take', 'suno_takes', tk.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  // 6. Mix Versions & Master Versions
  for (const mx of payload.mixVersions ?? []) {
    if (!knownSongs.has(mx.songId) || !mx.audioSha256.trim()) {
      push('mix_version', 'mix_versions', mx.id, 'incomplete', null, null, 'Mix missing song or audioSha256');
      continue;
    }
    const existing = findById(db, mx.id);
    if (existing || knownMixes.has(mx.id)) {
      push('mix_version', 'mix_versions', mx.id, 'skipped_idempotent', mx.id, existing?.vaultPath ?? null, 'Mix version already present');
      continue;
    }
    if (dryRun) {
      knownMixes.add(mx.id);
      push('mix_version', 'mix_versions', mx.id, 'migrated', mx.id, null, 'Dry-run validated mix version');
      continue;
    }
    try {
      const res = await engine.recordMixVersion({
        mixId: mx.id,
        songPathOrId: mx.songId,
        projectId: mx.projectId,
        version: mx.version,
        title: mx.title,
        audioSha256: mx.audioSha256,
        integratedLufs: mx.integratedLufs,
        truePeakDbtp: mx.truePeakDbtp,
        dawSessionId: mx.dawSessionId,
        audioAnalysisId: mx.audioAnalysisId,
        notes: mx.notes,
        provenance: payload.sourceSystem,
      });
      knownMixes.add(mx.id);
      push('mix_version', 'mix_versions', mx.id, 'migrated', res.mixId, res.vaultPath, 'Migrated mix version');
    } catch (err) {
      push('mix_version', 'mix_versions', mx.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  // 7. Releases (create draft first, assign UPC later with tracks/splits so release calendar guards apply!)
  const releasesToTransition: typeof payload.releases[number][] = [];
  for (const rel of payload.releases) {
    if (!rel.id.trim() || !rel.title.trim() || !rel.artist.trim()) {
      push('release', 'releases', rel.id || '(missing)', 'incomplete', null, null, 'Release missing id/title/artist');
      continue;
    }
    if (rel.upc && !isValidGs1Code(rel.upc)) {
      push('release', 'releases', rel.id, 'rejected', null, null, `Invalid GS1 UPC check digit "${rel.upc}"`);
      continue;
    }
    const existing = knownReleases.get(rel.id);
    if (existing) {
      const entry = findById(db, rel.id);
      const same = existing.title === rel.title.trim() && existing.kind === rel.kind && existing.upc === rel.upc;
      push(
        'release',
        'releases',
        rel.id,
        same ? 'skipped_idempotent' : 'conflicting',
        rel.id,
        entry?.vaultPath ?? null,
        same ? 'Release already exists identically' : `Existing release conflicts on title/kind/upc`,
      );
      continue;
    }
    if (rel.upc && [...knownReleases.values()].some((r) => r.upc === rel.upc)) {
      push('release', 'releases', rel.id, 'conflicting', null, null, `Duplicate UPC "${rel.upc}" on another release`);
      continue;
    }
    if (dryRun) {
      knownReleases.set(rel.id, { title: rel.title.trim(), kind: rel.kind, upc: rel.upc });
      push('release', 'releases', rel.id, 'migrated', rel.id, null, 'Dry-run validated release');
      continue;
    }
    try {
      const res = await engine.createRelease({
        id: rel.id,
        title: rel.title,
        artist: rel.artist,
        kind: rel.kind,
        actor: 'os2-migrator',
      });
      if (rel.upc) {
        await engine.assignUpc({ releasePathOrId: rel.id, upc: rel.upc, actor: 'os2-migrator' });
      }
      knownReleases.set(rel.id, { title: rel.title.trim(), kind: rel.kind, upc: rel.upc });
      if (rel.status !== 'draft') releasesToTransition.push(rel);
      push('release', 'releases', rel.id, 'migrated', rel.id, res.vaultPath, 'Migrated release (UPC preserved)');
    } catch (err) {
      push('release', 'releases', rel.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  // 8. Tracks + ISRCs
  for (const trk of payload.tracks) {
    if (!trk.id.trim() || !trk.releaseId.trim() || !trk.title.trim()) {
      push('track', 'tracks', trk.id || '(missing)', 'incomplete', null, null, 'Track missing id/releaseId/title');
      continue;
    }
    if (!knownReleases.has(trk.releaseId)) {
      push('track', 'tracks', trk.id, 'incomplete', null, null, `Parent release "${trk.releaseId}" missing`);
      continue;
    }
    if (trk.isrc && !isValidIsrcCode(trk.isrc)) {
      push('track', 'tracks', trk.id, 'rejected', null, null, `Malformed ISRC "${trk.isrc}"`);
      continue;
    }
    if (Boolean(trk.takeId) === Boolean(trk.sourcePath)) {
      push('track', 'tracks', trk.id, 'incomplete', null, null, 'Track requires exactly one of takeId or sourcePath');
      continue;
    }
    const existing = knownTracks.get(trk.id);
    if (existing) {
      const entry = findById(db, trk.id);
      const same = existing.releaseId === trk.releaseId && existing.position === trk.position && existing.isrc === trk.isrc;
      push(
        'track',
        'tracks',
        trk.id,
        same ? 'skipped_idempotent' : 'conflicting',
        trk.id,
        entry?.vaultPath ?? null,
        same ? 'Track already exists identically' : 'Existing track conflicts on release/position/isrc',
      );
      continue;
    }
    if (trk.isrc && [...knownTracks.values()].some((t) => t.isrc === trk.isrc)) {
      push('track', 'tracks', trk.id, 'conflicting', null, null, `Duplicate ISRC "${trk.isrc}" already assigned`);
      continue;
    }
    if (dryRun) {
      knownTracks.set(trk.id, { releaseId: trk.releaseId, position: trk.position, isrc: trk.isrc });
      push('track', 'tracks', trk.id, 'migrated', trk.id, null, 'Dry-run validated track');
      continue;
    }
    try {
      const reg = await engine.registerTrack({
        id: trk.id,
        releasePathOrId: trk.releaseId,
        position: trk.position,
        title: trk.title,
        songId: trk.songId,
        takePathOrId: trk.takeId,
        sourceRef: trk.sourcePath,
        actor: 'os2-migrator',
      });
      if (trk.isrc) {
        await engine.assignIsrc({ trackPathOrId: trk.id, isrc: trk.isrc, actor: 'os2-migrator' });
      }
      knownTracks.set(trk.id, { releaseId: trk.releaseId, position: trk.position, isrc: trk.isrc });
      push('track', 'tracks', trk.id, 'migrated', trk.id, reg.vaultPath, 'Migrated track & ISRC');
    } catch (err) {
      push('track', 'tracks', trk.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  // 9. Master Versions (after Tracks exist so trackId resolves cleanly!)
  for (const ms of payload.masterVersions ?? []) {
    if (!knownSongs.has(ms.songId) || !ms.audioSha256.trim()) {
      push('master_version', 'master_versions', ms.id, 'incomplete', null, null, 'Master missing song or audioSha256');
      continue;
    }
    if (ms.isrc && !isValidIsrcCode(ms.isrc)) {
      push('master_version', 'master_versions', ms.id, 'rejected', null, null, `Invalid ISRC "${ms.isrc}"`);
      continue;
    }
    if (ms.truePeakDbtp !== undefined && ms.truePeakDbtp !== null && ms.truePeakDbtp > 0.0) {
      push('master_version', 'master_versions', ms.id, 'rejected', null, null, `Master truePeakDbtp ${ms.truePeakDbtp} > 0.0 dBTP`);
      continue;
    }
    const existing = findById(db, ms.id);
    if (existing || knownMasters.has(ms.id)) {
      push('master_version', 'master_versions', ms.id, 'skipped_idempotent', ms.id, existing?.vaultPath ?? null, 'Master version already present');
      continue;
    }
    if (dryRun) {
      knownMasters.add(ms.id);
      push('master_version', 'master_versions', ms.id, 'migrated', ms.id, null, 'Dry-run validated master version');
      continue;
    }
    try {
      const res = await engine.recordMasterVersion({
        masterId: ms.id,
        songPathOrId: ms.songId,
        trackPathOrId: ms.trackId,
        mixVersionId: ms.mixVersionId,
        version: ms.version,
        title: ms.title,
        audioSha256: ms.audioSha256,
        integratedLufs: ms.integratedLufs,
        truePeakDbtp: ms.truePeakDbtp,
        isrc: ms.isrc,
        provenance: payload.sourceSystem,
      });
      if (ms.approved) {
        const apprReq = engine.requestMasterApproval({
          masterPathOrId: res.masterId,
          proposer: ms.proposer ?? 'x3lius-mix-master',
        });
        await engine.approveMasterVersion({
          masterPathOrId: res.masterId,
          approvalId: apprReq.id,
          approver: ms.approver ?? 'human-mastering-lead',
          reason: ms.reason ?? 'OS2 approved master migration',
        });
      }
      knownMasters.add(ms.id);
      push('master_version', 'master_versions', ms.id, 'migrated', res.masterId, res.vaultPath, 'Migrated master version');
    } catch (err) {
      push('master_version', 'master_versions', ms.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  // 10. Rights Splits
  const sortedSplits = [...payload.splits].sort((a, b) => a.version - b.version);
  for (const sp of sortedSplits) {
    const legacyId = sp.id ?? `${sp.trackId}-v${sp.version}`;
    if (!knownTracks.has(sp.trackId)) {
      push('rights_split', 'rights_splits', legacyId, 'incomplete', null, null, `Track "${sp.trackId}" missing`);
      continue;
    }
    try {
      validateRightsSharesMilli(sp.shares);
    } catch (err) {
      push('rights_split', 'rights_splits', legacyId, 'rejected', null, null, err instanceof Error ? err.message : String(err));
      continue;
    }
    const key = `${sp.trackId}::v${sp.version}`;
    if (knownSplits.has(key)) {
      const existingSplit = db
        .listIndexEntries('06_RECORDS', 10_000)
        .find((e) => e.vaultPath.startsWith('06_RECORDS/RIGHTS/SPLT-') && e.frontmatter.track_id === sp.trackId && Number(e.frontmatter.version) === sp.version);
      push('rights_split', 'rights_splits', legacyId, 'skipped_idempotent', existingSplit ? String(existingSplit.frontmatter.id) : legacyId, existingSplit?.vaultPath ?? null, 'Rights split version already exists');
      continue;
    }
    if (dryRun) {
      knownSplits.add(key);
      push('rights_split', 'rights_splits', legacyId, 'migrated', legacyId, null, 'Dry-run validated rights split');
      continue;
    }
    try {
      const res = await engine.writeRightsSplits({
        trackPathOrId: sp.trackId,
        shares: sp.shares,
        actor: 'os2-migrator',
      });
      knownSplits.add(`${res.trackId}::v${res.version}`);
      push('rights_split', 'rights_splits', legacyId, 'migrated', res.id, res.vaultPath, 'Migrated versioned rights split');
    } catch (err) {
      push('rights_split', 'rights_splits', legacyId, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  // 11. Split Proposals
  for (const pr of payload.splitProposals ?? []) {
    if (!knownTracks.has(pr.trackId)) {
      push('split_proposal', 'split_proposals', pr.id, 'incomplete', null, null, `Track "${pr.trackId}" missing`);
      continue;
    }
    const existing = findById(db, pr.id);
    if (existing) {
      push('split_proposal', 'split_proposals', pr.id, 'skipped_idempotent', pr.id, existing.vaultPath, 'Split proposal already present');
      continue;
    }
    try {
      validateRightsSharesMilli(pr.shares);
    } catch (err) {
      push('split_proposal', 'split_proposals', pr.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
      continue;
    }
    if (pr.status === 'approved' && pr.approver && pr.approver.trim().toLowerCase() === pr.proposer.trim().toLowerCase()) {
      push('split_proposal', 'split_proposals', pr.id, 'rejected', null, null, `Self-approval forbidden (${pr.proposer})`);
      continue;
    }
    if (dryRun) {
      push('split_proposal', 'split_proposals', pr.id, 'migrated', pr.id, null, 'Dry-run validated split proposal');
      continue;
    }
    try {
      const queued = await engine.proposeRightsSplitChange({
        proposalId: pr.id,
        trackPathOrId: pr.trackId,
        currentVersion: pr.expectedVersion,
        shares: pr.shares,
        proposer: pr.proposer,
        reason: pr.reason,
        provenance: payload.sourceSystem,
      });
      if (pr.status === 'approved') {
        await engine.applyApprovedSplitProposal({
          proposalId: queued.proposalId,
          approver: pr.approver ?? 'human-rights-lead',
          reason: pr.decisionReason ?? 'OS2 approved split proposal migration',
        });
      }
      push('split_proposal', 'split_proposals', pr.id, 'migrated', queued.proposalId, queued.vaultPath, 'Migrated split proposal');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const disp: RecordsMigrationDisposition =
        msg.includes('STALE_SPLIT_VERSION') || msg.includes('CONCURRENT_SPLIT_MODIFICATION') ? 'conflicting' : 'rejected';
      push('split_proposal', 'split_proposals', pr.id, disp, null, null, msg);
    }
  }

  // 12. Transition Non-Draft Releases now that Tracks, ISRCs, UPCs & Splits are migrated!
  for (const rel of releasesToTransition) {
    try {
      const check = engine.runRightsCheck(rel.id);
      if (check.verdict.verdict !== 'pass') {
        throw new Error(`Rights check failed: ${check.verdict.flags.map((f) => f.detail).join('; ')}`);
      }
      await engine.transitionReleaseCalendar({
        releasePathOrId: rel.id,
        action: 'schedule',
        releaseDate: rel.releaseDate ?? new Date().toISOString().slice(0, 10),
        rightsCheckRunId: check.runId,
        todayIso: rel.status === 'released' && rel.releaseDate ? rel.releaseDate : undefined,
        actor: rel.approvedBy ?? 'os2-migrator',
      });
      if (rel.status === 'released') {
        await engine.transitionReleaseCalendar({
          releasePathOrId: rel.id,
          action: 'release',
          actor: rel.approvedBy ?? 'os2-migrator',
        });
      }
    } catch (err) {
      push('release', 'releases_calendar', rel.id, 'rejected', rel.id, findById(db, rel.id)?.vaultPath ?? null, `Release scheduling blocked: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 13. Credits & Credit Retractions
  for (const cr of payload.credits ?? []) {
    if (!CREDIT_ROLES.includes(cr.role)) {
      push('credit', 'credits', cr.id, 'rejected', null, null, `Invalid role "${cr.role}"`);
      continue;
    }
    const targetExists = cr.targetType === 'song' ? knownSongs.has(cr.targetId) : knownTracks.has(cr.targetId);
    if (!targetExists || !knownContributors.has(cr.personId)) {
      push('credit', 'credits', cr.id, 'incomplete', null, null, `Missing credit target or contributor "${cr.personId}"`);
      continue;
    }
    const existing = findById(db, cr.id);
    if (existing) {
      push('credit', 'credits', cr.id, 'skipped_idempotent', cr.id, existing.vaultPath, 'Credit already present');
      continue;
    }
    if (dryRun) {
      push('credit', 'credits', cr.id, 'migrated', cr.id, null, 'Dry-run validated credit');
      continue;
    }
    try {
      const res = await engine.writeCredit({
        creditId: cr.id,
        targetType: cr.targetType,
        targetPathOrId: cr.targetId,
        personPathOrId: cr.personId,
        role: cr.role,
        notes: cr.notes,
        provenance: payload.sourceSystem,
      });
      push('credit', 'credits', cr.id, 'migrated', res.creditId, res.vaultPath, 'Migrated credit');
    } catch (err) {
      push('credit', 'credits', cr.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  for (const crRet of payload.creditRetractions ?? []) {
    const legacyId = crRet.id ?? `cret-${crRet.creditId}`;
    if (!crRet.reason.trim()) {
      push('credit_retraction', 'credit_retractions', legacyId, 'rejected', null, null, 'Retraction missing reason');
      continue;
    }
    const existing = findById(db, legacyId);
    if (existing) {
      push('credit_retraction', 'credit_retractions', legacyId, 'skipped_idempotent', legacyId, existing.vaultPath, 'Credit retraction already present');
      continue;
    }
    if (dryRun) {
      push('credit_retraction', 'credit_retractions', legacyId, 'migrated', legacyId, null, 'Dry-run validated credit retraction');
      continue;
    }
    try {
      const res = await engine.retractCredit({ creditId: crRet.creditId, reason: crRet.reason, actor: crRet.actor });
      push('credit_retraction', 'credit_retractions', legacyId, 'migrated', res.retractionId, res.vaultPath, 'Migrated credit retraction');
    } catch (err) {
      push('credit_retraction', 'credit_retractions', legacyId, 'incomplete', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  // 14. Distribution: Platform Links, Artwork & Deliveries
  for (const pl of payload.platformLinks ?? []) {
    if (!PLATFORM_NAMES.includes(pl.platform) || !isValidPlatformUrl(pl.platform, pl.url)) {
      push('platform_link', 'platform_links', pl.id, 'rejected', null, null, `Invalid platform/URL "${pl.platform}" -> "${pl.url}"`);
      continue;
    }
    const targetExists =
      pl.targetType === 'song'
        ? knownSongs.has(pl.targetId)
        : pl.targetType === 'release'
          ? knownReleases.has(pl.targetId)
          : knownTracks.has(pl.targetId);
    if (!targetExists) {
      push('platform_link', 'platform_links', pl.id, 'incomplete', null, null, `Missing ${pl.targetType} "${pl.targetId}"`);
      continue;
    }
    const existing = findById(db, pl.id);
    if (existing) {
      push('platform_link', 'platform_links', pl.id, 'skipped_idempotent', pl.id, existing.vaultPath, 'Platform link already present');
      continue;
    }
    if (dryRun) {
      push('platform_link', 'platform_links', pl.id, 'migrated', pl.id, null, 'Dry-run validated platform link');
      continue;
    }
    try {
      const res = await engine.writePlatformLink({
        linkId: pl.id,
        targetType: pl.targetType,
        targetPathOrId: pl.targetId,
        platform: pl.platform,
        url: pl.url,
        handle: pl.handle,
        provenance: payload.sourceSystem,
      });
      push('platform_link', 'platform_links', pl.id, 'migrated', res.linkId, res.vaultPath, 'Migrated platform link');
    } catch (err) {
      push('platform_link', 'platform_links', pl.id, 'conflicting', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  for (const plr of payload.platformLinkRetractions ?? []) {
    const legacyId = plr.id ?? `plrt-${plr.linkId}`;
    const existing = findById(db, legacyId);
    if (existing) {
      push('platform_link_retraction', 'platform_link_retractions', legacyId, 'skipped_idempotent', legacyId, existing.vaultPath, 'Platform link retraction already present');
      continue;
    }
    if (dryRun) {
      push('platform_link_retraction', 'platform_link_retractions', legacyId, 'migrated', legacyId, null, 'Dry-run validated platform link retraction');
      continue;
    }
    try {
      const res = await engine.retractPlatformLink({ linkId: plr.linkId, reason: plr.reason, actor: plr.actor });
      push('platform_link_retraction', 'platform_link_retractions', legacyId, 'migrated', res.retractionId, res.vaultPath, 'Migrated platform link retraction');
    } catch (err) {
      push('platform_link_retraction', 'platform_link_retractions', legacyId, 'incomplete', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  for (const art of payload.releaseArtwork ?? []) {
    if (!knownReleases.has(art.releaseId) || !art.sha256.trim()) {
      push('release_artwork', 'release_artwork', art.id, 'incomplete', null, null, 'Missing release or artwork sha256');
      continue;
    }
    const existing = findById(db, art.id);
    if (existing) {
      push('release_artwork', 'release_artwork', art.id, 'skipped_idempotent', art.id, existing.vaultPath, 'Release artwork already present');
      continue;
    }
    if (dryRun) {
      push('release_artwork', 'release_artwork', art.id, 'migrated', art.id, null, 'Dry-run validated release artwork');
      continue;
    }
    try {
      const res = await engine.setReleaseArtwork({
        artworkId: art.id,
        releasePathOrId: art.releaseId,
        assetPath: art.assetPath,
        sha256: art.sha256,
        widthPx: art.widthPx,
        heightPx: art.heightPx,
        format: art.format,
        notes: art.notes,
        provenance: payload.sourceSystem,
      });
      push('release_artwork', 'release_artwork', art.id, 'migrated', res.artworkId, res.vaultPath, 'Migrated release artwork');
    } catch (err) {
      push('release_artwork', 'release_artwork', art.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  for (const dlv of payload.releaseDeliveries ?? []) {
    if (!DELIVERY_STATUSES.includes(dlv.status) || !dlv.distributor.trim() || !knownReleases.has(dlv.releaseId)) {
      push('release_delivery', 'release_deliveries', dlv.id, 'incomplete', null, null, 'Missing release, distributor, or invalid status');
      continue;
    }
    const existing = findById(db, dlv.id);
    if (existing) {
      push('release_delivery', 'release_deliveries', dlv.id, 'skipped_idempotent', dlv.id, existing.vaultPath, 'Delivery already present');
      continue;
    }
    if (dryRun) {
      push('release_delivery', 'release_deliveries', dlv.id, 'migrated', dlv.id, null, 'Dry-run validated delivery');
      continue;
    }
    try {
      const res = await engine.recordReleaseDelivery({
        deliveryId: dlv.id,
        releasePathOrId: dlv.releaseId,
        distributor: dlv.distributor,
        status: dlv.status,
        deliveryDate: dlv.deliveryDate,
        externalRef: dlv.externalRef,
        notes: dlv.notes,
        provenance: payload.sourceSystem,
      });
      push('release_delivery', 'release_deliveries', dlv.id, 'migrated', res.deliveryId, res.vaultPath, 'Migrated release delivery');
    } catch (err) {
      push('release_delivery', 'release_deliveries', dlv.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  // 15. Song Links & Retractions + DAW Catalog Links
  for (const sl of payload.songLinks ?? []) {
    if (!knownSongs.has(sl.songId)) {
      push('song_link', 'song_links', sl.id, 'incomplete', null, null, `Song "${sl.songId}" missing`);
      continue;
    }
    const existing = findById(db, sl.id);
    if (existing) {
      push('song_link', 'song_links', sl.id, 'skipped_idempotent', sl.id, existing.vaultPath, 'Song link already present');
      continue;
    }
    if (dryRun) {
      push('song_link', 'song_links', sl.id, 'migrated', sl.id, null, 'Dry-run validated song link');
      continue;
    }
    try {
      const res = await engine.linkSongTarget({
        linkId: sl.id,
        songPathOrId: sl.songId,
        linkType: sl.linkType,
        targetId: sl.targetId,
        notes: sl.notes,
        provenance: payload.sourceSystem,
      });
      push('song_link', 'song_links', sl.id, 'migrated', res.linkId, res.vaultPath, 'Migrated song link');
    } catch (err) {
      push('song_link', 'song_links', sl.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  for (const slr of payload.songLinkRetractions ?? []) {
    const legacyId = slr.id ?? `slrt-${slr.linkId}`;
    const existing = findById(db, legacyId);
    if (existing) {
      push('song_link_retraction', 'song_link_retractions', legacyId, 'skipped_idempotent', legacyId, existing.vaultPath, 'Song link retraction already present');
      continue;
    }
    if (dryRun) {
      push('song_link_retraction', 'song_link_retractions', legacyId, 'migrated', legacyId, null, 'Dry-run validated song link retraction');
      continue;
    }
    try {
      const res = await engine.retractSongLink({ linkId: slr.linkId, reason: slr.reason, actor: slr.actor });
      push('song_link_retraction', 'song_link_retractions', legacyId, 'migrated', res.retractionId, res.vaultPath, 'Migrated song link retraction');
    } catch (err) {
      push('song_link_retraction', 'song_link_retractions', legacyId, 'incomplete', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  for (const dw of payload.dawLinks ?? []) {
    const existing = findById(db, dw.id);
    if (existing) {
      push('daw_catalog_link', 'daw_links', dw.id, 'skipped_idempotent', dw.id, existing.vaultPath, 'DAW catalog link already present');
      continue;
    }
    if (dryRun) {
      push('daw_catalog_link', 'daw_links', dw.id, 'migrated', dw.id, null, 'Dry-run validated DAW catalog link');
      continue;
    }
    try {
      const res = await integrator.linkDawProductionToCatalog({
        linkId: dw.id,
        targetKind: dw.targetKind,
        targetPathOrId: dw.targetId,
        dawHost: dw.dawHost,
        dawProjectPath: dw.dawProjectPath,
        dawSessionId: dw.dawSessionId,
        audioAnalysisId: dw.audioAnalysisId,
        audioAnalysisVerdict: dw.audioAnalysisVerdict,
        pluginChainId: dw.pluginChainId,
        workflowIds: dw.workflowIds,
        hasUnsavedLiveChanges: dw.hasUnsavedLiveChanges,
        provenance: payload.sourceSystem,
      });
      push('daw_catalog_link', 'daw_links', dw.id, 'migrated', res.linkId, res.vaultPath, 'Migrated explicit DAW<->Catalog link');
    } catch (err) {
      push('daw_catalog_link', 'daw_links', dw.id, 'rejected', null, null, err instanceof Error ? err.message : String(err));
    }
  }

  const scan = options.legacyMarkdownRootDirs?.length
    ? await scanLegacyRecordsVaultMarkdown({ legacyMarkdownRootDirs: options.legacyMarkdownRootDirs, db })
    : { scannedDirs: [], files: [] };

  const totals = {
    totalEvaluated: items.length,
    migrated: items.filter((i) => i.disposition === 'migrated').length,
    skippedIdempotent: items.filter((i) => i.disposition === 'skipped_idempotent').length,
    rejected: items.filter((i) => i.disposition === 'rejected').length,
    conflicting: items.filter((i) => i.disposition === 'conflicting').length,
    incomplete: items.filter((i) => i.disposition === 'incomplete').length,
  };

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    sourceSystem: payload.sourceSystem,
    dryRun,
    legacyDataUntouched: true,
    totals,
    items,
    legacyMarkdownScan: {
      scannedDirs: scan.scannedDirs,
      totalMarkdownFiles: scan.files.length,
      validOs3Count: scan.files.filter((f) => f.disposition === 'valid_os3').length,
      idempotentExistingCount: scan.files.filter((f) => f.disposition === 'idempotent_existing').length,
      incompleteLegacyCount: scan.files.filter((f) => f.disposition === 'incomplete_legacy').length,
      invalidFrontmatterCount: scan.files.filter((f) => f.disposition === 'invalid_frontmatter').length,
      files: scan.files,
    },
    transactionalBoundaries: assessRecordsTransactionalBoundaries(),
  };
};

export const verifyRecordsMusicParity = async (options: {
  readonly payload: Os2FullRecordsMusicExport;
  readonly engine: Os3RecordsEngine;
  readonly report: RecordsMigrationReport;
  readonly vault: VaultEngine;
  readonly db: SqliteRuntimeDb;
}): Promise<RecordsParityReport> => {
  const { payload, engine, report, vault, db } = options;
  await vault.scanVault({ full: true });
  const recEntries = db.listIndexEntries('06_RECORDS', 20_000);
  const musicEntries = db.listIndexEntries('09_X3LIUS_MUSIC', 20_000);
  const allIndexedIds = new Set(
    [...recEntries, ...musicEntries]
      .map((e) => (typeof e.frontmatter.id === 'string' ? e.frontmatter.id : ''))
      .filter(Boolean),
  );

  const discrepancies: string[] = [];
  const byDomain: Record<string, RecordsParityDomainStats> = {};

  const computeDomainStats = (
    domainKey: string,
    entityType: RecordsMigrationEntityType,
    expectedValidIds: readonly string[],
    totalSourceCount: number,
  ) => {
    const items = report.items.filter((i) => i.entityType === entityType);
    const missingIds = expectedValidIds.filter((id) => !allIndexedIds.has(id));
    for (const mid of missingIds) {
      discrepancies.push(`Missing valid ${domainKey} entity "${mid}" in OS3 Vault`);
    }
    byDomain[domainKey] = {
      sourceCount: totalSourceCount,
      validSourceCount: expectedValidIds.length,
      migratedCount: items.filter((i) => i.disposition === 'migrated').length,
      skippedIdempotentCount: items.filter((i) => i.disposition === 'skipped_idempotent').length,
      presentInOs3Count: expectedValidIds.length - missingIds.length,
      missingIds,
    };
  };

  const validIdsFor = (entityType: RecordsMigrationEntityType) =>
    report.items
      .filter((i) => i.entityType === entityType && (i.disposition === 'migrated' || i.disposition === 'skipped_idempotent'))
      .map((i) => i.os3Id ?? i.legacyId);

  computeDomainStats('contributors', 'contributor', validIdsFor('contributor'), payload.people?.length ?? 0);
  computeDomainStats('musicProjects', 'music_project', validIdsFor('music_project'), payload.musicProjects?.length ?? 0);
  computeDomainStats('songs', 'song', validIdsFor('song'), payload.songs.length);
  computeDomainStats('lyricVersions', 'lyric_version', validIdsFor('lyric_version'), payload.lyricVersions.length);
  computeDomainStats('takes', 'suno_take', validIdsFor('suno_take'), payload.takes?.length ?? 0);
  computeDomainStats('mixVersions', 'mix_version', validIdsFor('mix_version'), payload.mixVersions?.length ?? 0);
  computeDomainStats('masterVersions', 'master_version', validIdsFor('master_version'), payload.masterVersions?.length ?? 0);
  computeDomainStats('releases', 'release', validIdsFor('release'), payload.releases.length);
  computeDomainStats('tracks', 'track', validIdsFor('track'), payload.tracks.length);
  computeDomainStats('rightsSplits', 'rights_split', validIdsFor('rights_split'), payload.splits.length);
  computeDomainStats('credits', 'credit', validIdsFor('credit'), payload.credits?.length ?? 0);
  computeDomainStats('platformLinks', 'platform_link', validIdsFor('platform_link'), payload.platformLinks?.length ?? 0);
  computeDomainStats('releaseArtwork', 'release_artwork', validIdsFor('release_artwork'), payload.releaseArtwork?.length ?? 0);
  computeDomainStats('releaseDeliveries', 'release_delivery', validIdsFor('release_delivery'), payload.releaseDeliveries?.length ?? 0);
  computeDomainStats('dawCatalogLinks', 'daw_catalog_link', validIdsFor('daw_catalog_link'), payload.dawLinks?.length ?? 0);

  const readinessChecks = engine.computeCatalogReadinessChecks();

  return {
    ok: discrepancies.length === 0,
    checkedAt: new Date().toISOString(),
    vaultEntityCount: recEntries.length + musicEntries.length,
    sqliteIndexCount: db.getIndexStats().totalFiles,
    byDomain,
    readinessChecks,
    discrepancies,
  };
};

export const formatRecordsMigrationReportMarkdown = (
  report: RecordsMigrationReport,
  parity?: RecordsParityReport,
): string => {
  const lines: string[] = [
    '# X3LIUS Records + Music System OS2 -> OS3 Migration & Parity Report',
    '',
    `- **Source System:** \`${report.sourceSystem}\``,
    `- **Started:** \`${report.startedAt}\``,
    `- **Completed:** \`${report.completedAt}\``,
    `- **Dry Run:** \`${String(report.dryRun)}\``,
    `- **Legacy OS2 Data Untouched:** \`${String(report.legacyDataUntouched)}\``,
    '',
    '## Summary Totals',
    '',
    '| Metric | Count |',
    '| --- | ---: |',
    `| Total Export Items Evaluated | ${report.totals.totalEvaluated} |`,
    `| Migrated into OS3 Vault | ${report.totals.migrated} |`,
    `| Skipped (Idempotent) | ${report.totals.skippedIdempotent} |`,
    `| Rejected (Invariant Violation) | ${report.totals.rejected} |`,
    `| Conflicting (Preserved Without Overwrite) | ${report.totals.conflicting} |`,
    `| Incomplete (Missing Foreign Key / Required Field) | ${report.totals.incomplete} |`,
    '',
    '## Legacy Vault Markdown Scan (`06_RECORDS` & `09_X3LIUS_MUSIC`)',
    '',
    `- **Scanned Directories:** ${report.legacyMarkdownScan.scannedDirs.length > 0 ? report.legacyMarkdownScan.scannedDirs.map((d) => `\`${d}\``).join(', ') : '(none)'}`,
    `- **Total Markdown Files Scanned:** ${report.legacyMarkdownScan.totalMarkdownFiles}`,
    `- **Valid OS3 Entities:** ${report.legacyMarkdownScan.validOs3Count}`,
    `- **Idempotent Existing (in SQLite):** ${report.legacyMarkdownScan.idempotentExistingCount}`,
    `- **Incomplete / Pre-OS3 Legacy Markdown:** ${report.legacyMarkdownScan.incompleteLegacyCount}`,
    `- **Invalid YAML Frontmatter:** ${report.legacyMarkdownScan.invalidFrontmatterCount}`,
  ];

  if (report.legacyMarkdownScan.files.length > 0) {
    lines.push('', '| File | Dir Group | Schema | ID | Disposition | Missing Fields |', '| --- | --- | --- | --- | --- | --- |');
    for (const f of report.legacyMarkdownScan.files) {
      lines.push(
        `| \`${f.relativePath}\` | \`${f.directoryGroup}\` | \`${f.schema ?? '-'}\` | \`${f.entityId ?? '-'}\` | \`${f.disposition}\` | ${f.missingOs3Fields.length > 0 ? f.missingOs3Fields.join(', ') : '-'} |`,
      );
    }
  }

  lines.push('', '## Transactional Boundaries & Selective OS2 Retention', '', '| OS2 Mechanism | OS3 Guarantee | Status | Notes |', '| --- | --- | --- | --- |');
  for (const tb of report.transactionalBoundaries) {
    lines.push(`| ${tb.os2Mechanism} | ${tb.os3Guarantee} | \`${tb.status}\` | ${tb.notes} |`);
  }

  if (report.items.some((i) => i.disposition !== 'migrated' && i.disposition !== 'skipped_idempotent')) {
    lines.push('', '## Rejected, Conflicting & Incomplete Items', '', '| Domain | Legacy ID | Disposition | Reason |', '| --- | --- | --- | --- |');
    for (const it of report.items) {
      if (it.disposition === 'migrated' || it.disposition === 'skipped_idempotent') continue;
      lines.push(`| \`${it.entityType}\` | \`${it.legacyId}\` | \`${it.disposition}\` | ${it.reason} |`);
    }
  }

  if (parity) {
    lines.push(
      '',
      '## Post-Migration Parity & Readiness Verification',
      '',
      `- **Parity Passed:** \`${String(parity.ok)}\``,
      `- **Records + Music Vault Entities:** ${parity.vaultEntityCount}`,
      `- **Readiness Blockers / Warnings:** ${parity.readinessChecks.blockerCount} / ${parity.readinessChecks.warningCount}`,
      '',
      '| Domain | Source | Valid Source | Migrated | Skipped Idempotent | Present in OS3 | Missing |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const [k, s] of Object.entries(parity.byDomain)) {
      lines.push(`| \`${k}\` | ${s.sourceCount} | ${s.validSourceCount} | ${s.migratedCount} | ${s.skippedIdempotentCount} | ${s.presentInOs3Count} | ${s.missingIds.length} |`);
    }
    if (parity.discrepancies.length > 0) {
      lines.push('', '### Discrepancies', ...parity.discrepancies.map((d) => `- ${d}`));
    }
  }

  return `${lines.join('\n')}\n`;
};
