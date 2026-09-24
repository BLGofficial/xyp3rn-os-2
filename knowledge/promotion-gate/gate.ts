import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { quoteIdent, type Queryable, type Sql } from '../../core/db/client.ts';
import { summarizeExperiment } from '../../research-intelligence/experiments/engine.ts';
import { MODEL_AGNOSTIC } from '../../research-intelligence/synthesis/findings.ts';
import type { SourceKind, SourceOrigin } from '../quality/rubric.ts';
import { writeNormalized, type WriteStats } from '../ingestion/write-normalized.ts';
import type { NormalizedDocument } from '../ingestion/types.ts';
import { AUTO_APPROVE_CONFIDENCE, decide, GATE_STEPS, SOURCE_MAX_AGE_DAYS, type GateStep } from './decide.ts';

/**
 * Knowledge Promotion Gate (Phase 6D) — the only code path that writes canonical knowledge (F2).
 * Two entrances, one service account (xyp_promotion, INSERT-only on canonical tables):
 *   runGate        — a Research Intelligence candidate through the full nine-step state machine;
 *   admitFirstParty — an operator-authored first-party document (the F1 successor).
 * Every write appends: a new (slug, version) row plus its knowledge_versions history row,
 * tied to the promotion_runs record of the run that made it.
 */

export const PROMOTION_ROLE = 'xyp_promotion';
/** The operator. Only it may decide approvals (xyp_decide_approval). */
export const OPERATOR_ROLE = 'service_role';
/** Serializes every canonical write: gate runs and first-party admission both compute latest+1. */
export const CANONICAL_WRITE_LOCK_KEY = 'xyp:canonical:write';
export const FIRST_PARTY_ADMISSION_ERROR =
  'first-party admission requires origin first_party; third-party material goes through Research Intelligence';

const EMBEDDING_COLUMNS = ['embedding', 'embedding_model', 'embedding_input_sha256', 'embedding_truncated', 'embedded_at'];

export type StepRecord = { readonly step: GateStep | 'first-party-admission'; readonly passed: boolean; readonly reason: string } & Readonly<
  Record<string, unknown>
>;

export type GateResult = {
  readonly outcome: 'blocked' | 'rejected' | 'pending_approval' | 'promoted';
  readonly steps: readonly StepRecord[];
  readonly reasons: readonly string[];
  readonly promotionRunId: string;
  readonly approvalId: string | undefined;
  readonly canonicalPromptId: string | undefined;
  readonly version: number | undefined;
};

type CandidateRow = {
  id: string;
  finding_id: string;
  proposed_kind: string;
  target_slug: string;
  title: string;
  body: string;
  structured: Record<string, unknown> | null;
  model_tag: string;
  domain: string;
  tags: string[];
  status: string;
  claim_topic: string;
  claim_value: unknown;
};

type Approval = { id: string; status: 'pending' | 'approved' | 'rejected'; decided_by: string | null; decision_reason: string | null };

