import { parse as parseYaml } from 'yaml';

/**
 * Declarative workflow spec (YAML). A DAG of agent steps; data passes between steps only via
 * `{ $from: "input.<key>" }` or `{ $from: "steps.<id>.output[.<path>]" }`. Everything is
 * checked before anything runs, and every problem is reported at once.
 */

export type WorkflowStep = {
  readonly id: string;
  readonly agent: string;
  readonly dependsOn: readonly string[];
  readonly input: unknown;
};

export type WorkflowSpec = {
  readonly name: string;
  readonly description: string;
  readonly requiredInput: readonly string[];
  /** Inputs a caller may leave out (AOS-03, G11); an absent one binds as null. */
  readonly optionalInput: readonly string[];
  readonly steps: readonly WorkflowStep[];
  /** What the run returns; defaults to the last step's output. */
  readonly output: unknown;
};

export type SpecResult = { readonly ok: true; readonly spec: WorkflowSpec } | { readonly ok: false; readonly errors: readonly string[] };

const TOP_KEYS = ['name', 'description', 'input', 'steps', 'output'];
const STEP_KEYS = ['id', 'agent', 'dependsOn', 'input'];
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const STEP_ID = /^[a-z][a-z0-9_-]*$/;

/** Every `$from` path inside a value. */
const refsIn = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.flatMap(refsIn);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && '$from' in o) return [String(o.$from)];
    return Object.values(o).flatMap(refsIn);
  }
  return [];
};

/**
 * Topological order; ties broken by spec order so the same spec always runs the same way.
 * @param steps - ids with their dependencies (assumed acyclic and resolvable)
 * @returns step ids in execution order
 */
export const topoOrder = (steps: ReadonlyArray<{ readonly id: string; readonly dependsOn: readonly string[] }>): string[] => {
  const done = new Set<string>();
  const order: string[] = [];
  while (order.length < steps.length) {
    const next = steps.find((s) => !done.has(s.id) && s.dependsOn.every((d) => done.has(d)));
    if (!next) break; // cycle — reported by parseWorkflowSpec
    done.add(next.id);
    order.push(next.id);
  }
  return order;
};

const findCycle = (steps: readonly WorkflowStep[]): string[] | undefined => {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const s of steps) {
    const c = visit(s.id);
    if (c) return c.reverse();
  }
  return undefined;
};

/**
 * Parses and validates a workflow spec against the set of registered agent names.
 * @param yaml - spec file contents
 * @param agents - names the Agent Registry currently serves
 * @returns the spec, or every error found
 */
export const parseWorkflowSpec = (yaml: string, agents: ReadonlySet<string>): SpecResult => {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (e) {
    return { ok: false, errors: [`not valid YAML: ${(e as Error).message.split('\n')[0]}`] };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['spec must be a key/value mapping'] };
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];

  for (const k of Object.keys(r)) if (!TOP_KEYS.includes(k)) errors.push(`unknown field: ${k}`);
  if (typeof r.name !== 'string' || !KEBAB.test(r.name)) errors.push(`name must be kebab-case: ${String(r.name)}`);
  if (typeof r.description !== 'string' || r.description.trim() === '') errors.push('description is required');

  const inputDecl = (r.input ?? { required: [] }) as { required?: unknown; optional?: unknown };
  const requiredInput = Array.isArray(inputDecl.required) ? inputDecl.required.map(String) : [];
  if (inputDecl.optional !== undefined && !Array.isArray(inputDecl.optional)) errors.push('input.optional must be a list');
  const optionalInput = Array.isArray(inputDecl.optional) ? inputDecl.optional.map(String) : [];
  for (const k of optionalInput) if (requiredInput.includes(k)) errors.push(`input ${k} is both required and optional`);
  const declaredInput = [...requiredInput, ...optionalInput];

  if (!Array.isArray(r.steps) || r.steps.length === 0) {
    errors.push('steps must be a non-empty list');
    return { ok: false, errors };
  }

  const steps: WorkflowStep[] = [];
  const seen = new Set<string>();
  for (const [i, s] of (r.steps as unknown[]).entries()) {
    const st = (s ?? {}) as Record<string, unknown>;
    const id = typeof st.id === 'string' ? st.id : `#${i}`;
    for (const k of Object.keys(st)) if (!STEP_KEYS.includes(k)) errors.push(`step ${id}: unknown field: ${k}`);
    if (typeof st.id !== 'string' || !STEP_ID.test(st.id)) errors.push(`step ${id}: id must match ${STEP_ID}`);
    if (seen.has(id)) errors.push(`duplicate step id: ${id}`);
    seen.add(id);
    if (typeof st.agent !== 'string') errors.push(`step ${id}: agent is required`);
    else if (!agents.has(st.agent)) errors.push(`step ${id}: unknown agent ${st.agent}`);
    const dependsOn = st.dependsOn === undefined ? [] : st.dependsOn;
    if (!Array.isArray(dependsOn)) errors.push(`step ${id}: dependsOn must be a list`);
    steps.push({ id, agent: String(st.agent), dependsOn: Array.isArray(dependsOn) ? dependsOn.map(String) : [], input: st.input ?? {} });
  }

  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) for (const d of s.dependsOn) if (!ids.has(d)) errors.push(`step ${s.id}: dependsOn unknown step ${d}`);

  const cycle = findCycle(steps);
  if (cycle) errors.push(`cycle detected: ${cycle.join(' -> ')}`);

  // A step may only read data that is guaranteed to exist when it runs: declared inputs and
  // outputs of its (transitive) upstream dependencies.
  const byId = new Map(steps.map((s) => [s.id, s]));
  const ancestors = (id: string, acc = new Set<string>()): Set<string> => {
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (acc.has(d) || !byId.has(d)) continue;
      acc.add(d);
      ancestors(d, acc);
    }
    return acc;
  };
  const checkRef = (where: string, ref: string, upstream: Set<string> | 'all') => {
    const p = ref.split('.');
    if (p[0] === 'input' && p.length >= 2) {
      if (declaredInput.length > 0 && !declaredInput.includes(p[1]!)) {
        const optional = optionalInput.length > 0 ? `; optional: ${optionalInput.join(', ')}` : '';
        errors.push(`${where}: $from ${ref} is not a declared input (required: ${requiredInput.join(', ')}${optional})`);
      }
    } else if (p[0] === 'steps' && p[2] === 'output' && p[1]) {
      if (!ids.has(p[1])) errors.push(`${where}: $from ${ref} references unknown step ${p[1]}`);
      else if (upstream !== 'all' && !upstream.has(p[1])) {
        errors.push(`${where}: $from ${ref} references ${p[1]}, which is not an upstream dependency`);
      }
    } else {
      errors.push(`${where}: $from must start with "input." or "steps.<id>.output": ${ref}`);
    }
  };
  if (!cycle) {
    for (const s of steps) for (const ref of refsIn(s.input)) checkRef(`step ${s.id}`, ref, ancestors(s.id));
    for (const ref of refsIn(r.output)) checkRef('output', ref, 'all');
  }

  if (errors.length > 0) return { ok: false, errors };
  const last = topoOrder(steps).at(-1)!;
  return {
    ok: true,
    spec: {
      name: r.name as string,
      description: r.description as string,
      requiredInput,
      optionalInput,
      steps,
      output: r.output ?? { $from: `steps.${last}.output` },
    },
  };
};
