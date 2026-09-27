import { join } from 'node:path';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { connect } from '../../core/db/client.ts';
import { createLlmRunner } from '../../core/llm/runner.ts';
import { dispatch } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { executeResearch, openResearch } from '../../research-intelligence/entrypoint.ts';
import { FAKE_KEYS, fakeModel } from '../../tests/helpers/fake-llm.ts';

// AOS-04 proof §2b (docs/proofs/AOS-04-research.txt): the fixture half of the CLI gate. No provider key is set
// in the proof environment, so the specialists' model call is the FAKE MODEL here, scripted with one real quote
// and one the page never says, exactly as tests/aos-04/brief-to-canonical.test.ts. Everything else is the real
// path: fetch_source on the brief's URL (stubbed page), retrieve_context, write_evidence and the DB's verbatim
// check, synthesis. The owner's decisions after it are the real CLIs.
//   XYP_DATABASE_URL=<throwaway db> node scripts/proof/aos04-seed.ts <songId>

const songId = process.argv[2];
if (!songId) {
  console.error('usage: aos04-seed.ts <songId>');
  process.exit(2);
}
const PAGE = '<html><head><title>[FIXTURE] Suno style order</title></head><body><p>[FIXTURE] Put the vocal descriptor first. Genre tags can follow it.</p></body></html>';
const model = fakeModel({
  override: (schema, _refs, user) => {
    if (!('claims' in ((schema.properties ?? {}) as object))) return undefined;
    const n = Number(/\[(\d+)\] \[FIXTURE\] Suno style order </.exec(user)?.[1]);
    const claim = (quote: string, text: string) => ({
      passage: n, quote, claim: text, claim_topic: 'suno.vocal-descriptor-position', claim_value: '"first"', model_tag: 'suno-v5', confidence: 0.6,
      confidence_inputs: { basis: '[FAKE] one page', directness: 'direct' },
    });
    return { claims: [claim('Put the vocal descriptor first.', '[FAKE] the vocal descriptor goes first'), claim('Always put the vocal descriptor first, it doubles adherence.', '[FAKE] fabricated')], declined: [] };
  },
});
const sql = connect(undefined, { max: 2 });
try {
  const deps = {
    sql, registry: createAgentRegistry({ dir: join(import.meta.dirname, '..', '..', 'agents') }), handlers: HANDLERS,
    tools: createRuntimeTools({ sql, env: {}, fetch: async () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } }) }),
    llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
  };
  const opened = await openResearch(deps, {
    projectSlug: 'aos04-proof', question: 'Where should the vocal descriptor go in a Suno style prompt?', intendedUse: '[FIXTURE] fix the order of the Night drive recipe',
    urls: ['https://example.org/suno-style-order'], specialists: ['suno-researcher'], targets: [{ kind: 'decision', decisionKey: 'F41' }],
  }, { requireIntendedUse: true });
  const linked = await dispatch(deps, 'records-songs', { link: { songId, researchQuestionId: opened.questionId, role: 'research' } });
  const r = await executeResearch(deps, opened.researchRunId, { log: (l) => console.error(l) });
  const [step] = await sql<{ result: unknown }[]>`select output->'result' as result from agent_runs where research_run_id = ${r.researchRunId} and agent_name = 'suno-researcher'`;
  const findings = await sql`select id, claim_topic, claim_value, claim, confidence from research_findings where research_run_id = ${r.researchRunId}`;
  console.log(JSON.stringify({ ...r, questionId: opened.questionId, songLink: linked.status, specialist: step?.result, findings }, null, 2));
} finally {
  await sql.end();
}
