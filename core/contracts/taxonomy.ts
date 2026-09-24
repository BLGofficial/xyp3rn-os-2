/**
 * XYP3RN Agentic OS — domain + agent-class taxonomy (Phase 0 contract).
 *
 * Single source of truth. The Agent Registry validator (Phase 4B) rejects any
 * class/domain not listed here, and the Graph View (Phase 16A) imports
 * DOMAIN_META colors from here — never redefine either elsewhere.
 * Changing this file is a contract change: update docs/ARCHITECTURE.md and
 * docs/AGENT_CLASSES.md in the same commit (tests/phase-00 enforces it).
 */

/** The six top-level domains, in the order the architecture doc lists them. */
export const DOMAINS = [
  'CORE',
  'KNOWLEDGE',
  'RESEARCH_INTELLIGENCE',
  'RECORDS',
  'TECH',
  'GOVERNANCE',
] as const;

export type Domain = (typeof DOMAINS)[number];

export type DomainMeta = {
  /** Human label shown in docs and UI. */
  readonly label: string;
  /** Top-level repo directory that holds this domain's code. */
  readonly dir: string;
  /** Graph View node color (hex). Distinct per domain so the legend is unambiguous. */
  readonly color: string;
};

export const DOMAIN_META: Readonly<Record<Domain, DomainMeta>> = {
  CORE: { label: 'Core', dir: 'core', color: '#22d3ee' },
  KNOWLEDGE: { label: 'Knowledge Layer', dir: 'knowledge', color: '#a78bfa' },
  RESEARCH_INTELLIGENCE: {
    label: 'Research Intelligence',
    dir: 'research-intelligence',
    color: '#f59e0b',
  },
  RECORDS: { label: 'XYP3RN Records', dir: 'records', color: '#ef4444' },
  TECH: { label: 'XYP3RN Tech', dir: 'tech', color: '#10b981' },
  GOVERNANCE: { label: 'Governance', dir: 'governance', color: '#94a3b8' },
};

/** The eight agent classes. Every agent declares exactly one (see docs/AGENT_CLASSES.md). */
export const AGENT_CLASSES = [
  'Research',
  'Knowledge',
  'Planning',
  'Creative',
  'Critic',
  'Revision',
  'Execution',
  'Governance',
] as const;

export type AgentClass = (typeof AGENT_CLASSES)[number];

/**
 * Narrows an arbitrary string to a Domain.
 * @param value - candidate domain id, e.g. from agent frontmatter
 * @returns true when value is one of DOMAINS
 */
export const isDomain = (value: unknown): value is Domain =>
  typeof value === 'string' && (DOMAINS as readonly string[]).includes(value);

/**
 * Narrows an arbitrary string to an AgentClass.
 * @param value - candidate class name, e.g. from agent frontmatter
 * @returns true when value is one of AGENT_CLASSES
 */
export const isAgentClass = (value: unknown): value is AgentClass =>
  typeof value === 'string' && (AGENT_CLASSES as readonly string[]).includes(value);
