import type { ContextBundle, ContextEngine } from '../context-engine/context-engine.ts';
import type { RankLimits } from '../context-engine/rank.ts';

/**
 * Memory service. Two tiers with a hard boundary:
 *
 * - SHORT-TERM (RunMemory): one workflow run's accumulated state — its input and each step's
 *   output. In-process, write-once per step, discarded when the run ends. Its only durable
 *   trace is the agent_runs rows. Never shared across runs, never written to the database.
 *
 * - LONG-TERM (LongTermMemory): the Phase 3 Context Engine over canonical knowledge. Read-only
 *   by construction — no write method exists. Knowledge enters long-term memory only through
 *   the Phase 6D Promotion Gate (first-party admission or a promoted candidate), never from a workflow.
 */

export type RunMemory = {
  readonly remember: (stepId: string, output: unknown) => void;
  /** Path forms: `input.<key>[.<key>…]` or `steps.<id>.output[.<key>…]`; numeric keys index arrays. */
  readonly recall: (path: string) => unknown;
  readonly snapshot: () => { readonly input: unknown; readonly steps: Readonly<Record<string, unknown>> };
};

const walk = (root: unknown, keys: readonly string[], path: string): unknown => {
  let cur: unknown = root;
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object' || !(k in (cur as Record<string, unknown>))) {
      throw new Error(`path ${path} does not resolve`);
    }
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
};

/**
 * Creates one run's short-term memory.
 * @param input - the workflow input
 * @returns remember/recall/snapshot over private state
 */
export const createRunMemory = (input: unknown): RunMemory => {
  const steps = new Map<string, unknown>();
  return {
    remember: (stepId, output) => {
      if (steps.has(stepId)) throw new Error(`step ${stepId} already has an output`);
      steps.set(stepId, output);
    },
    recall: (path) => {
      const parts = path.split('.');
      if (parts[0] === 'input') return walk(input, parts.slice(1), path);
      if (parts[0] === 'steps' && parts[2] === 'output') {
        const id = parts[1]!;
        if (!steps.has(id)) throw new Error(`no output recorded for step ${id}`);
        return walk(steps.get(id), parts.slice(3), path);
      }
      throw new Error(`path ${path} must start with "input." or "steps.<id>.output"`);
    },
    snapshot: () => ({ input, steps: Object.fromEntries(steps) }),
  };
};

/**
 * Replaces every `{ $from: "<path>" }` inside a step input with the recalled value.
 * @param template - step input from the workflow spec
 * @param memory - the run's short-term memory
 * @returns the concrete input for dispatch
 */
export const resolveBindings = (template: unknown, memory: RunMemory): unknown => {
  if (Array.isArray(template)) return template.map((t) => resolveBindings(t, memory));
  if (template !== null && typeof template === 'object') {
    const o = template as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o.$from === 'string') return memory.recall(o.$from);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolveBindings(v, memory)]));
  }
  return template;
};

export type LongTermMemory = {
  readonly recall: (query: string, limits?: RankLimits) => Promise<ContextBundle>;
};

/**
 * Long-term memory: a read-only facade over the Context Engine.
 * @param engine - Phase 3 Context Engine (or anything with its retrieve signature)
 * @returns recall(query) — deliberately nothing else
 */
export const createLongTermMemory = (engine: Pick<ContextEngine, 'retrieve'>): LongTermMemory => ({
  recall: (query, limits) => engine.retrieve(query, limits ? { limits } : {}),
});
