import type { ContextEngine } from '../../../core/context-engine/context-engine.ts';
import type { DispatchDeps } from '../../../core/orchestrator/dispatch.ts';
import { JarvisCore } from '../../../core/src/jarvis/JarvisOrchestrator.ts';
import { MONDAY_REVIEW } from '../../../core/src/playbooks/monday-review.ts';

/**
 * The command bar's in-process door to JarvisCore (loaded through lib/os.ts). It takes only what JarvisCore answers
 * deterministically and read-only (the playbooks), so the bar works with Galaxy down. Everything else, including
 * anything that would start a run, stays with the Python Jarvis and its confirm-before-run step: a keyword in
 * ordinary chat must never start a workflow by itself.
 */

export type CoreRuntime = { readonly deps: DispatchDeps; readonly engine: () => Promise<ContextEngine> };

export type CoreAnswer = { readonly answer: string; readonly route: 'jarvis core'; readonly status: string };

/** @returns true when JarvisCore handles this sentence itself. */
export const isCoreCommand = (text: string): boolean => MONDAY_REVIEW.test(text);

/**
 * @param text - the command, already trimmed and non-empty
 * @param rt - the web runtime (pool, registry, tools, lazy Context Engine)
 * @returns JarvisCore's butler-toned answer, or undefined when the sentence is not one it handles
 */
export const commandViaCore = async (text: string, rt: CoreRuntime): Promise<CoreAnswer | undefined> => {
  if (!isCoreCommand(text)) return undefined;
  const core = new JarvisCore({ ...rt.deps, engine: { retrieve: (async (...a: Parameters<ContextEngine['retrieve']>) => (await rt.engine()).retrieve(...a)) as ContextEngine['retrieve'] } });
  const r = await core.interceptAndExecute('http', { type: 'ask', request: text });
  return { answer: r.summary, route: 'jarvis core', status: r.status };
};
