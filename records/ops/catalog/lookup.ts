import type { AgentContext, AgentHandler } from '../../../core/orchestrator/dispatch.ts';
import type { VaultFile } from '../../../knowledge/source-registry/vault-tools.ts';
import { MIX_REPORT_SCHEMA_ID, type CatalogRecord, type Registration, type TakeChain } from '../tools.ts';

export const CATALOG_LOOKUP_AGENT = 'records-catalog-lookup';

/** Where a registration's recording came from, as the lookup resolved it. */
type Resolved =
  | { readonly kind: 'take'; readonly takeId: string; readonly defaultTitle: string | null; readonly provenance: TakeChain; readonly note: string }
  | { readonly kind: 'vault'; readonly sourceId: string; readonly defaultTitle: string | null; readonly provenance: { readonly vaultFile: VaultFile }; readonly note: string };

// A take: take → Suno submission → formula; the formula's title is the default track title.
const resolveTake = async (ctx: AgentContext, takeId: unknown, mixReportArtifactId: string | null): Promise<Resolved> => {
  const chain = (await ctx.useTool('resolve_take', { takeId, mixReportArtifactId })) as TakeChain;
  if (chain.mixReport && chain.mixReport.schemaId !== MIX_REPORT_SCHEMA_ID) {
    throw new Error(`records-catalog-lookup: artifact ${chain.mixReport.artifactId} is ${chain.mixReport.schemaId}, not a ${MIX_REPORT_SCHEMA_ID}`);
  }
  return {
    kind: 'take', takeId: chain.take.id, defaultTitle: chain.formula.title, provenance: chain,
    note: `take ${chain.take.id} ← submission ${chain.submission.id} ← formula ${chain.formula.artifactId}`,
  };
};

// A Vault audio file (AOS-02, B4): an FL Studio bounce, an RVC render. Its song, when it is linked to
// exactly one, names the track; the file's own name ("mix-v7-final.wav") never does.
const resolveVaultFile = async (ctx: AgentContext, sourceId: unknown): Promise<Resolved> => {
  const f = (await ctx.useTool('read_vault_file', { sourceId })) as VaultFile;
  if (f.mediaClass !== 'audio') throw new Error(`records-catalog-lookup: Vault file ${f.id} is a ${f.mediaClass}, not an audio file`);
  return {
    kind: 'vault', sourceId: f.id, defaultTitle: f.songs.length === 1 ? f.songs[0]!.title : null, provenance: { vaultFile: f },
    note: `Vault file ${f.id} (${f.title}, sha256 ${f.sha256.slice(0, 12)}…)${f.songs.length ? `, song ${f.songs.map((s) => s.title).join(', ')}` : ''}`,
  };
};

/**
 * records-catalog-lookup (Phase 13, Knowledge, deterministic): the read half of the guide's
 * "Knowledge/Execution" Catalog agent (F10: split, chained by register-track). It resolves a finished
 * recording (a Suno take's chain, or since AOS-02 a Vault audio file) and the target release, and
 * answers with a fully specified registration plus the provenance it rests on. It writes nothing:
 * records-catalog performs the registration.
 * @param ctx - run context; resolve_take, read_catalog (catalog.read) and read_vault_file (vault.read) are its reads
 * @param input - `{ takeId, sourceId, release: {id} | {title, artist, kind}, position, title, mixReportArtifactId }`;
 *   exactly one of takeId / sourceId, and title / mixReportArtifactId, may be null (not given)
 * @returns `{ registration, provenance }`
 */
export const catalogLookup: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as Record<string, unknown>;
  const release = i.release as Record<string, unknown> | undefined;
  if (release === null || typeof release !== 'object') throw new Error('records-catalog-lookup: release must be {id} or {title, artist, kind}');
  if (!Number.isInteger(i.position)) throw new Error('records-catalog-lookup: position must be an integer');
  // null = not given: the workflow engine has no optional inputs, so absent values arrive as null.
  if (i.title != null && typeof i.title !== 'string') throw new Error('records-catalog-lookup: title must be a string or null');
  if ((i.takeId != null) === (i.sourceId != null)) throw new Error('records-catalog-lookup: the recording is exactly one of takeId, sourceId');
  const mixReportArtifactId = (i.mixReportArtifactId ?? null) as string | null;

  const rec = i.takeId != null ? await resolveTake(ctx, i.takeId, mixReportArtifactId) : await resolveVaultFile(ctx, i.sourceId);

  let target: Registration['release'];
  if (typeof release.id === 'string') {
    const catalog = (await ctx.useTool('read_catalog', { releaseId: release.id })) as CatalogRecord;
    if (catalog.release.status !== 'draft') throw new Error(`records-catalog-lookup: release ${release.id} is ${catalog.release.status}; tracks are added to drafts only`);
    if (catalog.tracks.some((t) => t.position === i.position)) throw new Error(`records-catalog-lookup: position ${String(i.position)} is taken on release ${release.id}`);
    if (rec.kind === 'take' && catalog.tracks.some((t) => t.takeId === rec.takeId)) throw new Error(`records-catalog-lookup: take ${rec.takeId} is already on release ${release.id}`);
    if (rec.kind === 'vault' && catalog.tracks.some((t) => t.sourceId === rec.sourceId)) {
      throw new Error(`records-catalog-lookup: Vault file ${rec.sourceId} is already on release ${release.id}`);
    }
    target = { id: release.id };
  } else {
    target = { title: String(release.title ?? ''), artist: String(release.artist ?? ''), kind: String(release.kind ?? '') };
  }

  // What we already know (the formula's title, or the file's one song), unless the operator names the track.
  const title = (i.title as string | null | undefined) ?? rec.defaultTitle;
  if (!title) {
    throw new Error(rec.kind === 'take'
      ? `records-catalog-lookup: formula artifact ${(rec.provenance as TakeChain).formula.artifactId} has no title; give a title`
      : `records-catalog-lookup: Vault file ${rec.sourceId} is linked to ${(rec.provenance as { vaultFile: VaultFile }).vaultFile.songs.length} songs, not one; give a title`);
  }

  const registration: Registration = {
    release: target,
    track: {
      position: i.position as number, title,
      takeId: rec.kind === 'take' ? rec.takeId : null, sourceId: rec.kind === 'vault' ? rec.sourceId : null, mixReportArtifactId,
    },
  };
  await ctx.useTool('log_message', { message: `records-catalog-lookup: ${rec.note}; title "${title}" (${i.title == null ? 'derived' : 'operator'})` });
  return { output: { registration, provenance: rec.provenance }, tokensUsed: 0 };
};