const asRole = <T>(sql: Sql, role: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(role)}`);
    return fn(tx);
  }) as Promise<T>;

const DAY_MS = 86_400_000;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Steps 1–6: evaluate the candidate against the evidence behind it. Pure reads. */
const evaluate = async (tx: Queryable, c: CandidateRow, asOf: Date) => {
  const open = await tx<{ id: string }[]>`
    select id from contradictions
    where status = 'open' and (finding_id = ${c.finding_id} or (target_type = 'knowledge_candidate' and target_id = ${c.id}))
    order by created_at, id`;
  const candidate: StepRecord = {
    step: 'candidate',
    passed: open.length === 0,
    reason: open.length === 0 ? `${c.target_slug} (${c.status}): no open contradictions` : `${open.length} open contradiction(s) block entry`,
    contradictions: open.map((o) => o.id),
  };

  const [f] = await tx<{ model_tag: string; confidence: string; confidence_inputs: Record<string, unknown> }[]>`
    select model_tag, confidence, confidence_inputs from research_findings where id = ${c.finding_id}`;
  const ev = await tx<{ evidence_id: string; model_tag: string; source_id: string; kind: string; reliability: string | null; retrieved_at: Date }[]>`
    select e.id as evidence_id, e.model_tag, s.id as source_id, s.kind::text, s.reliability, s.retrieved_at
    from research_finding_evidence fe
    join research_evidence e on e.id = fe.evidence_id
    join research_sources s on s.id = e.research_source_id
    where fe.finding_id = ${c.finding_id}
    order by s.retrieved_at, e.id`;
  // Broken invariants, not gate outcomes: 6C never records a finding without scored evidence.
  if (!f || ev.length === 0) throw new Error(`candidate ${c.id}: finding ${c.finding_id} has no evidence`);
  const unscored = ev.filter((e) => e.reliability === null);
  if (unscored.length > 0) throw new Error(`candidate ${c.id}: research source ${unscored[0]!.source_id} has no reliability score`);

  const ages = ev.map((e) => Math.floor((asOf.getTime() - e.retrieved_at.getTime()) / DAY_MS));
  const oldest = Math.max(...ages);
  const rel = ev.map((e) => Number(e.reliability));
  const sourceVerification: StepRecord = {
    step: 'source-verification',
    passed: oldest <= SOURCE_MAX_AGE_DAYS,
    reason: `${new Set(ev.map((e) => e.source_id)).size} source(s), reliability ${Math.min(...rel)}–${Math.max(...rel)}, oldest retrieved ${oldest} day(s) ago (limit ${SOURCE_MAX_AGE_DAYS})`,
    sources: ev.map((e, i) => ({ id: e.source_id, kind: e.kind, reliability: Number(e.reliability), age_days: ages[i] })),
  };

  const offTag = ev.filter((e) => e.model_tag !== f.model_tag && e.model_tag !== MODEL_AGNOSTIC);
  const tagsConsistent = c.model_tag.trim() !== '' && c.model_tag === f.model_tag && offTag.length === 0;
  const tagging: StepRecord = {
    step: 'model-version-tagging',
    passed: tagsConsistent,
    reason: tagsConsistent
      ? `tagged ${c.model_tag}; finding and ${ev.length} evidence row(s) agree`
      : `candidate ${c.model_tag} / finding ${f.model_tag} / evidence [${offTag.map((e) => e.model_tag).join(', ')}] disagree`,
    model_tag: c.model_tag,
  };

  const [exp] = await tx<{ id: string; status: string; n_per_variant: number }[]>`
    select id, status::text, n_per_variant from experiments where candidate_id = ${c.id} order by created_at desc, id desc limit 1`;
  const runs = exp
    ? await tx<{ variant: 'a' | 'b'; score: string | null; scored_by: string }[]>`
        select variant::text, score, scored_by from experiment_runs where experiment_id = ${exp.id}`
    : [];
  const summary = exp ? summarizeExperiment(exp, runs.map((r) => ({ ...r, score: r.score === null ? null : Number(r.score) }))) : null;
  const controlledTest: StepRecord = {
    step: 'controlled-test',
    passed: summary?.validated ?? false,
    reason: summary ? `experiment ${exp!.id} ${summary.status} (a:${summary.trials.a} b:${summary.trials.b}): ${summary.reason}` : 'no experiment designed for this candidate',
    experiment_id: exp?.id ?? null,
    scored_by: summary?.scoredBy ?? [],
  };
  // Variant b is the candidate rule, a the control (6C convention): it must beat the control.
  const means = summary?.validated ? summary.means : null;
  const wins = means !== null && means.a !== null && means.b !== null && means.b > means.a;
  const evaluation: StepRecord = {
    step: 'evaluation',
    passed: wins,
    reason: means ? `candidate (b) mean ${means.b} vs control (a) mean ${means.a}` : 'nothing to evaluate: controlled test not validated',
    means,
  };

  const confidence = Number(f.confidence);
  const confidenceStep: StepRecord = {
    step: 'confidence-assignment',
    passed: confidence >= AUTO_APPROVE_CONFIDENCE,
    reason: `finding confidence ${confidence} (auto-approve threshold ${AUTO_APPROVE_CONFIDENCE})`,
    confidence,
    confidence_inputs: f.confidence_inputs,
  };

  const decision = decide({
    eligible: candidate.passed,
    tagsConsistent,
    sourcesFresh: sourceVerification.passed,
    experimentValidated: controlledTest.passed && evaluation.passed,
    confidence,
  });
  return { decision, confidence, steps: [candidate, sourceVerification, tagging, controlledTest, evaluation, confidenceStep] };
};

/** knowledge_versions rows for freshly inserted canonical rows (snapshot without embedding columns). */
const writeVersions = async (
  tx: Queryable,
  table: 'modules' | 'canonical_prompts',
  ids: readonly string[],
  v: { readonly candidateId: string | null; readonly approval: Record<string, unknown>; readonly promotionRunId: string },
) => {
  if (ids.length === 0) return;
  await tx.unsafe(
    `insert into knowledge_versions (canonical_table, canonical_id, version, candidate_id, promoted_via, snapshot, approval, promotion_run_id)
     select $1, r.id, r.version, $2, 'gate', to_jsonb(r) - $3::text[], $4, $5
     from ${quoteIdent(table)} r where r.id = any($6::uuid[])`,
    [table, v.candidateId, EMBEDDING_COLUMNS, v.approval as postgres.JSONValue, v.promotionRunId, [...ids]] as never,
  );
};

/**
 * Propagation (step 9): regression checks owed by the new rows. Agents need no push — the
 * Context Engine cache keys on the knowledge generation, so the next retrieval sees the new
 * version (once `pnpm embed` has embedded it). Sub-domain skill wiring arrives in Phase 7.
 */
const propagate = async (tx: Queryable, promotionRunId: string, promptIds: readonly string[]): Promise<StepRecord> => {
  if (promptIds.length === 0) return { step: 'propagation', passed: true, reason: 'no new canonical prompts; nothing to propagate', regression: [] };
  const claims = await tx<{ id: string; claims: unknown[] }[]>`
    select id, structured->'claims' as claims from canonical_prompts
    where id = any(${[...promptIds]}::uuid[]) and jsonb_typeof(structured->'claims') = 'array'`;
  const kinds: string[] = [];
  await tx`
    insert into regression_queue (promotion_run_id, kind, payload)
    values (${promotionRunId}, 'retrieval', ${tx.json({
      canonical_prompt_ids: [...promptIds],
      check: 'each row is embedded (pnpm embed) and the Context Engine returns it for its own title',
    })})`;
  kinds.push('retrieval');
  if (claims.length > 0) {
    await tx`
      insert into regression_queue (promotion_run_id, kind, payload)
      values (${promotionRunId}, 'contradiction-guard', ${tx.json({
        canonical_prompt_ids: claims.map((c) => c.id),
        claims: claims.flatMap((c) => c.claims) as postgres.JSONValue[],
        check: 'canonical_claims exposes these claims and a conflicting finding raises a contradiction against them',
      })})`;
    kinds.push('contradiction-guard');
  }
  return {
    step: 'propagation',
    passed: true,
    reason: `regression enqueued (${kinds.join(', ')}); Context Engine generation changes with this write; embedding pending (pnpm embed); skill wiring is Phase 7`,
    regression: kinds,
  };
};

const recordRun = async (
  tx: Queryable,
  run: {
    readonly id: string;
    readonly candidateId: string;
    readonly outcome: GateResult['outcome'];
    readonly steps: readonly StepRecord[];
    readonly reasons: readonly string[];
    readonly confidence: number;
    readonly approvalId: string | undefined;
  },
) => {
  await tx`
    insert into promotion_runs (id, mode, candidate_id, outcome, steps, reasons, confidence, auto_approve_threshold, approval_id)
    values (${run.id}, 'candidate', ${run.candidateId}, ${run.outcome}, ${tx.json(run.steps as postgres.JSONValue)},
            ${[...run.reasons]}, ${run.confidence}, ${AUTO_APPROVE_CONFIDENCE}, ${run.approvalId ?? null})`;
};

/** Steps 8–9 for a candidate: append the canonical row (next version) + history, then propagate. */
const promote = async (tx: Queryable, c: CandidateRow, promotionRunId: string, approval: Record<string, unknown>) => {
  // Promoted rules live in one gate-owned module per domain until Phase 7's sub-domain modules.
  const moduleSlug = `${c.domain.toLowerCase().replaceAll('_', '-')}-validated-rules`;
  let [mod] = await tx<{ id: string }[]>`select id from modules where slug = ${moduleSlug} order by version desc limit 1`;
  const newModules: string[] = [];
  if (!mod) {
    [mod] = await tx<{ id: string }[]>`
      insert into modules (slug, version, title, description, domain, promoted_via)
      values (${moduleSlug}, 1, ${`${c.domain} — validated rules`},
              'Canonical rules promoted by the Knowledge Promotion Gate from Research Intelligence candidates.', ${c.domain}, 'gate')
      returning id`;
    newModules.push(mod!.id);
  }

  const [next] = await tx<{ v: number }[]>`select coalesce(max(version), 0)::int + 1 as v from canonical_prompts where slug = ${c.target_slug}`;
  const structured = {
    ...(c.structured ?? {}),
    claims: [{ topic: c.claim_topic, value: c.claim_value, model_scope: c.model_tag }],
    candidate_id: c.id,
  };
  const [cp] = await tx<{ id: string }[]>`
    insert into canonical_prompts (module_id, slug, version, title, body, structured, model_tag, promoted_via)
    values (${mod!.id}, ${c.target_slug}, ${next!.v}, ${c.title}, ${c.body}, ${tx.json(structured as postgres.JSONValue)}, ${c.model_tag}, 'gate')
    returning id`;

  for (const slug of [...new Set(c.tags)].sort()) {
    await tx`insert into tags (slug, label) values (${slug}, ${slug}) on conflict (slug) do nothing`;
    await tx`insert into prompt_tags (canonical_prompt_id, tag_id) select ${cp!.id}, id from tags where slug = ${slug}`;
  }

  await writeVersions(tx, 'modules', newModules, { candidateId: c.id, approval: { ...approval, container_for: c.target_slug }, promotionRunId });
  await writeVersions(tx, 'canonical_prompts', [cp!.id], { candidateId: c.id, approval, promotionRunId });
  await tx`update knowledge_candidates set status = 'promoted' where id = ${c.id}`;

  const write: StepRecord = {
    step: 'canonical-write',
    passed: true,
    reason: `appended ${c.target_slug} v${next!.v}${newModules.length > 0 ? ` (+ module ${moduleSlug} v1)` : ''} with knowledge_versions history`,
    canonical_prompt_id: cp!.id,
    version: next!.v,
    module_ids_created: newModules,
  };
  return { write, canonicalPromptId: cp!.id, version: next!.v };
};

/**
 * Runs one knowledge candidate through the gate, in the guide's exact order, as xyp_promotion.
 * Outcomes: blocked (open contradiction; stays 'proposed', re-run after resolving), rejected
 * (inconsistent tags or operator rejection), pending_approval (queued for the operator, once),
 * promoted (auto-approved or operator-approved). Every run is recorded in promotion_runs.
 * @param sql - pool allowed to SET ROLE xyp_promotion
 * @param candidateId - knowledge_candidates.id ('proposed' or 'pending_approval')
 * @param options - `asOf` pins the freshness clock
 * @returns outcome, every evaluated step with its reason, and the ids written
 * @throws Error for an unknown or already-decided candidate, or broken 6C invariants
 */
export const runGate = async (sql: Sql, candidateId: string, options: { readonly asOf?: Date } = {}): Promise<GateResult> =>
  asRole(sql, PROMOTION_ROLE, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${CANONICAL_WRITE_LOCK_KEY}, 0))`;
    const [c] = await tx<CandidateRow[]>`
      select id, finding_id, proposed_kind::text, target_slug, title, body, structured, model_tag, domain::text, tags,
             status::text, claim_topic, claim_value
      from knowledge_candidates where id = ${candidateId} for update`;
    if (!c) throw new Error(`unknown candidate ${candidateId}`);
    if (c.status !== 'proposed' && c.status !== 'pending_approval') {
      throw new Error(`candidate ${candidateId} is already ${c.status}; the gate takes proposed or pending_approval candidates`);
    }
    // Modules carry no structured claims, so a module candidate would bypass contradiction guarding.
    if (c.proposed_kind !== 'canonical_prompt') throw new Error(`candidate ${candidateId}: only canonical_prompt candidates are promotable`);

    const { decision, confidence, steps } = await evaluate(tx, c, options.asOf ?? new Date());
    const runId = randomUUID();
    const base = { id: runId, candidateId, reasons: decision.reasons, confidence };
    const result = (outcome: GateResult['outcome'], s: readonly StepRecord[], approvalId?: string, cp?: { canonicalPromptId: string; version: number }): GateResult => ({
      outcome, steps: s, reasons: decision.reasons, promotionRunId: runId, approvalId,
      canonicalPromptId: cp?.canonicalPromptId, version: cp?.version,
    });

    if (decision.outcome === 'blocked') {
      const s = steps.slice(0, 1);
      await recordRun(tx, { ...base, outcome: 'blocked', steps: s, approvalId: undefined });
      return result('blocked', s);
    }
    if (decision.outcome === 'rejected') {
      const s = steps.slice(0, 3);
      await tx`update knowledge_candidates set status = 'rejected' where id = ${c.id}`;
      await recordRun(tx, { ...base, outcome: 'rejected', steps: s, approvalId: undefined });
      return result('rejected', s);
    }

    let approval: Record<string, unknown>;
    let approvalId: string | undefined;
    let validated: StepRecord;
    if (decision.outcome === 'auto_approve') {
      approval = { mode: 'auto', threshold: AUTO_APPROVE_CONFIDENCE, confidence };
      validated = { step: 'validated-rule', passed: true, reason: `auto-approved: every condition holds (confidence ${confidence} ≥ ${AUTO_APPROVE_CONFIDENCE})` };
    } else {
      let [a] = await tx<Approval[]>`
        select id, status::text, decided_by, decision_reason from approval_queue
        where item_type = 'knowledge_candidate' and item_id = ${c.id}`;
      if (!a) {
        const request = { gate_reasons: decision.reasons, confidence, threshold: AUTO_APPROVE_CONFIDENCE, target_slug: c.target_slug, steps };
        [a] = await tx<Approval[]>`
          insert into approval_queue (item_type, item_id, request)
          values ('knowledge_candidate', ${c.id}, ${tx.json(request as postgres.JSONValue)})
          returning id, status::text, decided_by, decision_reason`;
      }
      approvalId = a!.id;
      if (a!.status === 'pending') {
        const s = [...steps, { step: 'validated-rule', passed: false, reason: `routed to human approval: ${decision.reasons.join('; ')}`, approval_id: approvalId } as const];
        if (c.status === 'proposed') await tx`update knowledge_candidates set status = 'pending_approval' where id = ${c.id}`;
        await recordRun(tx, { ...base, outcome: 'pending_approval', steps: s, approvalId });
        return result('pending_approval', s, approvalId);
      }
      if (a!.status === 'rejected') {
        const s = [...steps, { step: 'validated-rule', passed: false, reason: `operator ${a!.decided_by} rejected: ${a!.decision_reason}`, approval_id: approvalId } as const];
        await tx`update knowledge_candidates set status = 'rejected' where id = ${c.id}`;
        await recordRun(tx, { ...base, outcome: 'rejected', steps: s, approvalId });
        return result('rejected', s, approvalId);
      }
      approval = { mode: 'human', approver: a!.decided_by, reason: a!.decision_reason, approval_id: approvalId, gate_reasons: decision.reasons };
      validated = {
        step: 'validated-rule',
        passed: true,
        reason: `operator ${a!.decided_by} approved over [${decision.reasons.join('; ')}]: ${a!.decision_reason}`,
        approval_id: approvalId,
      };
    }

    const { write, canonicalPromptId, version } = await promote(tx, c, runId, approval);
    const s = [...steps, validated, write, await propagate(tx, runId, [canonicalPromptId])];
    if (s.map((x) => x.step).join() !== GATE_STEPS.join()) throw new Error('gate step order drifted from GATE_STEPS');
    // Written last: knowledge_versions and regression_queue reference it through deferred FKs.
    await recordRun(tx, { ...base, outcome: 'promoted', steps: s, approvalId });
    return result('promoted', s, approvalId, { canonicalPromptId, version });
  });

