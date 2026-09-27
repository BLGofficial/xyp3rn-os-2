import type postgres from 'postgres';
import type { AgentRegistry } from '../../../core/agent-registry/registry.ts';
import { DOMAINS } from '../../../core/contracts/taxonomy.ts';
import type { Sql } from '../../../core/db/client.ts';
import { parseScope, selectByScope, type Selection } from '../../../core/orchestrator/scope-select.ts';
import { LYRICS_SCHEMA_ID, META_TAG_SET_SCHEMA_ID, STYLE_RECIPE_SCHEMA_ID } from '../../../records/x3lius/creative/schemas.ts';
import { decisionKeys, workflowFiles } from '../../../research-intelligence/brief.ts';
import { asWeb } from './loaders.ts';

/**
 * What the Research screens read (AOS-04 §8), as xyp_web in read-only transactions: the briefs with their
 * targets and latest run, a run's workbench (each specialist's outcome, the quoted evidence, the findings by
 * topic with their contradictions, the owner's decision and any canonical candidate), the Findings Library,
 * and the Research section of a song or a recipe/tag set lineage.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND_OF: Readonly<Record<string, 'recipe' | 'tags' | 'lyrics'>> = { [STYLE_RECIPE_SCHEMA_ID]: 'recipe', [META_TAG_SET_SCHEMA_ID]: 'tags', [LYRICS_SCHEMA_ID]: 'lyrics' };
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export type TargetRow = {
  readonly kind: 'song' | 'lineage' | 'workflow' | 'decision'; readonly target: string; readonly label: string; readonly role: string | null;
  readonly linkId: string; readonly via: 'song_links' | 'research_links';
};
export type BriefRow = {
  readonly questionId: string; readonly question: string; readonly intendedUse: string | null; readonly urls: readonly string[]; readonly createdAt: string;
  readonly targets: readonly TargetRow[]; readonly latestRun: { readonly id: string; readonly status: string; readonly createdAt: string } | null;
};
export type EvidenceRow = {
  readonly id: string; readonly specialist: string; readonly claim: string; readonly quote: string | null; readonly claimTopic: string | null;
  readonly claimValue: unknown; readonly modelTag: string; readonly confidence: number; readonly confidenceInputs: Record<string, unknown>;
  readonly source: { readonly id: string; readonly kind: string; readonly uri: string; readonly title: string; readonly reliability: number | null };
};
export type FindingRow = {
  readonly id: string; readonly claim: string; readonly claimTopic: string; readonly claimValue: unknown; readonly modelTag: string; readonly confidence: number;
  readonly evidenceIds: readonly string[];
  readonly contradictions: readonly { readonly id: string; readonly targetType: string; readonly targetId: string; readonly status: string; readonly detail: unknown }[];
  readonly decision: { readonly decision: 'accept' | 'reject'; readonly by: string; readonly at: string; readonly reason: string } | null;
  readonly candidates: readonly { readonly id: string; readonly status: string; readonly approvalId: string | null; readonly approvalStatus: string | null }[];
};
/** How a specialist's step ended, in words the workbench keeps apart (§17). */
export type Outcome = 'running' | 'completed' | 'no-sources' | 'declined' | 'failed' | 'timed-out';
export type AgentOutcome = {
  readonly specialist: string; readonly status: string; readonly outcome: Outcome; readonly error: string | null;
  readonly declined: readonly { readonly claim?: string; readonly reason: string }[];
  readonly failedUrls: readonly { readonly url: string; readonly reason: string }[]; readonly passages: number | null; readonly evidenceCount: number;
};
export type RunDetail = {
  readonly run: {
    readonly id: string; readonly status: string; readonly error: string | null; readonly createdAt: string; readonly completedAt: string | null;
    readonly expiresAt: string; readonly selection: unknown; readonly selected: readonly string[];
    /** From the recorded start to the recorded end, or to `asOf` while running; never an estimate. */
    readonly elapsedMs: number;
  };
  readonly asOf: string;
  readonly brief: BriefRow; readonly outcomes: readonly AgentOutcome[]; readonly evidence: readonly EvidenceRow[];
  readonly topics: readonly { readonly topic: string; readonly findings: readonly FindingRow[] }[]; readonly unsynthesized: readonly EvidenceRow[];
};
export type LibraryRow = {
  readonly findingId: string; readonly claim: string; readonly claimTopic: string; readonly claimValue: unknown; readonly modelTag: string; readonly confidence: number;
  readonly questionId: string; readonly question: string; readonly runId: string; readonly evidenceCount: number;
  readonly canonicalStatus: 'none' | 'candidate' | 'promoted' | 'rejected'; readonly decidedAt: string; readonly targets: readonly TargetRow[];
  readonly quotes: readonly { readonly quote: string; readonly uri: string; readonly title: string }[];
};

