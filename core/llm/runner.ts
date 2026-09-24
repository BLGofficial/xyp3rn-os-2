import type { AgentContext, LlmRunner } from '../orchestrator/dispatch.ts';
import { createLlmClient, type LlmClient } from './providers.ts';

/**
 * Per-run timeout for LLM-backed agents (dispatch's 30s default is sized for deterministic work).
 * 300s: a reasoning model on a shared free route took 113s for one verse (Nemotron via OpenRouter,
 * 2026-09-24), plus room for transient-error retries. Callers pass it as dispatch `timeoutMs`.
 */
export const LLM_TIMEOUT_MS = 300_000;

/**
 * An LLM-backed agent's program: its own deterministic steps (context pulls, validation, writes)
 * around calls to a client bound to the agent's frontmatter model. Keyed by agent name and
 * checked in, like the deterministic HANDLERS table.
 */
export type LlmProgram = (ctx: AgentContext, input: unknown, llm: LlmClient) => Promise<{ readonly output: unknown; readonly tokensUsed?: number }>;

/**
 * The shared LlmRunner the dispatcher uses for every agent whose model isn't `none` (Phase 4D
 * binding, unchanged). There is no generic tool-loop runner yet: an LLM agent without a program
 * fails with that reason rather than improvising one.
 * @param options - `programs` by agent name; `env` holding provider keys; `fetch` override (tests)
 * @returns the runner
 */
export const createLlmRunner = (options: {
  readonly programs: Readonly<Record<string, LlmProgram>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}): LlmRunner => async (ctx, input) => {
  const program = options.programs[ctx.agent.name];
  if (!program) throw new Error(`no LLM program registered for agent ${ctx.agent.name} (model ${ctx.agent.model})`);
  const llm = createLlmClient({ model: ctx.agent.model, agentName: ctx.agent.name, env: options.env, ...(options.fetch ? { fetch: options.fetch } : {}) });
  return program(ctx, input, llm);
};