/**
 * The operator's decision on a queued item, through xyp_decide_approval (SECURITY DEFINER,
 * EXECUTE held by service_role only). Re-run the gate afterwards to act on it.
 * @param sql - pool allowed to SET ROLE service_role
 * @param approvalId - approval_queue.id (must be pending)
 * @param d - decision, who decided, and why (both required)
 * @returns the new approval status
 */
export const decideApproval = async (
  sql: Sql,
  approvalId: string,
  d: { readonly decision: 'approve' | 'reject'; readonly approver: string; readonly reason: string },
): Promise<'approved' | 'rejected'> =>
  asRole(sql, OPERATOR_ROLE, async (tx) => {
    const [r] = await tx<{ status: 'approved' | 'rejected' }[]>`
      select xyp_decide_approval(${approvalId}, ${d.decision}, ${d.approver}, ${d.reason})::text as status`;
    return r!.status;
  });

export type FirstPartyAdmission = {
  readonly doc: NormalizedDocument;
  readonly sourceId: string;
  readonly ingestionRunId: string;
  readonly kind: SourceKind;
  readonly origin: SourceOrigin;
  readonly normalizer: string;
  readonly asOf: Date;
};

/**
 * First-party admission: an operator-authored document (the build guide, studio notes) enters
 * canonical knowledge through the gate without a research candidate — there is no third-party
 * claim to verify, and the operator is the authority. Anything third-party is refused here and
 * must go through Research Intelligence → runGate.
 * Leaves the transaction in role xyp_promotion; the caller restores its own role.
 * @param tx - ingestion transaction already holding CANONICAL_WRITE_LOCK_KEY
 * @param a - normalized document, its registered source and ingestion run
 * @returns write counts and the promotion run id
 * @throws Error when origin isn't first_party
 */
