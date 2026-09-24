import { createHash } from 'node:crypto';
import { connect } from '../core/db/client.ts';
import { candidateEligibility, resolveContradiction } from './contradictions/engine.ts';
import { asRole, RESEARCH_ROLE } from './db.ts';
import { writeEvidence } from './evidence/engine.ts';
import { designExperiment, experimentResult, recordTrial } from './experiments/engine.ts';
import { registerResearchSource } from './sources/verify.ts';
import { proposeCandidate, recordFinding } from './synthesis/findings.ts';

// Human-in-the-loop access to the 6C engines (until LLM specialists run), same rules as agents:
//   pnpm research open        '{"projectSlug":"…","question":"…"}'
//   pnpm research observation '{"researchRunId":"…","uri":"studio:…","title":"…","note":"…","claim":"…","model_tag":"…","confidence":0.7,"confidence_inputs":{…},"claim_topic"?:"…","claim_value"?:…}'
//   pnpm research finding     '{"researchRunId":"…","claim":"…","claim_topic":"…","claim_value":…,"model_tag":"…","evidenceIds":["…"]}'
//   pnpm research candidate   '{"findingId":"…","proposed_kind":"canonical_prompt","target_slug":"…","title":"…","body":"…","domain":"RECORDS"}'
//   pnpm research eligibility <candidateId>
//   pnpm research resolve     <contradictionId> manual|experiment "<reason>" [experimentId]
//   pnpm research experiment:design '{"candidateId":"…","hypothesis":"…","variantA":{…},"variantB":{…},"nPerVariant":3}'
//   pnpm research experiment:trial  '{"experimentId":"…","variant":"a","trial":1,"output":{…}}'
//   pnpm research experiment:result <experimentId>

const [cmd, arg1, arg2, arg3, arg4] = process.argv.slice(2);
const json = (s: string | undefined) => JSON.parse(s ?? '{}') as Record<string, unknown>;
const sql = connect(undefined, { max: 2 });

try {
  let out: unknown;
  switch (cmd) {
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
      out = { experimentId: await designExperiment(sql, json(arg1) as never) };
      break;
    case 'experiment:trial':
      await recordTrial(sql, json(arg1) as never);
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
