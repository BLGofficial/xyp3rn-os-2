import type { Domain } from '../../../../core/contracts/taxonomy.ts';
import type { IconName } from './icons';

// The six domains' presentation (AOS-04 design §14.2), shared by the rail's filters and the graph: the canonical
// hue as the rim, the bright variant as the label, and an icon, so a domain is never told apart by colour alone.
// Literal class names: Tailwind scans the source.
export const DOMAIN_STYLE: Readonly<Record<Domain | 'shared', { readonly label: string; readonly cls: string; readonly icon: IconName }>> = {
  CORE: { label: 'Core', cls: 'border-core text-core-label', icon: 'hexagon' },
  KNOWLEDGE: { label: 'Knowledge', cls: 'border-knowledge text-knowledge-label', icon: 'book' },
  RESEARCH_INTELLIGENCE: { label: 'Research Intelligence', cls: 'border-research text-research-label', icon: 'research' },
  RECORDS: { label: 'Records', cls: 'border-records text-records-label', icon: 'note' },
  TECH: { label: 'Tech', cls: 'border-tech text-tech-label', icon: 'circuit' },
  GOVERNANCE: { label: 'Governance', cls: 'border-governance text-governance-label', icon: 'shield' },
  shared: { label: 'Shared/Unassigned', cls: 'border-control text-ink-2', icon: 'shared' },
};

/** The filter order in the rail: the taxonomy's order, then Shared. */
export const DOMAIN_FILTERS = ['CORE', 'KNOWLEDGE', 'RESEARCH_INTELLIGENCE', 'RECORDS', 'TECH', 'GOVERNANCE', 'shared'] as const;
