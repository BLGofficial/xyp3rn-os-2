import type postgres from 'postgres';
import type { Queryable } from '../../core/db/client.ts';
import { buildReport, scoreCompleteness, scoreFreshness, scoreReliability, type SourceKind, type SourceOrigin } from '../quality/rubric.ts';
import type { EntityRef, NormalizedDocument } from './types.ts';

export type VersionDecision = { readonly action: 'reuse'; readonly id: string } | { readonly action: 'insert'; readonly version: number };

/**
 * Versioning: identical content reuses the latest row; changed content appends latest+1.
 * A canonical row is never updated in place; the newest version of a slug is "current".
 * @param latest - newest existing row for the slug and whether its content matches, if any
 * @returns reuse the existing id, or insert at the given version
 */
export const decideVersion = (
  latest: { readonly id: string; readonly version: number; readonly same: boolean } | undefined,
): VersionDecision =>
  latest === undefined
    ? { action: 'insert', version: 1 }
    : latest.same
      ? { action: 'reuse', id: latest.id }
      : { action: 'insert', version: latest.version + 1 };

const TAG_LABELS: Readonly<Record<string, string>> = {
  'meta-prompt': 'Meta-prompt',
  protocol: 'Build protocol',
  'sub-prompt': 'Sub-prompt',
  'test-first': 'Test-first',
  'no-mock-data': 'No mock data',
  idempotency: 'Idempotency',
  'grant-enforcement': 'Grant-level enforcement',
  'human-approval': 'Human approval',
};

const tagLabel = (slug: string): string =>
  TAG_LABELS[slug] ?? (/^phase-(\d+)$/.exec(slug) ? `Phase ${slug.slice(6)}` : slug);

export type WriteContext = {
  readonly sourceId: string;
  readonly runId: string;
  readonly kind: SourceKind;
  readonly origin: SourceOrigin;
  readonly asOf: Date;
};

export type WriteStats = {
  readonly modules: { inserted: number; reused: number };
  readonly prompts: { inserted: number; reused: number };
  readonly tags_linked: number;
  readonly relations_inserted: number;
  readonly quality_reports: number;
};

export type WriteResult = {
  readonly stats: WriteStats;
  /** Rows this call appended — the gate writes a knowledge_versions row for each. */
  readonly insertedModuleIds: readonly string[];
  readonly insertedPromptIds: readonly string[];
};

/**
 * Writes a normalized document into the canonical tables. Called only by the Promotion Gate's
 * first-party admission (admitFirstParty), inside the ingestion transaction, as xyp_promotion —
 * every row is marked promoted_via='gate'. (Before 6D: xyp_ingest_bootstrap, 'bootstrap', F1.)
 * @param tx - transaction already holding the canonical write lock
 * @param doc - normalizer output
 * @param ctx - source/run ids and scoring inputs
 * @returns counts recorded on the ingestion run, and the ids of the rows appended
 */
