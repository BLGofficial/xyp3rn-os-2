import type { AudioBrainAnalysisReport } from '../core/daw-brain/audio-brain/types.ts';
import type { PluginChainAnalysisReport, PluginChainGraph } from '../core/daw-brain/plugin-brain/types.ts';
import type { DawStateSnapshot } from '../core/daw-brain/types.ts';
import type { DawProductionWorkflowSpec } from '../core/daw-brain/workflows/daw-workflows.ts';
import type { SqliteRuntimeDb } from '../core/sqlite/client.ts';
import { serializeFrontmatterDocument } from '../core/vault-engine/frontmatter.ts';
import type { VaultEngine } from '../core/vault-engine/vault-engine.ts';
import { linkSongTarget, slugify } from './os3-records-catalog-ops.ts';
import type {
  DawCatalogLinkInput,
  DawCatalogLinkRecord,
  DawCatalogTargetKind,
  DawPromotionGuardReport,
} from './os3-records-types.ts';

export class DawCatalogBoundaryError extends Error {
  readonly code = 'DAW_PROJECT_NOT_AUTHORITATIVE_CATALOG';
  constructor(message: string) {
    super(message);
    this.name = 'DawCatalogBoundaryError';
  }
}

const TARGET_PREFIX_BY_KIND: Readonly<Record<DawCatalogTargetKind, readonly string[]>> = {
  song: ['09_X3LIUS_MUSIC/SONGS/SONG-'],
  music_project: ['09_X3LIUS_MUSIC/PROJECTS/MPRJ-'],
  album: ['06_RECORDS/RELEASES/REL-'],
  release: ['06_RECORDS/RELEASES/REL-'],
  mix_version: ['09_X3LIUS_MUSIC/EVALUATION/MIX-'],
  master_version: ['09_X3LIUS_MUSIC/EVALUATION/MSTR-'],
};

const findTarget = (db: SqliteRuntimeDb, kind: DawCatalogTargetKind, pathOrId: string) => {
  const prefixes = TARGET_PREFIX_BY_KIND[kind];
  const clean = pathOrId.trim();
  const direct = db.getIndexEntry(clean);
  if (direct && prefixes.some((p) => direct.vaultPath.startsWith(p))) return direct;
  return (
    db
      .listIndexEntries(undefined, 15_000)
      .find(
        (e) =>
          prefixes.some((p) => e.vaultPath.startsWith(p)) &&
          (e.vaultPath === clean || e.frontmatter.id === clean),
      ) ?? null
  );
};

/**
 * Integrates DAW Brain technical artifacts (sessions, .flp/.rpp project files,
 * AudioBrain diagnostic reports, Plugin Brain chains, and DAW workflows) into
 * authoritative X3LIUS/Records catalog entities without conflating DAW projects
 * with catalog authority.
 */
export class DawMusicCatalogIntegrator {
  readonly #vault: VaultEngine;
  readonly #db: SqliteRuntimeDb;

  constructor(options: { readonly vault: VaultEngine; readonly db: SqliteRuntimeDb }) {
    this.#vault = options.vault;
    this.#db = options.db;
  }

