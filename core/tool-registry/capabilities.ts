import type { AgentClass } from '../contracts/taxonomy.ts';

/**
 * Enforced copy of the capability matrix in docs/AGENT_CLASSES.md (the prose contract).
 * tests/phase-04c fails if the two drift. A capability added by a later phase is added to
 * both in that phase — never granted implicitly.
 */
export const CAPABILITIES = [
  'context.read',
  'log.write',
  'web.read',
  'research.write',
  'candidate.propose',
  'plan.write',
  'artifact.write',
  'artifact.read',
  'critique.write',
  'critique.read',
  'external.execute',
  'governance.flag',
  'records.read',
  'catalog.write',
  'schedule.propose',
  'canonical.write',
  'approval.decide',
  'audit.write',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL: readonly AgentClass[] = ['Research', 'Knowledge', 'Planning', 'Creative', 'Critic', 'Revision', 'Execution', 'Governance'];

export const CLASS_CAPABILITIES: Readonly<Record<Capability, readonly AgentClass[]>> = {
  'context.read': ALL,
  'log.write': ALL,
  // Phase 6C: fetch external material and register it as a research source.
  'web.read': ['Research'],
  'research.write': ['Research'],
  'candidate.propose': ['Research'],
  'plan.write': ['Planning'],
  'artifact.write': ['Creative', 'Revision'],
  // Phase 9: read a creative artifact version by id (the formula reads Phase 8 artifacts; the
  // Critic, Revision and the submitter read the version they act on; Governance audits).
  'artifact.read': ['Creative', 'Critic', 'Revision', 'Execution', 'Governance'],
  'critique.write': ['Critic'],
  // Phase 12: read a critique by id (Revision reads the one it answers; the Critic reads the previous
  // one to mark what is resolved; Governance audits).
  'critique.read': ['Critic', 'Revision', 'Governance'],
  'external.execute': ['Execution'],
  'governance.flag': ['Governance'],
  // Phase 13: Records ops (catalog, rights splits, release calendar). Splits themselves are the
  // operator's (service_role); no agent class writes them.
  'records.read': ['Planning', 'Execution', 'Governance'],
  'catalog.write': ['Execution'],
  'schedule.propose': ['Execution'],
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