export const writeNormalized = async (tx: Queryable, doc: NormalizedDocument, ctx: WriteContext): Promise<WriteResult> => {
  const stats = {
    modules: { inserted: 0, reused: 0 },
    prompts: { inserted: 0, reused: 0 },
    tags_linked: 0,
    relations_inserted: 0,
    quality_reports: 0,
  };
  const moduleIds = new Map<string, string>();
  const promptIds = new Map<string, string>();
  const newPromptSlugs = new Set<string>();
  const insertedModuleIds: string[] = [];

  for (const m of doc.modules) {
    const [latest] = await tx<{ id: string; version: number; same: boolean }[]>`
      select id, version,
             (title = ${m.title} and description is not distinct from ${m.description} and domain = ${m.domain}) as same
      from modules where slug = ${m.slug} order by version desc limit 1`;
    const d = decideVersion(latest);
    if (d.action === 'reuse') {
      moduleIds.set(m.slug, d.id);
      stats.modules.reused++;
      continue;
    }
    const [row] = await tx<{ id: string }[]>`
      insert into modules (slug, version, title, description, domain, source_id, promoted_via)
      values (${m.slug}, ${d.version}, ${m.title}, ${m.description}, ${m.domain}, ${ctx.sourceId}, 'gate')
      returning id`;
    moduleIds.set(m.slug, row!.id);
    insertedModuleIds.push(row!.id);
    stats.modules.inserted++;
  }

  for (const p of doc.prompts) {
    // A document may place its prompts in a module another document owns (Phase 10: the Vocal DNA
    // file fills the manifest's x3lius-vocal-dna module without redeclaring it): its current version.
    if (!moduleIds.has(p.moduleSlug)) {
      const [current] = await tx<{ id: string }[]>`select id from modules where slug = ${p.moduleSlug} order by version desc limit 1`;
      if (current) moduleIds.set(p.moduleSlug, current.id);
    }
    const moduleId = moduleIds.get(p.moduleSlug);
    if (!moduleId) throw new Error(`prompt ${p.slug} references unknown module ${p.moduleSlug}`);
    const [latest] = await tx<{ id: string; version: number; same: boolean }[]>`
      select id, version,
             (module_id = ${moduleId} and title = ${p.title} and body = ${p.body}
              and structured is not distinct from ${tx.json(p.structured as postgres.JSONValue)}::jsonb
              and model_tag is not distinct from ${p.modelTag}) as same
      from canonical_prompts where slug = ${p.slug} order by version desc limit 1`;
    const d = decideVersion(latest);
    if (d.action === 'reuse') {
      promptIds.set(p.slug, d.id);
      stats.prompts.reused++;
      continue;
    }
    const [row] = await tx<{ id: string }[]>`
      insert into canonical_prompts (module_id, slug, version, title, body, structured, model_tag, source_id, promoted_via)
      values (${moduleId}, ${p.slug}, ${d.version}, ${p.title}, ${p.body}, ${tx.json(p.structured as postgres.JSONValue)},
              ${p.modelTag}, ${ctx.sourceId}, 'gate')
      returning id`;
    promptIds.set(p.slug, row!.id);
    newPromptSlugs.add(p.slug);
    stats.prompts.inserted++;
  }

  const tagIds = new Map<string, string>();
  for (const slug of [...new Set(doc.prompts.flatMap((p) => p.tags))].sort()) {
    await tx`insert into tags (slug, label) values (${slug}, ${tagLabel(slug)}) on conflict (slug) do nothing`;
    const [t] = await tx<{ id: string }[]>`select id from tags where slug = ${slug}`;
    tagIds.set(slug, t!.id);
  }
  for (const p of doc.prompts) {
    for (const slug of p.tags) {
      const res = await tx`
        insert into prompt_tags (canonical_prompt_id, tag_id) values (${promptIds.get(p.slug)!}, ${tagIds.get(slug)!})
        on conflict do nothing`;
      stats.tags_linked += res.count;
    }
  }

  const resolve = (ref: EntityRef): string => {
    if (ref.type === 'source') return ctx.sourceId;
    const id = (ref.type === 'module' ? moduleIds : promptIds).get(ref.slug);
    if (!id) throw new Error(`relation references unknown ${ref.type} ${ref.slug}`);
    return id;
  };
  for (const r of doc.relations) {
    const res = await tx`
      insert into relations (subject_type, subject_id, predicate, object_type, object_id)
      values (${r.subject.type}, ${resolve(r.subject)}, ${r.predicate}, ${r.object.type}, ${resolve(r.object)})
      on conflict on constraint relations_edge_key do nothing`;
    stats.relations_inserted += res.count;
  }

  // Source report scores document coverage; prompt reports score each new entry's structure.
  // Reliability + freshness are properties of the source, so every entry inherits them.
  const reliability = scoreReliability(ctx.kind, ctx.origin);
  const freshness = scoreFreshness(doc.documentDate ? new Date(`${doc.documentDate}T00:00:00Z`) : null, ctx.asOf);
  const insertReport = async (target: { source_id: string } | { canonical_prompt_id: string }, expected: readonly string[], present: readonly string[]) => {
    const report = buildReport([scoreCompleteness(expected, present), reliability, freshness]);
    await tx`
      insert into quality_reports (ingestion_run_id, source_id, canonical_prompt_id, rubric_version, criteria, overall)
      values (${ctx.runId}, ${'source_id' in target ? target.source_id : null},
              ${'canonical_prompt_id' in target ? target.canonical_prompt_id : null},
              ${report.rubric_version}, ${tx.json(report.criteria as postgres.JSONValue)}, ${report.overall})`;
    stats.quality_reports++;
  };
  await insertReport({ source_id: ctx.sourceId }, doc.coverage.expected, doc.coverage.present);
  for (const p of doc.prompts) {
    if (!newPromptSlugs.has(p.slug)) continue;
    await insertReport({ canonical_prompt_id: promptIds.get(p.slug)! }, p.completeness.expected, p.completeness.present);
  }

  return { stats, insertedModuleIds, insertedPromptIds: [...newPromptSlugs].map((slug) => promptIds.get(slug)!) };
};