type TargetDb = { question_id: string; kind: TargetRow['kind']; target: string; role: string | null; link_id: string; via: TargetRow['via']; label: string | null };

// Every live target of the given briefs, labelled: a song by its current title, a lineage by its root's name,
// a workflow as name@sha8, a decision by its key.
const targetsOf = async (tx: postgres.TransactionSql, questionIds: readonly string[]): Promise<Map<string, TargetRow[]>> => {
  const rows = await tx<TargetDb[]>`
    select t.question_id, t.kind, t.target, t.role, t.link_id, t.via,
           case t.kind when 'song' then (select s.title from current_songs s where s.id::text = t.target)
                       when 'lineage' then (select coalesce(a.body->>'name', a.schema_id) from creative_artifacts a where a.id::text = t.target) end as label
    from research_targets t
    where t.question_id = any(${[...questionIds]}::uuid[])
    order by t.kind, t.created_at, t.link_id`;
  const m = new Map<string, TargetRow[]>();
  for (const r of rows) {
    const label = r.kind === 'workflow' ? r.target.replace(/@([0-9a-f]{8})[0-9a-f]{56}$/, '@$1') : r.label ?? r.target;
    m.set(r.question_id, [...(m.get(r.question_id) ?? []), { kind: r.kind, target: r.target, label, role: r.role, linkId: r.link_id, via: r.via }]);
  }
  return m;
};

type QuestionDb = { id: string; question: string; intended_use: string | null; urls: string[]; created_at: Date; run_id: string | null; run_status: string | null; run_created_at: Date | null };

// Briefs by id, newest first, each with its targets and latest run.
const briefsOf = async (tx: postgres.TransactionSql, where: postgres.PendingQuery<postgres.Row[]>, limit = 100): Promise<BriefRow[]> => {
  const qs = await tx<QuestionDb[]>`
    select q.id, q.question, q.intended_use, q.urls, q.created_at, r.id as run_id, r.status::text as run_status, r.created_at as run_created_at
    from research_questions q
    left join lateral (select x.id, x.status, x.created_at from research_runs x where x.question_id = q.id order by x.created_at desc, x.id limit 1) r on true
    where ${where}
    order by q.created_at desc, q.id
    limit ${limit}`;
  const targets = await targetsOf(tx, qs.map((q) => q.id));
  return qs.map((q) => ({
    questionId: q.id, question: q.question, intendedUse: q.intended_use, urls: q.urls, createdAt: q.created_at.toISOString(), targets: targets.get(q.id) ?? [],
    latestRun: q.run_id ? { id: q.run_id, status: q.run_status!, createdAt: q.run_created_at!.toISOString() } : null,
  }));
};

/** The domains a canonical candidate may be filed under (the promote form's choices). */
export const promotionDomains = (): readonly string[] => [...DOMAINS];

// The roster the Research Orchestrator scores against: every Research agent with a Scope.
const rosterOf = (registry: AgentRegistry) =>
  registry.list().filter((a) => a.class === 'Research' && a.sections.Scope).map((a) => ({ name: a.name, scope: a.sections.Scope! }));

/**
 * /research: the briefs, and what the new-brief form offers (specialists, workflows, decisions, songs, lineages).
 * @param sql - the app's pool
 * @param registry - the agent registry (the specialists and their scopes)
 * @returns the Research index
 */
export type BriefFilter = { readonly status?: string; readonly kind?: string; readonly target?: string };