  /**
   * Explicitly links a DAW project/session/analysis/plugin-chain/workflow to an existing
   * Song, Project, Album, Release, Mix Version, or Master Version.
   * Refuses any attempt to mark a DAW project as an authoritative catalog record.
   */
  async linkDawProductionToCatalog(input: DawCatalogLinkInput): Promise<DawCatalogLinkRecord> {
    if (input.treatDawProjectAsAuthoritativeCatalog === true) {
      throw new DawCatalogBoundaryError(
        'Refused: a DAW project file (.flp/.rpp) or DAW session is never the authoritative Song or Release record.',
      );
    }
    if (!input.dawProjectPath.trim()) {
      throw new Error('DAW catalog link requires non-empty dawProjectPath');
    }
    const target = findTarget(this.#db, input.targetKind, input.targetPathOrId);
    if (!target) {
      throw new Error(`Authoritative ${input.targetKind} record not found: "${input.targetPathOrId}"`);
    }
    const targetId = String(target.frontmatter.id);
    if (input.targetKind === 'album' && target.frontmatter.kind !== 'album') {
      throw new Error(`Target "${targetId}" has kind="${String(target.frontmatter.kind)}", expected "album"`);
    }

    const linkId =
      input.linkId?.trim() ||
      `dwlk-${input.targetKind}-${slugify(targetId)}-${slugify(input.dawSessionId ?? input.dawProjectPath)}`;
    const dup = this.#db
      .listIndexEntries('06_RECORDS', 10_000)
      .find((e) => e.vaultPath.startsWith('06_RECORDS/CATALOG_LINKS/DWLK-') && e.frontmatter.id === linkId);
    if (dup) {
      throw new Error(`Duplicate DAW catalog link id "${linkId}"`);
    }

    const now = new Date().toISOString();
    const vaultPath = `06_RECORDS/CATALOG_LINKS/DWLK-${slugify(linkId.replace(/^dwlk-/, ''))}.md`;
    const workflowIds = [...(input.workflowIds ?? [])];
    const hasUnsaved = Boolean(input.hasUnsavedLiveChanges);

    const content = serializeFrontmatterDocument(
      {
        schema: 'xyp3rn.entity/v3',
        id: linkId,
        type: 'daw_catalog_link',
        title: `DAW Link (${input.dawHost}): ${target.title}`,
        target_kind: input.targetKind,
        target_id: targetId,
        target_ref: target.vaultPath,
        daw_host: input.dawHost,
        daw_project_path: input.dawProjectPath.trim(),
        daw_session_id: input.dawSessionId ?? null,
        daw_snapshot_id: input.dawSnapshotId ?? null,
        has_unsaved_live_changes: hasUnsaved,
        audio_analysis_id: input.audioAnalysisId ?? null,
        audio_analysis_verdict: input.audioAnalysisVerdict ?? null,
        audio_sha256: input.audioSha256 ?? null,
        plugin_chain_id: input.pluginChainId ?? null,
        workflow_ids: workflowIds,
        authoritative_catalog_record: false,
        domain: 'RECORDS',
        sector: '06_RECORDS',
        status: hasUnsaved || input.audioAnalysisVerdict === 'CRITICAL' ? 'paused' : 'active',
        version: 1,
        provenance: input.provenance,
        created_at: now,
        updated_at: now,
        tags: ['xyp3rn', 'os3', 'records', 'daw-brain-link', input.dawHost],
      },
      [
        `# DAW Catalog Link: ${target.title}`,
        '',
        `- **Authoritative Catalog Entity (${input.targetKind}):** [[${target.vaultPath.replace(/\.md$/, '')}|${targetId}]]`,
        `- **Authoritative Catalog Authority:** \`false\` (DAW session/project is production telemetry only)`,
        `- **DAW Host / Project:** \`${input.dawHost}\` — \`${input.dawProjectPath.trim()}\``,
        ...(input.dawSessionId ? [`- **Session ID:** \`${input.dawSessionId}\``] : []),
        ...(input.audioAnalysisId
          ? [`- **Audio Analysis:** \`${input.audioAnalysisId}\` (${input.audioAnalysisVerdict ?? 'UNSPECIFIED'})`]
          : []),
        ...(input.pluginChainId ? [`- **Plugin Chain:** \`${input.pluginChainId}\``] : []),
        ...(workflowIds.length > 0 ? [`- **DAW Workflows:** ${workflowIds.join(', ')}`] : []),
      ].join('\n'),
    );

    const written = await this.#vault.write({
      vaultPath,
      content,
      actor: input.actor ?? 'daw-catalog-integrator',
      writeMode: 'reject-overwrite',
      reason: `Link DAW session/project "${input.dawProjectPath}" to ${input.targetKind} ${targetId}`,
    });

    if (input.targetKind === 'song') {
      await linkSongTarget(
        { vault: this.#vault, db: this.#db },
        {
          songPathOrId: targetId,
          linkType: input.dawSessionId ? 'daw_session' : 'daw_project',
          targetId: input.dawSessionId ?? input.dawProjectPath.trim(),
          targetVaultPath: written.vaultPath,
          provenance: input.provenance,
          actor: input.actor,
        },
      );
    }

    return {
      linkId,
      vaultPath: written.vaultPath,
      targetKind: input.targetKind,
      targetId,
      dawHost: input.dawHost,
      dawProjectPath: input.dawProjectPath.trim(),
      dawSessionId: input.dawSessionId ?? null,
      audioAnalysisId: input.audioAnalysisId ?? null,
      audioAnalysisVerdict: input.audioAnalysisVerdict ?? null,
      pluginChainId: input.pluginChainId ?? null,
      workflowIds,
      hasUnsavedLiveChanges: hasUnsaved,
      authoritativeCatalogRecord: false,
      createdAt: now,
    };
  }

