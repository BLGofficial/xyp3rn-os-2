import { createLlmRunner, type LlmProgram } from '../llm/runner.ts';
import type { LlmRunner } from '../orchestrator/dispatch.ts';
import { CREATIVE_PROGRAMS } from '../../records/x3lius/creative/program.ts';
import { CRITIC_AGENT, criticProgram } from '../../records/x3lius/evaluation/critic.ts';
import { REVISION_AGENT, revisionProgram } from '../../records/x3lius/evaluation/revision.ts';
import { RD_AGENT, rdBacklogProgram } from '../../tech/r-and-d/backlog.ts';

/**
 * LLM-backed agent programs, keyed by agent name. Checked in and typechecked, like HANDLERS:
 * nothing is loaded dynamically from agents/. An LLM agent missing here fails dispatch with
 * "no LLM program registered" (the Phase 6B specialists, until their runner exists).
 */
export const LLM_PROGRAMS: Readonly<Record<string, LlmProgram>> = {
  // Phase 8: X3LIUS Songwriting, Lyrics, Composition. Phase 9: Genre/Style, Suno Prompt-Formula.
  // Phase 11: Arrangement, Production.
  ...CREATIVE_PROGRAMS,
  // Phase 12: the Critic (x3lius-evaluation, replacing its Phase 7 stub).
  [CRITIC_AGENT]: criticProgram,
  // Phase 12: Revision (x3lius-revision), run by the loop controller after each critique.
  [REVISION_AGENT]: revisionProgram,
  // Phase 14: the R&D backlog (tech-r-and-d, Planning): proposals from the Frontier Scanner's evidence.
  [RD_AGENT]: rdBacklogProgram,
};

/**
 * The live LLM runner for CLIs: programs above, provider keys from the environment.
 * @param env - where ANTHROPIC_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY are read (default process.env)
 * @returns the runner passed to dispatch as `llmRunner`
 */
export const createRuntimeLlmRunner = (env: Readonly<Record<string, string | undefined>> = process.env): LlmRunner =>
  createLlmRunner({ programs: LLM_PROGRAMS, env });