export const researchIndex = (sql: Sql, registry: AgentRegistry, filter: BriefFilter = {}) =>
  asWeb(sql, async (tx) => {
    // The latest run's status and a live target, both optional (§17's list filters).
    const briefs = await briefsOf(tx, tx`
      (${filter.status ?? null}::text is null or r.status::text = ${filter.status ?? null})
      and (${filter.kind ?? null}::text is null and ${filter.target ?? null}::text is null
           or exists (select from research_targets t where t.question_id = q.id
                       and (${filter.kind ?? null}::text is null or t.kind = ${filter.kind ?? null})
                       and (${filter.target ?? null}::text is null or t.target = ${filter.target ?? null})))`);
    const songs = await tx<{ id: string; title: string }[]>`select id, title from current_songs order by title, id`;
    const lineages = await tx<{ id: string; name: string | null; schema_id: string }[]>`
      select a.id, a.body->>'name' as name, a.schema_id from creative_artifacts a
      where a.lineage_id = a.id and a.schema_id = any(${Object.keys(KIND_OF)}::text[])
      order by a.schema_id, a.created_at desc, a.id`;
    const [now] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
    return {
      asOf: now!.now.toISOString(),
      briefs,
      specialists: rosterOf(registry).map((r) => ({ name: r.name, scope: r.scope })).sort((x, y) => x.name.localeCompare(y.name)),
      workflows: workflowFiles().map((w) => w.name).sort(),
      decisions: [...decisionKeys()].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1))),
      songs: songs.map((s) => ({ id: s.id, title: s.title })),
      lineages: lineages.map((l) => ({ id: l.id, name: l.name ?? l.schema_id, kind: KIND_OF[l.schema_id]! })),
    };
  });

/**
 * The specialists the keyword selection would pick for a question (the new-brief form's preview).
 * @param registry - the agent registry
 * @param question - the draft question
 * @returns selected and not selected, with scores and matched keywords
 */
export const previewSelection = (registry: AgentRegistry, question: string): Selection =>
  selectByScope(question, rosterOf(registry).map((r) => parseScope(r.name, r.scope)));

type RunDb = {
  id: string; question_id: string; status: string; error_detail: string | null; created_at: Date; completed_at: Date | null; expires_at: Date;
  selection: unknown; selected: string[]; as_of: Date;
};
type EvidenceDb = {
  id: string; specialist: string; claim: string; quote: string | null; claim_topic: string | null; claim_value: unknown; model_tag: string; confidence: string;
  confidence_inputs: Record<string, unknown>; source_id: string; source_kind: string; uri: string; title: string; reliability: string | null;
};
type FindingDb = {
  id: string; claim: string; claim_topic: string; claim_value: unknown; model_tag: string; confidence: string; evidence_ids: string[];
  decision: 'accept' | 'reject' | null; decided_by: string | null; decided_at: Date | null; decision_reason: string | null;
};
type OutcomeDb = {
  agent_name: string; status: string; error_detail: string | null;
  result: { declined?: AgentOutcome['declined']; failedUrls?: AgentOutcome['failedUrls']; passages?: number; evidenceIds?: string[] } | null;
};

// A dispatch timeout is recorded as `timeout after <n>ms` (core/orchestrator/dispatch.ts).
const outcomeOf = (o: OutcomeDb): Outcome =>
  o.status === 'pending' ? 'running'
    : o.status === 'error' ? (o.error_detail?.startsWith('timeout after') ? 'timed-out' : 'failed')
      : o.result?.passages === 0 ? 'no-sources'
        : (o.result?.evidenceIds?.length ?? 0) === 0 && (o.result?.declined?.length ?? 0) > 0 ? 'declined'
          : 'completed';

/**
 * /research/runs/[id]: the run workbench.
 * @param sql - the app's pool
 * @param runId - the research run
 * @returns the run, its brief, each specialist's outcome, the evidence and the findings by topic; null when unknown
 */
