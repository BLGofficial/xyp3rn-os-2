import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Queryable } from '../../core/db/client.ts';

/**
 * Phase 1 FK-proof seed: exactly one row per canonical base table, all derived from the
 * uploaded build guide (no invented content). Callers run it inside a transaction they
 * roll back (tests, `pnpm db:seed:proof`) — Phase 2 owns the first persistent ingestion
 * of this PDF, so a committed seed would turn that into a checksum no-op.
 */

export const BUILD_GUIDE_PDF = 'XYP3RN_Agentic_OS_Build_Sequence.pdf';

export type SeedIds = {
  readonly sourceId: string;
  readonly ingestionRunId: string;
  readonly moduleId: string;
  readonly canonicalPromptId: string;
  readonly promptVariantId: string;
  readonly tagId: string;
  readonly relationId: string;
  readonly qualityReportId: string;
};

/**
 * Inserts the FK chain source → run → module → canonical prompt → variant/tag/relation/report.
 * @param tx - transaction to write into; the caller decides commit vs rollback
 * @param repoRoot - repo root holding the build guide PDF
 * @returns ids of every inserted row
 */
export const seedFkProof = async (tx: Queryable, repoRoot: string): Promise<SeedIds> => {
  const bytes = readFileSync(join(repoRoot, BUILD_GUIDE_PDF));
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const one = async (q: Promise<{ id: string }[]>) => (await q)[0]!.id;

  // Title and metadata transcribed from page 1 of the PDF.
  const sourceId = await one(tx`
    insert into sources (kind, uri, title, checksum_sha256, mime_type, byte_size, metadata)
    values ('file', ${BUILD_GUIDE_PDF},
            'XYP3RN Agentic OS — Build Sequence — Meta-Prompt Library (Phase 0 → 17)',
            ${checksum}, 'application/pdf', ${bytes.length},
            ${tx.json({ doc_label: 'Internal Engineering Doc — XYP3RN / X3LIUS', dated: 'September 2026' })})
    returning id`);

  const ingestionRunId = await one(tx`
    insert into ingestion_runs (requested_uri, source_id, checksum_sha256, status, completed_at, stats)
    values (${BUILD_GUIDE_PDF}, ${sourceId}, ${checksum}, 'success', now(),
            ${tx.json({ seed: 'phase-01-fk-proof', byte_size: bytes.length })})
    returning id`);

  // Module + prompt text quoted from the PDF's Phase 0 section (page 2).
  const moduleId = await one(tx`
    insert into modules (slug, title, description, domain, source_id, promoted_via)
    values ('foundation-contracts', 'Phase 0 — Foundation / Contracts',
            'Lock the six-domain architecture and the eight agent-class contracts before any code exists.',
            'CORE', ${sourceId}, 'bootstrap')
    returning id`);

  const canonicalPromptId = await one(tx`
    insert into canonical_prompts (module_id, slug, title, body, source_id, promoted_via)
    values (${moduleId}, 'single-canonical-writer', 'Single canonical writer',
            ${'Only one thing in the entire OS is allowed to write to canonical knowledge tables: '
              + 'the Knowledge Promotion Gate (built Phase 6D). Every other agent, research included, '
              + 'is read-only against canonical state until that gate approves.'},
            ${sourceId}, 'bootstrap')
    returning id`);

  const promptVariantId = await one(tx`
    insert into prompt_variants (canonical_prompt_id, label, body)
    values (${canonicalPromptId}, 'condensed',
            'Only the Knowledge Promotion Gate writes canonical knowledge; every other agent is read-only against it.')
    returning id`);

  const tagId = await one(tx`
    insert into tags (slug, label) values ('invariant', 'Invariant') returning id`);

  await tx`insert into prompt_tags (canonical_prompt_id, tag_id) values (${canonicalPromptId}, ${tagId})`;

  const relationId = await one(tx`
    insert into relations (subject_type, subject_id, predicate, object_type, object_id)
    values ('canonical_prompt', ${canonicalPromptId}, 'derived_from', 'source', ${sourceId})
    returning id`);

  // Not a quality score: the real rubric is Phase 2's deliverable. This row only proves the
  // report → run → source FKs, and says so in its own inputs.
  const qualityReportId = await one(tx`
    insert into quality_reports (source_id, ingestion_run_id, rubric_version, criteria, overall)
    values (${sourceId}, ${ingestionRunId}, 'phase-01-fk-proof',
            ${tx.json([
              {
                name: 'fk_proof_only',
                weight: 1,
                score: 1,
                inputs: { note: 'Phase 1 FK proof; quality rubric is defined in Phase 2', byte_size: bytes.length },
              },
            ])},
            1)
    returning id`);

  return {
    sourceId,
    ingestionRunId,
    moduleId,
    canonicalPromptId,
    promptVariantId,
    tagId,
    relationId,
    qualityReportId,
  };
};
