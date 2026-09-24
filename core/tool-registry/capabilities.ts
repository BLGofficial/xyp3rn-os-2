import type { AgentClass } from '../contracts/taxonomy.ts';

/**
 * Enforced copy of the capability matrix in docs/AGENT_CLASSES.md (the prose contract).
 * tests/phase-04c fails if the two drift. A capability added by a later phase is added to
 * both in that phase — never granted implicitly.
 */
export const CAPABILITIES = [
  'context.read',
  'log.write',
  'research.write',
  'candidate.propose',
  'plan.write',
  'artifact.write',
  'critique.write',
  'external.execute',
  'governance.flag',
  'canonical.write',
  'approval.decide',
  'audit.write',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL: readonly AgentClass[] = ['Research', 'Knowledge', 'Planning', 'Creative', 'Critic', 'Revision', 'Execution', 'Governance'];

export const CLASS_CAPABILITIES: Readonly<Record<Capability, readonly AgentClass[]>> = {
  'context.read': ALL,
  'log.write': ALL,
  'research.write': ['Research'],
  'candidate.propose': ['Research'],
  'plan.write': ['Planning'],
  'artifact.write': ['Creative', 'Revision'],
  'critique.write': ['Critic'],
  'external.execute': ['Execution'],
  'governance.flag': ['Governance'],
  // No agent class, ever: the Promotion Gate's service account, humans with an RBAC role, and
  // DB triggers respectively. Registering a tool with one of these makes it unreachable.
  'canonical.write': [],
  'approval.decide': [],
  'audit.write': [],
};

/**
 * @param value - candidate capability id
 * @returns true when value is a declared capability
 */
export const isCapability = (value: unknown): value is Capability =>
  typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