export const runDetail = async (sql: Sql, runId: string): Promise<RunDetail | null> => {
  if (!UUID.test(runId)) return null;
  return asWeb(sql, async (tx) => {
    const [r] = await tx<RunDb[]>`
      select id, question_id, status::text, error_detail, created_at, completed_at, expires_at, selection, selected_specialists as selected, now() as as_of
      from research_runs where id = ${runId}`;
    if (!r) return null;
    const [brief] = await briefsOf(tx, tx`q.id = ${r.question_id}`, 1);
    const outcomes = await tx<OutcomeDb[]>`
      select agent_name, status::text, error_detail, output->'result' as result
      from agent_runs where research_run_id = ${runId} and agent_name <> 'research-orchestrator'
      order by created_at, id`;
    const ev = await tx<EvidenceDb[]>`
      select e.id, e.specialist, e.claim, e.quote, e.claim_topic, e.claim_value, e.model_tag, e.confidence, e.confidence_inputs,
             s.id as source_id, s.kind::text as source_kind, s.uri, s.title, s.reliability
      from research_evidence e join research_sources s on s.id = e.research_source_id
      where e.research_run_id = ${runId}
      order by e.created_at, e.id`;
    const fs = await tx<FindingDb[]>`
      select f.id, f.claim, f.claim_topic, f.claim_value, f.model_tag, f.confidence,
             coalesce((select array_agg(fe.evidence_id order by fe.evidence_id) from research_finding_evidence fe where fe.finding_id = f.id), '{}') as evidence_ids,
             d.decision, d.decided_by, d.decided_at, d.decision_reason
      from research_findings f left join current_finding_decisions d on d.finding_id = f.id
      where f.research_run_id = ${runId}
      order by f.claim_topic, f.confidence desc, f.id`;
    const ids = fs.map((f) => f.id);
    const contradictions = await tx<{ id: string; finding_id: string; target_type: string; target_id: string; status: string; detail: unknown }[]>`
      select id, finding_id, target_type::text, target_id, status::text, detail from contradictions where finding_id = any(${ids}::uuid[]) order by created_at, id`;
    const candidates = await tx<{ id: string; finding_id: string; status: string; approval_id: string | null; approval_status: string | null }[]>`
      select k.id, k.finding_id, k.status::text, q.id as approval_id, q.status::text as approval_status
      from knowledge_candidates k left join approval_queue q on q.item_type::text = 'knowledge_candidate' and q.item_id = k.id
      where k.finding_id = any(${ids}::uuid[]) order by k.created_at, k.id`;
    const evidence = ev.map((e): EvidenceRow => ({
      id: e.id, specialist: e.specialist, claim: e.claim, quote: e.quote, claimTopic: e.claim_topic, claimValue: e.claim_value, modelTag: e.model_tag,
      confidence: Number(e.confidence), confidenceInputs: e.confidence_inputs,
      source: { id: e.source_id, kind: e.source_kind, uri: e.uri, title: e.title, reliability: e.reliability === null ? null : Number(e.reliability) },
    }));
    const findings = fs.map((f): FindingRow => ({
      id: f.id, claim: f.claim, claimTopic: f.claim_topic, claimValue: f.claim_value, modelTag: f.model_tag, confidence: Number(f.confidence), evidenceIds: f.evidence_ids,
      contradictions: contradictions.filter((c) => c.finding_id === f.id).map((c) => ({ id: c.id, targetType: c.target_type, targetId: c.target_id, status: c.status, detail: c.detail })),
      decision: f.decision ? { decision: f.decision, by: f.decided_by!, at: f.decided_at!.toISOString(), reason: f.decision_reason! } : null,
      candidates: candidates.filter((c) => c.finding_id === f.id).map((c) => ({ id: c.id, status: c.status, approvalId: c.approval_id, approvalStatus: c.approval_status })),
    }));
    const topics = [...new Set(findings.map((f) => f.claimTopic))].map((topic) => ({ topic, findings: findings.filter((f) => f.claimTopic === topic) }));
    return {
      run: {
        id: r.id, status: r.status, error: r.error_detail, createdAt: r.created_at.toISOString(), completedAt: iso(r.completed_at), expiresAt: r.expires_at.toISOString(),
        selection: r.selection, selected: r.selected, elapsedMs: (r.completed_at ?? r.as_of).getTime() - r.created_at.getTime(),
      },
      asOf: r.as_of.toISOString(),
      brief: brief!,
      // A specialist still running shows as agent_runs 'pending'.
      outcomes: outcomes.map((o) => ({
        specialist: o.agent_name, status: o.status === 'pending' ? 'running' : o.status, outcome: outcomeOf(o), error: o.error_detail,
        declined: o.result?.declined ?? [], failedUrls: o.result?.failedUrls ?? [], passages: o.result?.passages ?? null,
        evidenceCount: o.result?.evidenceIds?.length ?? 0,
      })),
      evidence,
      topics,
      unsynthesized: evidence.filter((e) => e.claimTopic === null),
    };
  });
};

