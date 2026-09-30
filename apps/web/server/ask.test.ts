import { describe, expect, it } from 'vitest';
import type { AskResult } from '../../../core/orchestrator/ask.ts';
import { cancelAsk, getAsk, startAsk, type AskRunners } from './ask-ops.ts';

// Mercury's Ask (JARVIS Prompt 04 gap: the assistant surface): the command input's Ask button picks a tier and
// either answers at once (lookup, hold, clarify) or starts a job whose page is /ask/[id]. No DB, no model: every
// runner is a fake, so this pins the routing, the job states, the caps and cancel.

let n = 0;
const owner = () => `owner-${++n}`; // the job store is per process: a fresh owner per test keeps them apart
const never = () => new Promise<never>(() => {});
const tick = () => new Promise((r) => setTimeout(r, 0));

const runners = (over: Partial<AskRunners> = {}): AskRunners => ({
  engine: true,
  answerLookup: async () => ({ reply: '1 approval is pending: knowledge_candidate.', source: 'template' }),
  runPlan: async () => ({ kind: 'workflow', result: { workflowRunId: 'w1', status: 'success', skippedSteps: [], steps: [] } }) as AskResult,
  runSkill: async () => ({ ok: true, reply: 'Skill done.', sessionId: 's1' }),
  runDeep: async () => ({ ok: true, reply: 'Deep done.' }),
  ...over,
});

describe('startAsk: one request, one tier', () => {
  it('refuses an empty request', async () => {
    await expect(startAsk(owner(), { text: '   ' }, runners())).rejects.toThrow('Type a request first');
  });

  it('answers a question about stored data at once (tier 2)', async () => {
    const o = owner();
    const id = await startAsk(o, { text: 'how many approvals are pending' }, runners());
    expect(getAsk(o, id)).toMatchObject({ state: 'done', action: 'lookup', status: 'template', reply: '1 approval is pending: knowledge_candidate.' });
  });

  it('says why when the router cannot place a request (clarify), without running anything', async () => {
    const o = owner();
    let ran = false;
    const id = await startAsk(o, { text: 'zzz' }, runners({ runPlan: async () => { ran = true; throw new Error('no'); } }));
    expect(getAsk(o, id)).toMatchObject({ state: 'done', action: 'clarify', status: 'clarify', reply: 'Needs clarification: no domain matched; rephrase with domain terms.' });
    expect(ran).toBe(false);
  });

  it('runs a routed request in the background and reports the real result (tier 4)', async () => {
    const o = owner();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Engine off: with it on, a leading "Research" is the spoken xyp-research skill (tier 1).
    const id = await startAsk(o, { text: 'Research the best current method for dark vocals in Suno' }, runners({
      engine: false,
      runPlan: async () => { await gate; return { kind: 'research', result: { researchRunId: 'r1', status: 'success', selected: ['a'], workflowRunId: 'w' } }; },
    }));
    expect(getAsk(o, id)).toMatchObject({ state: 'running', action: 'run-service', route: { domain: 'RESEARCH_INTELLIGENCE' } });
    release(); await tick(); await tick();
    expect(getAsk(o, id)).toMatchObject({ state: 'done', status: 'success', reply: 'Research run finished. Specialists: a.', refs: { researchRunId: 'r1' } });
  });

  it('a run that throws ends as a plain failure, never as its raw error text', async () => {
    const o = owner();
    const id = await startAsk(o, { text: 'Research the best current method for dark vocals in Suno' }, runners({ engine: false, runPlan: async () => { throw new Error('SECRET provider detail'); } }));
    await tick(); await tick();
    expect(getAsk(o, id)?.status).toBe('error');
    expect(getAsk(o, id)?.reply).not.toContain('SECRET');
  });

  it('starts an explicit skill with Claude Code (tier 1) and a deep task (tier 3)', async () => {
    const o = owner();
    const calls: string[] = [];
    const r = runners({
      runSkill: async (skill, text) => { calls.push(`${skill}:${text}`); return { ok: true, reply: 'Skill done.' }; },
      runDeep: async (text) => { calls.push(`deep:${text}`); return { ok: false, reply: 'Claude Code stopped.' }; },
    });
    const a = await startAsk(o, { text: 'dark vocals', skill: 'xyp-research' }, r);
    const b = await startAsk(o, { text: 'plan next month', deep: true }, r);
    await tick(); await tick();
    expect(calls).toEqual(['xyp-research:dark vocals', 'deep:plan next month']);
    expect(getAsk(o, a)).toMatchObject({ state: 'done', action: 'skill', status: 'success', reply: 'Skill done.' });
    expect(getAsk(o, b)).toMatchObject({ state: 'done', action: 'deep', status: 'error', reply: 'Claude Code stopped.' });
  });

  it('refuses skills and deep tasks with the engine off, and an unknown skill', async () => {
    await expect(startAsk(owner(), { text: 'x', skill: 'xyp-research' }, runners({ engine: false }))).rejects.toThrow('LLM_ENGINE=claude-code');
    await expect(startAsk(owner(), { text: 'x', deep: true }, runners({ engine: false }))).rejects.toThrow('LLM_ENGINE=claude-code');
    await expect(startAsk(owner(), { text: 'x', skill: 'rm -rf' }, runners())).rejects.toThrow('Unknown skill');
  });

  it('caps one deep task and two running jobs per owner', async () => {
    const o = owner();
    const r = runners({ runDeep: never, runSkill: never });
    await startAsk(o, { text: 'a', deep: true }, r);
    await expect(startAsk(o, { text: 'b', deep: true }, r)).rejects.toThrow('A deep task is already running');
    await startAsk(o, { text: 'c', skill: 'xyp-music' }, r);
    await expect(startAsk(o, { text: 'd', skill: 'xyp-music' }, r)).rejects.toThrow('Two requests are already running');
  });
});

describe('cancelAsk and getAsk', () => {
  it('cancels a running Claude Code job: the signal aborts and the page says cancelled', async () => {
    const o = owner();
    let signal: AbortSignal | undefined;
    const id = await startAsk(o, { text: 'x', skill: 'xyp-research' }, runners({ runSkill: (_s, _t, opts) => { signal = opts?.signal; return never(); } }));
    expect(cancelAsk(o, id)).toBe('cancelled');
    expect(signal?.aborted).toBe(true);
    expect(getAsk(o, id)).toMatchObject({ state: 'done', status: 'cancelled' });
    expect(cancelAsk(o, id)).toBe('not-found');
  });

  it("never shows or cancels another owner's job, or an unknown id", async () => {
    const o = owner();
    const id = await startAsk(o, { text: 'x', skill: 'xyp-research' }, runners({ runSkill: never }));
    expect(getAsk(owner(), id)).toBeUndefined();
    expect(cancelAsk(owner(), id)).toBe('not-found');
    expect(getAsk(o, 'nope')).toBeUndefined();
  });
});
