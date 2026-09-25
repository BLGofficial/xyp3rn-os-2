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
  'research.read',
  'candidate.propose',
  'plan.write',
  'artifact.write',
  'artifact.read',
  'critique.write',
  'critique.read',
  'catalog.read',
  'catalog.write',
  'trace.write',
  'vault.write',
  'vault.read',
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
  // Phase 6C: fetch external material and register it as a research source.
  'web.read': ['Research'],
  'research.write': ['Research'],
  // Phase 14: read research evidence and its sources. The R&D backlog (Planning) reads the Frontier
  // Scanner's output; it can't write research (research.write stays Research's alone).
  'research.read': ['Planning'],
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
  // Phase 13 (Records ops): the catalog lookup (Knowledge) resolves a take's chain and a release; the
  // Rights check (Governance) reads splits. Governance's Phase 15 rights-conflict reads the same.
  'catalog.read': ['Knowledge', 'Governance'],
  // Phase 13: register releases/tracks, write split sets, assign ISRC/UPC, move the calendar. Execution
  // only: the operation is fully specified by its input; each tool writes under its own DB role.
  'catalog.write': ['Execution'],
  // Phase 14: record a TRACE analysis as received and link its mix report, once (tech-audio-tools).
  'trace.write': ['Execution'],
  // AOS-01 (A2): the owner's Creative Vault writes, through deterministic Execution agents
  // (vault-curator: files and tags; records-songs: songs and links), each as xyp_vault.
  'vault.write': ['Execution'],
  // AOS-01: a Vault file's metadata, tags and text. The lyric editor (Creative) reads a sheet to import it.
  'vault.read': ['Knowledge', 'Creative', 'Execution'],
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
