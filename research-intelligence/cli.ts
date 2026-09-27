import { createHash } from 'node:crypto';
import { connect } from '../core/db/client.ts';
import { dispatch } from '../core/orchestrator/dispatch.ts';
import { createRuntimeDeps } from '../core/runtime/deps.ts';
import { CRITIC_SCORER_ID, criticScorer } from '../records/x3lius/evaluation/scorer.ts';
import type { Brief } from './brief.ts';
import { candidateEligibility, resolveContradiction } from './contradictions/engine.ts';
import { asRole, RESEARCH_ROLE } from './db.ts';
import { writeEvidence } from './evidence/engine.ts';
import { executeResearch, openResearch, sweepResearch } from './entrypoint.ts';
import { designExperiment, experimentResult, recordTrial } from './experiments/engine.ts';
import { decideFinding, promoteFinding } from './library.ts';
import { citeIngestedSource, registerResearchSource } from './sources/verify.ts';
import { proposeCandidate, recordFinding } from './synthesis/findings.ts';

// Research mode (AOS-04): a brief run live on the OpenRouter free route (OPENROUTER_API_KEY), the owner's decisions:
//   pnpm research ask     '{"projectSlug":"…","question":"…","intendedUse":"…","urls":["https://…"],"specialists"?:["…"],"targets"?:[{"kind":"decision","decisionKey":"F41"}],"songId"?:"…"}'
//     sweep, open, link the song, run the selected specialists, synthesize; prints the run, its evidence and findings
//   pnpm research decide  <findingId> accept|reject "<reason>"         (approver: $XYP_OWNER, default "owner")
//   pnpm research promote '{"findingId":"…","proposed_kind":"canonical_prompt","target_slug":"…","title":"…","body":"…","domain":"RECORDS"}'
//     an accepted finding → a candidate → the gate (pending approval: decide it with `pnpm gate decide`)
// Human-in-the-loop access to the 6C engines, same rules as agents:
//   pnpm research open        '{"projectSlug":"…","question":"…"}'
//   pnpm research observation '{"researchRunId":"…","uri":"studio:…","title":"…","note":"…","claim":"…","model_tag":"…","confidence":0.7,"confidence_inputs":{…},"claim_topic"?:"…","claim_value"?:…}'
//   pnpm research cite        '{"researchRunId":"…","sourceId":"…","excerpt":"<verbatim passage>","claim":"…","model_tag":"…","confidence":0.9,"confidence_inputs":{…},"claim_topic"?:"…","claim_value"?:…}'
//   pnpm research finding     '{"researchRunId":"…","claim":"…","claim_topic":"…","claim_value":…,"model_tag":"…","evidenceIds":["…"]}'
//   pnpm research candidate   '{"findingId":"…","proposed_kind":"canonical_prompt","target_slug":"…","title":"…","body":"…","domain":"RECORDS"}'
//   pnpm research eligibility <candidateId>
//   pnpm research resolve     <contradictionId> manual|experiment "<reason>" [experimentId]
//   pnpm research experiment:design '{"candidateId":"…","hypothesis":"…","variantA":{…},"variantB":{…},"nPerVariant":3}'
//   pnpm research experiment:trial  '{"experimentId":"…","variant":"a","trial":1,"output":{"artifactId":"…"}}'
//     Scored by the Phase 12 Critic: output must name the creative artifact the trial produced
//     ({ "artifactId": "<uuid>" }); anything else is recorded with score null and the reason.
//   pnpm research experiment:result <experimentId>

const [cmd, arg1, arg2, arg3, arg4] = process.argv.slice(2);
const json = (s: string | undefined) => JSON.parse(s ?? '{}') as Record<string, unknown>;
const sql = connect(undefined, { max: 2 });

