import { createLlmRunner, type LlmProgram } from '../llm/runner.ts';
import type { LlmRunner } from '../orchestrator/dispatch.ts';
import { CREATIVE_PROGRAMS } from '../../records/x3lius/creative/program.ts';

/**
 * LLM-backed agent programs, keyed by agent name. Checked in and typechecked, like HANDLERS:
 * nothing is loaded dynamically from agents/. An LLM agent missing here fails dispatch with
 * "no LLM program registered" (the Phase 6B specialists, until their runner exists).
 */
export const LLM_PROGRAMS: Readonly<Record<string, LlmProgram>> = {
  // Phase 8: X3LIUS Songwriting, Lyrics, Composition. Phase 9: Genre/Style, Suno Prompt-Formula.
  // Phase 11: Arrangement, Production.
  ...CREATIVE_PROGRAMS,
};

/**
 * The live LLM runner for CLIs: programs above, provider keys from the environment.
 * @param env - where ANTHROPIC_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY are read (default process.env)
 * @returns the runner passed to dispatch as `llmRunner`
 */
export const createRuntimeLlmRunner = (env: Readonly<Record<string, string | undefined>> = process.env): LlmRunner =>
  createLlmRunner({ programs: LLM_PROGRAMS, env });
