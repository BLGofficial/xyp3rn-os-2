import type { AgentHandler } from '../../../core/orchestrator/dispatch.ts';
import { MIX_REPORT_SCHEMA_ID, type CatalogRecord, type Registration, type TakeChain } from '../tools.ts';

export const CATALOG_LOOKUP_AGENT = 'records-catalog-lookup';

/**
 * records-catalog-lookup (Phase 13, Knowledge, deterministic): the read half of the guide's
 * "Knowledge/Execution" Catalog agent (F10: split, chained by register-track). It resolves a finished
 * take's chain and the target release, and answers with a fully specified registration plus the
 * provenance it rests on. It writes nothing: records-catalog performs the registration.
 * @param ctx - run context; resolve_take and read_catalog (catalog.read) are its reads
 * @param input - `{ takeId, release: {id} | {title, artist, kind}, position, title, mixReportArtifactId }`;
 *   title and mixReportArtifactId may be null (not given)
 * @returns `{ registration, provenance }`
 */
export const catalogLookup: AgentHandler = async (ctx, input) => {
  const i = (input ?? {}) as Record<string, unknown>;
  const release = i.release as Record<string, unknown> | undefined;
  if (release === null || typeof release !== 'object') throw new Error('records-catalog-lookup: release must be {id} or {title, artist, kind}');
  if (!Number.isInteger(i.position)) throw new Error('records-catalog-lookup: position must be an integer');
  // null = not given: the workflow engine has no optional inputs, so absent values arrive as null.
  if (i.title != null && typeof i.title !== 'string') throw new Error('records-catalog-lookup: title must be a string or null');
  const mixReportArtifactId = (i.mixReportArtifactId ?? null) as string | null;

  const chain = (await ctx.useTool('resolve_take', { takeId: i.takeId, mixReportArtifactId })) as TakeChain;
  if (chain.mixReport && chain.mixReport.schemaId !== MIX_REPORT_SCHEMA_ID) {
    throw new Error(`records-catalog-lookup: artifact ${chain.mixReport.artifactId} is ${chain.mixReport.schemaId}, not a ${MIX_REPORT_SCHEMA_ID}`);
  }

  let target: Registration['release'];
  if (typeof release.id === 'string') {
    const catalog = (await ctx.useTool('read_catalog', { releaseId: release.id })) as CatalogRecord;
    if (catalog.release.status !== 'draft') throw new Error(`records-catalog-lookup: release ${release.id} is ${catalog.release.status}; tracks are added to drafts only`);
    if (catalog.tracks.some((t) => t.position === i.position)) throw new Error(`records-catalog-lookup: position ${String(i.position)} is taken on release ${release.id}`);
    if (catalog.tracks.some((t) => t.takeId === chain.take.id)) throw new Error(`records-catalog-lookup: take ${chain.take.id} is already on release ${release.id}`);
    target = { id: release.id };
  } else {
    target = { title: String(release.title ?? ''), artist: String(release.artist ?? ''), kind: String(release.kind ?? '') };
  }

  // What we already know: the formula artifact's title, unless the operator names the track.
  const title = (i.title as string | null | undefined) ?? chain.formula.title;
  if (!title) throw new Error(`records-catalog-lookup: formula artifact ${chain.formula.artifactId} has no title; give one`);

  const registration: Registration = {
    release: target,
    track: { position: i.position as number, title, takeId: chain.take.id, mixReportArtifactId },
  };
  await ctx.useTool('log_message', {
    message: `records-catalog-lookup: take ${chain.take.id} ← submission ${chain.submission.id} ← formula ${chain.formula.artifactId}; title "${title}" (${i.title == null ? 'formula' : 'operator'})`,
  });
  return { output: { registration, provenance: chain }, tokensUsed: 0 };
};