export const admitFirstParty = async (tx: postgres.TransactionSql, a: FirstPartyAdmission): Promise<{ stats: WriteStats; promotionRunId: string }> => {
  if (a.origin !== 'first_party') throw new Error(FIRST_PARTY_ADMISSION_ERROR);
  await tx.unsafe(`set local role ${quoteIdent(PROMOTION_ROLE)}`);
  const promotionRunId = randomUUID();
  const written = await writeNormalized(tx, a.doc, { sourceId: a.sourceId, runId: a.ingestionRunId, kind: a.kind, origin: a.origin, asOf: a.asOf });
  const approval = { mode: 'first-party-ingest', source_id: a.sourceId, origin: a.origin, normalizer: a.normalizer, ingestion_run_id: a.ingestionRunId };
  await writeVersions(tx, 'modules', written.insertedModuleIds, { candidateId: null, approval, promotionRunId });
  await writeVersions(tx, 'canonical_prompts', written.insertedPromptIds, { candidateId: null, approval, promotionRunId });

  const admission: StepRecord = {
    step: 'first-party-admission',
    passed: true,
    reason: `origin first_party (operator-authored ${a.kind} source, normalizer ${a.normalizer}); no research claim to verify`,
  };
  const write: StepRecord = {
    step: 'canonical-write',
    passed: true,
    reason: `appended ${written.insertedModuleIds.length} module(s) and ${written.insertedPromptIds.length} prompt(s) with knowledge_versions history; ${written.stats.modules.reused + written.stats.prompts.reused} unchanged row(s) reused`,
  };
  const propagation = await propagate(tx, promotionRunId, written.insertedPromptIds);
  await tx`
    insert into promotion_runs (id, mode, source_id, ingestion_run_id, outcome, steps)
    values (${promotionRunId}, 'first_party_ingest', ${a.sourceId}, ${a.ingestionRunId}, 'promoted',
            ${tx.json([admission, write, propagation] as postgres.JSONValue)})`;
  return { stats: written.stats, promotionRunId };
};