  /**
   * Convenience bridge accepting live DAW Brain subsystem reports directly (`DawStateSnapshot`,
   * `AudioBrainAnalysisReport`, `PluginChainGraph` / `PluginChainAnalysisReport`, and
   * `DawProductionWorkflowSpec`) and linking them cleanly without mutating DAW project files.
   */
  async linkDawArtifactsBundle(input: {
    readonly targetKind: DawCatalogTargetKind;
    readonly targetPathOrId: string;
    readonly dawHost: 'fl_studio' | 'reaper' | 'simulated' | 'generic_daw';
    readonly dawProjectPath: string;
    readonly snapshot?: DawStateSnapshot | undefined;
    readonly audioReport?: AudioBrainAnalysisReport | undefined;
    readonly pluginChain?: PluginChainGraph | PluginChainAnalysisReport | undefined;
    readonly workflows?: readonly DawProductionWorkflowSpec[] | undefined;
    readonly hasUnsavedLiveChanges?: boolean | undefined;
    readonly provenance: string;
    readonly actor?: string | undefined;
  }): Promise<DawCatalogLinkRecord> {
    const pluginChainId = input.pluginChain?.chainId;
    return this.linkDawProductionToCatalog({
      targetKind: input.targetKind,
      targetPathOrId: input.targetPathOrId,
      dawHost: input.dawHost,
      dawProjectPath: input.dawProjectPath,
      dawSessionId: input.snapshot?.sessionId,
      dawSnapshotId: input.snapshot?.snapshotId,
      hasUnsavedLiveChanges:
        input.hasUnsavedLiveChanges ?? (input.snapshot ? input.snapshot.freshness === 'stale' : false),
      audioAnalysisId: input.audioReport?.reportId,
      audioAnalysisVerdict: input.audioReport?.diagnostics.overallVerdict,
      audioSha256: input.audioReport?.acquisition.sha256AfterRead,
      pluginChainId,
      workflowIds: input.workflows?.map((w) => w.id),
      provenance: input.provenance,
      actor: input.actor,
    });
  }

  /**
   * Evaluates whether linked DAW production telemetry permits promoting a linked
   * Master Version or Release into distribution readiness.
   */
  evaluatePromotionFromDaw(targetId: string): DawPromotionGuardReport {
    const links = this.#db
      .listIndexEntries('06_RECORDS', 10_000)
      .filter((e) => e.vaultPath.startsWith('06_RECORDS/CATALOG_LINKS/DWLK-') && e.frontmatter.target_id === targetId);
    const reasons: string[] = [];
    for (const l of links) {
      if (l.frontmatter.authoritative_catalog_record !== false) {
        reasons.push(`Invalid DAW link "${String(l.frontmatter.id)}": marked authoritative`);
      }
      if (l.frontmatter.has_unsaved_live_changes === true) {
        reasons.push(`DAW link "${String(l.frontmatter.id)}" reports unsaved live DAW changes/drift relative to export`);
      }
      if (l.frontmatter.audio_analysis_verdict === 'CRITICAL') {
        reasons.push(`AudioBrain report "${String(l.frontmatter.audio_analysis_id ?? l.frontmatter.id)}" verdict is CRITICAL`);
      }
    }
    return {
      targetId,
      allowed: reasons.length === 0,
      linkedSessions: links.length,
      reasons,
    };
  }

  getLinkedProductionContext(targetId: string): {
    readonly targetId: string;
    readonly dawLinks: readonly DawCatalogLinkRecord[];
    readonly audioAnalyses: readonly string[];
    readonly pluginChains: readonly string[];
    readonly workflows: readonly string[];
  } {
    const rawLinks = this.#db
      .listIndexEntries('06_RECORDS', 10_000)
      .filter((e) => e.vaultPath.startsWith('06_RECORDS/CATALOG_LINKS/DWLK-') && e.frontmatter.target_id === targetId);
    const dawLinks: DawCatalogLinkRecord[] = rawLinks.map((e) => ({
      linkId: String(e.frontmatter.id),
      vaultPath: e.vaultPath,
      targetKind: String(e.frontmatter.target_kind) as DawCatalogTargetKind,
      targetId: String(e.frontmatter.target_id),
      dawHost: String(e.frontmatter.daw_host),
      dawProjectPath: String(e.frontmatter.daw_project_path),
      dawSessionId: e.frontmatter.daw_session_id ? String(e.frontmatter.daw_session_id) : null,
      audioAnalysisId: e.frontmatter.audio_analysis_id ? String(e.frontmatter.audio_analysis_id) : null,
      audioAnalysisVerdict: e.frontmatter.audio_analysis_verdict ? String(e.frontmatter.audio_analysis_verdict) : null,
      pluginChainId: e.frontmatter.plugin_chain_id ? String(e.frontmatter.plugin_chain_id) : null,
      workflowIds: Array.isArray(e.frontmatter.workflow_ids) ? (e.frontmatter.workflow_ids as string[]) : [],
      hasUnsavedLiveChanges: Boolean(e.frontmatter.has_unsaved_live_changes),
      authoritativeCatalogRecord: false,
      createdAt: String(e.frontmatter.created_at ?? ''),
    }));
    const audioAnalyses = [...new Set(dawLinks.map((d) => d.audioAnalysisId).filter((x): x is string => Boolean(x)))];
    const pluginChains = [...new Set(dawLinks.map((d) => d.pluginChainId).filter((x): x is string => Boolean(x)))];
    const workflows = [...new Set(dawLinks.flatMap((d) => d.workflowIds))];
    return { targetId, dawLinks, audioAnalyses, pluginChains, workflows };
  }
}
