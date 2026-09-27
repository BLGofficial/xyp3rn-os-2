import type { Domain } from '../../../core/contracts/taxonomy.ts';
import { Icon, type IconName } from './shell/icons';
import { ScrollTable, Time } from './ui';

// The graph's shared pieces (AOS-04 Plan C1, design §13–16): domain chips (colour + label + icon, never colour
// alone), node links with their kind and backing, and the connections table whose every row says why it exists.
// Server components.

type Node = {
  readonly id: string; readonly kind: string; readonly title: string; readonly ownerDomain: Domain | null; readonly backing: string;
  readonly availability: string; readonly href: string;
};
type Conn = {
  readonly id: string; readonly relation: string; readonly direction: 'out' | 'in'; readonly other: Node; readonly provenance: string;
  readonly revision: string | null; readonly detail: string | null; readonly origin: string; readonly verification: string; readonly note: string | null;
};

/** Literal class names (Tailwind scans source): canonical hue for the rim, the bright variant for the label. */
export const DOMAIN_STYLE: Readonly<Record<Domain | 'shared', { readonly label: string; readonly cls: string; readonly icon: IconName }>> = {
  CORE: { label: 'Core', cls: 'border-core text-core-label', icon: 'hexagon' },
  KNOWLEDGE: { label: 'Knowledge', cls: 'border-knowledge text-knowledge-label', icon: 'book' },
  RESEARCH_INTELLIGENCE: { label: 'Research Intelligence', cls: 'border-research text-research-label', icon: 'research' },
  RECORDS: { label: 'Records', cls: 'border-records text-records-label', icon: 'note' },
  TECH: { label: 'Tech', cls: 'border-tech text-tech-label', icon: 'circuit' },
  GOVERNANCE: { label: 'Governance', cls: 'border-governance text-governance-label', icon: 'shield' },
  shared: { label: 'Shared/Unassigned', cls: 'border-control text-ink-2', icon: 'shared' },
};

export const DomainChip = ({ domain }: { domain: Domain | null }) => {
  const s = DOMAIN_STYLE[domain ?? 'shared'];
  return <span className={`tag inline-flex items-center gap-1 border ${s.cls}`}><Icon name={s.icon} className="h-3.5 w-3.5" />{s.label}</span>;
};

/** Record vs File vs Configuration, as §15.2 words them. */
export const BACKING_WORD: Readonly<Record<string, string>> = { file: 'File', record: 'Record', configuration: 'Configuration' };

const AVAILABILITY: Readonly<Record<string, { word: string; cls: string }>> = {
  present: { word: 'Present', cls: 'status-success' },
  missing: { word: 'Missing', cls: 'status-failed' },
  unavailable: { word: 'Unavailable', cls: 'status-failed' },
  unchecked: { word: 'Not yet checked', cls: 'status-none' },
  stale: { word: 'Stale', cls: 'status-warning' },
};
export const Availability = ({ value }: { value: string }) => {
  const a = AVAILABILITY[value] ?? { word: value, cls: 'status-none' };
  return <span className={a.cls}>{a.word}</span>;
};

export const kindWord = (kind: string) => kind.replace(/_/g, ' ');

export const NodeLink = ({ node }: { node: Node }) => (
  <span className="inline-flex flex-wrap items-baseline gap-x-2">
    <a href={node.href} className="break-all">{node.title}</a>
    <span className="meta">{kindWord(node.kind)} · {BACKING_WORD[node.backing] ?? node.backing}</span>
  </span>
);

const RELATION_OUT: Readonly<Record<string, string>> = {
  owned_by: 'owned by', defined_by: 'defined by', part_of: 'part of', step_uses_agent: 'step uses agent', depends_on: 'depends on',
  imports: 'imports', references: 'links to', linked_to: 'linked to', run_of: 'run of', produced_by: 'produced by', version_of: 'version of',
  supported_by: 'supported by', quotes: 'quotes', derived_from: 'derived from', proposed_as: 'proposed as', approved_by: 'approval',
  promoted_to: 'promoted to', decides: 'decides', subdomain_of: 'sub-domain of', precedes: 'precedes',
};
const RELATION_IN: Readonly<Record<string, string>> = {
  owned_by: 'owns', defined_by: 'defines', part_of: 'has part', step_uses_agent: 'used by step', depends_on: 'needed by',
  imports: 'imported by', references: 'linked from', linked_to: 'linked from', run_of: 'has run', produced_by: 'produced',
  version_of: 'has version', supported_by: 'supports', quotes: 'quoted by', derived_from: 'source of', proposed_as: 'proposed from',
  approved_by: 'approval of', promoted_to: 'promoted from', decides: 'decided by', subdomain_of: 'has sub-domain', precedes: 'follows',
};
export const relationWord = (c: { relation: string; direction: 'out' | 'in' }) =>
  (c.direction === 'out' ? RELATION_OUT : RELATION_IN)[c.relation] ?? `${c.relation}${c.direction === 'in' ? ' (incoming)' : ''}`;

/** Every connection with its proof: the row or file line, the revision, and what the edge carries (a quote, a specifier). */
export const Connections = ({ label, connections }: { label: string; connections: readonly Conn[] }) => (
  <ScrollTable label={label}>
    <thead><tr><th>Relation</th><th>Connected to</th><th>Why connected?</th></tr></thead>
    <tbody>
      {connections.map((c) => (
        <tr key={`${c.direction}:${c.id}`}>
          <td>{relationWord(c)}</td>
          <td><NodeLink node={c.other} /> <DomainChip domain={c.other.ownerDomain} /></td>
          <td>
            <details>
              <summary>{c.verification === 'earlier-revision' ? <span className="status-warning">Earlier revision</span> : 'Why connected?'}</summary>
              <p className="meta mt-1">
                {c.origin === 'index' ? 'Declared in ' : 'Recorded in '}<code className="break-all">{c.provenance}</code>
                {c.revision ? <> at revision <code>{c.revision.slice(0, 12)}…</code></> : null}
              </p>
              {c.detail ? <p className="quote mt-1">{c.detail}</p> : null}
              {c.note ? <p className="meta mt-1">{c.note}</p> : null}
            </details>
          </td>
        </tr>
      ))}
      {connections.length === 0 && <tr><td colSpan={3} className="meta">none</td></tr>}
    </tbody>
  </ScrollTable>
);

export { Time };