type LibraryDb = {
  finding_id: string; claim: string; claim_topic: string; claim_value: unknown; model_tag: string; confidence: string; question_id: string; question: string;
  research_run_id: string; evidence_count: number; canonical_status: LibraryRow['canonicalStatus']; decided_at: Date;
};

// Library rows matching a filter on the finding's brief, each with the brief's targets and the finding's quotes.
const libraryOf = async (tx: postgres.TransactionSql, where: postgres.PendingQuery<postgres.Row[]>): Promise<LibraryRow[]> => {
  const rows = await tx<LibraryDb[]>`
    select fl.finding_id, fl.claim, fl.claim_topic, fl.claim_value, fl.model_tag, fl.confidence, fl.question_id, fl.question, fl.research_run_id,
           fl.evidence_count, fl.canonical_status, fl.decided_at
    from findings_library fl
    where ${where}
    order by fl.decided_at desc, fl.finding_id`;
  const targets = await targetsOf(tx, [...new Set(rows.map((r) => r.question_id))]);
  const quotes = await tx<{ finding_id: string; quote: string; uri: string; title: string }[]>`
    select fe.finding_id, e.quote, s.uri, s.title
    from research_finding_evidence fe join research_evidence e on e.id = fe.evidence_id join research_sources s on s.id = e.research_source_id
    where fe.finding_id = any(${rows.map((r) => r.finding_id)}::uuid[]) and e.quote is not null
    order by e.created_at, e.id`;
  return rows.map((r) => ({
    findingId: r.finding_id, claim: r.claim, claimTopic: r.claim_topic, claimValue: r.claim_value, modelTag: r.model_tag, confidence: Number(r.confidence),
    questionId: r.question_id, question: r.question, runId: r.research_run_id, evidenceCount: r.evidence_count, canonicalStatus: r.canonical_status,
    decidedAt: r.decided_at.toISOString(), targets: targets.get(r.question_id) ?? [],
    quotes: quotes.filter((q) => q.finding_id === r.finding_id).map((q) => ({ quote: q.quote, uri: q.uri, title: q.title })),
  }));
};

/**
 * /research/library: the findings the owner accepted, optionally only those whose brief links a target.
 * @param sql - the app's pool
 * @param filter - `kind` (song | lineage | workflow | decision) and/or `target` (its id, name@sha or key); `topic` (exact)
 * @returns the library rows, newest decision first
 */
export const library = (sql: Sql, filter: { readonly kind?: string; readonly target?: string; readonly topic?: string } = {}) =>
  asWeb(sql, (tx) => libraryOf(tx, tx`
    (${filter.topic ?? null}::text is null or fl.claim_topic = ${filter.topic ?? null})
    and (${filter.kind ?? null}::text is null and ${filter.target ?? null}::text is null
         or exists (select from research_targets t where t.question_id = fl.question_id
                     and (${filter.kind ?? null}::text is null or t.kind = ${filter.kind ?? null})
                     and (${filter.target ?? null}::text is null or t.target = ${filter.target ?? null})))`));

/**
 * The Research section of a song page or a recipe/tag set page: the briefs that link it and their library findings.
 * @param sql - the app's pool
 * @param target - a song, or a lineage (its root id)
 * @returns the briefs and the accepted findings of those briefs
 */
export const researchFor = (sql: Sql, target: { readonly songId?: string; readonly lineageId?: string }) =>
  asWeb(sql, async (tx) => {
    const [kind, id] = target.songId ? ['song', target.songId] : ['lineage', target.lineageId ?? ''];
    const linked = tx`exists (select from research_targets t where t.question_id = q.id and t.kind = ${kind} and t.target = ${id})`;
    const briefs = await briefsOf(tx, linked);
    const findings = await libraryOf(tx, tx`fl.question_id = any(${briefs.map((b) => b.questionId)}::uuid[])`);
    return { briefs, findings };
  });