try {
  let out: unknown;
  switch (cmd) {
    case 'ask': {
      const brief = json(arg1) as unknown as Brief & { songId?: string };
      const deps = createRuntimeDeps(sql);
      // A bad song id is refused before the run opens, so it can't leave a run waiting for its deadline.
      if (brief.songId && (await sql`select 1 from songs where id = ${brief.songId}`).length === 0) throw new Error(`no song ${brief.songId}`);
      await sweepResearch(sql);
      const opened = await openResearch(deps, brief, { requireIntendedUse: true });
      if (brief.songId) {
        // The song's side of the link is a Records agent run (A1), as the web's songLink does it.
        const linked = await dispatch(deps, 'records-songs', { link: { songId: brief.songId, researchQuestionId: opened.questionId } });
        if (linked.status !== 'success') console.error(`song link failed: ${linked.error}`);
      }
      const r = await executeResearch(deps, opened.researchRunId, { log: (l) => console.error(l) });
      const evidence = await sql`select specialist, claim, quote, confidence from research_evidence where research_run_id = ${r.researchRunId} order by created_at`;
      const findings = await sql`select id, claim_topic, claim_value, claim, confidence from research_findings where research_run_id = ${r.researchRunId} order by created_at`;
      out = { ...r, questionId: opened.questionId, evidence, findings };
      if (r.status === 'error') process.exitCode = 1;
      break;
    }
    case 'decide':
      if (arg2 !== 'accept' && arg2 !== 'reject') throw new Error('decision must be accept or reject');
      out = await decideFinding(sql, arg1!, { decision: arg2, approver: process.env.XYP_OWNER || 'owner', reason: arg3 ?? '' });
      break;
    case 'promote':
      out = await promoteFinding(sql, json(arg1) as never);
      break;
    case 'open': {
      const a = json(arg1) as { projectSlug: string; question: string };
      out = await asRole(sql, RESEARCH_ROLE, async (tx) => {
        await tx`insert into research_projects (slug, title) values (${a.projectSlug}, ${a.projectSlug}) on conflict (slug) do nothing`;
        const [p] = await tx<{ id: string }[]>`select id from research_projects where slug = ${a.projectSlug}`;
        const [q] = await tx<{ id: string }[]>`insert into research_questions (project_id, question) values (${p!.id}, ${a.question}) returning id`;
        const [r] = await tx<{ id: string }[]>`insert into research_runs (question_id) values (${q!.id}) returning id`;
        return { researchRunId: r!.id };
      });
      break;
    }
    case 'observation': {
      const a = json(arg1) as { researchRunId: string; uri: string; title: string; note: string } & Record<string, unknown>;
      const src = await registerResearchSource(sql, {
        researchRunId: a.researchRunId, kind: 'observation', uri: a.uri, title: a.title,
        contentSha256: createHash('sha256').update(`${a.uri}\n${a.note}`).digest('hex'), excerpt: a.note,
      });
      const { researchRunId, uri: _u, title: _t, note: _n, ...ev } = a;
      const evidenceId = await writeEvidence(sql, { researchRunId, agentRunId: null, specialist: 'human:studio' }, { ...ev, research_source_id: src.id });
      out = { researchSourceId: src.id, reliability: src.reliability, evidenceId };
      break;
    }
    case 'cite': {
      const a = json(arg1) as { researchRunId: string; sourceId: string; excerpt: string } & Record<string, unknown>;
      const src = await citeIngestedSource(sql, { researchRunId: a.researchRunId, sourceId: a.sourceId, excerpt: a.excerpt });
      const { researchRunId, sourceId: _s, excerpt: _e, ...ev } = a;
      const evidenceId = await writeEvidence(sql, { researchRunId, agentRunId: null, specialist: 'human:operator' }, { ...ev, research_source_id: src.id });
      out = { researchSourceId: src.id, reliability: src.reliability, citedIn: src.citedIn, evidenceId };
      break;
    }
    case 'finding':
      out = await recordFinding(sql, json(arg1) as never);
      break;
    case 'candidate':
      out = { candidateId: await proposeCandidate(sql, json(arg1) as never) };
      break;
    case 'eligibility':
      out = await candidateEligibility(sql, arg1!);
      break;
    case 'resolve':
      await resolveContradiction(sql, arg1!, { method: arg2 as 'manual' | 'experiment', reason: arg3 ?? '', ...(arg4 ? { experimentId: arg4 } : {}) });
      out = { resolved: arg1 };
      break;
    case 'experiment:design':
      out = { experimentId: await designExperiment(sql, json(arg1) as never, CRITIC_SCORER_ID) };
      break;
    case 'experiment:trial':
      await recordTrial(sql, json(arg1) as never, criticScorer(createRuntimeDeps(sql)));
      out = { recorded: true };
      break;
    case 'experiment:result':
      out = await experimentResult(sql, arg1!);
      break;
    default:
      throw new Error(`unknown command ${cmd ?? '(none)'} — see the usage comment in research-intelligence/cli.ts`);
  }
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
