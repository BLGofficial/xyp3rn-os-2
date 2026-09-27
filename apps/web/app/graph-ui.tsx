import type { Domain } from '../../../core/contracts/taxonomy.ts';
import { DOMAIN_STYLE } from './shell/domains';
import { Icon } from './shell/icons';
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

const Why = ({ c }: { c: Conn }) => (
  <details>
    <summary>{c.verification === 'earlier-revision' ? <span className="status-warning">Earlier revision</span> : 'Why connected?'}</summary>
    <p className="meta mt-1">
      {c.origin === 'index' ? 'Declared in ' : 'Recorded in '}<code className="break-all">{c.provenance}</code>
      {c.revision ? <> at revision <code>{c.revision.slice(0, 12)}…</code></> : null}
    </p>
    {c.detail ? <p className="quote mt-1">{c.detail}</p> : null}
    {c.note ? <p className="meta mt-1">{c.note}</p> : null}
  </details>
);

/** The rail's narrow form of Connections: one item per connection, its proof folded underneath. */
export const ConnectionList = ({ label, connections, limit, more }: { label: string; connections: readonly Conn[]; limit?: number; more?: string }) => (
  <ul aria-label={label} className="mt-1 flex flex-col divide-y divide-line">
    {(limit ? connections.slice(0, limit) : connections).map((c) => (
      <li key={`${c.direction}:${c.id}`} className="py-2 text-sm">
        <span className="meta">{relationWord(c)}</span>{' '}
        <NodeLink node={c.other} /> <DomainChip domain={c.other.ownerDomain} />
        <Why c={c} />
      </li>
    ))}
    {connections.length === 0 && <li className="meta py-2">none</li>}
    {limit && connections.length > limit && <li className="meta py-2">{connections.length - limit} more: {more ? <a href={more}>see them all</a> : 'open the full detail'}</li>}
  </ul>
);

/** Every connection with its proof: the row or file line, the revision, and what the edge carries (a quote, a specifier). */
export const Connections = ({ label, connections, limit, more }: { label: string; connections: readonly Conn[]; limit?: number; more?: string }) => (
  <ScrollTable label={label}>
    <thead><tr><th>Relation</th><th>Connected to</th><th>Why connected?</th></tr></thead>
    <tbody>
      {(limit ? connections.slice(0, limit) : connections).map((c) => (
        <tr key={`${c.direction}:${c.id}`}>
          <td>{relationWord(c)}</td>
          <td><NodeLink node={c.other} /> <DomainChip domain={c.other.ownerDomain} /></td>
          <td><Why c={c} /></td>
        </tr>
      ))}
      {connections.length === 0 && <tr><td colSpan={3} className="meta">none</td></tr>}
      {limit && connections.length > limit && <tr><td colSpan={3} className="meta">{connections.length - limit} more: {more ? <a href={more}>see them all</a> : 'open the full detail'}</td></tr>}
    </tbody>
  </ScrollTable>
);


const OWNERSHIP_WORD: Readonly<Record<string, string>> = {
  frontmatter: 'registered (agent frontmatter)', manifest: 'registered (module manifest)', 'domain-path': 'by its domain directory',
  shared: 'none (no registration or domain directory)', taxonomy: 'the taxonomy', record: 'recorded on the row', 'owner-table': 'the table\'s owning domain',
};

type Detail = {
  readonly node: Node & { readonly ownershipBasis: string; readonly sourceRef: string; readonly revision: string | null; readonly asOf: string };
  readonly outgoing: readonly Conn[]; readonly incoming: readonly Conn[];
  readonly inherited: readonly { readonly label: string; readonly brief: Node; readonly targetId: string; readonly target: Node | null }[];
  readonly history: readonly { readonly linkTable: string; readonly linkId: string; readonly toId: string; readonly fromId: string; readonly reason: string; readonly linkedAt: string; readonly retractedAt: string }[];
  readonly diagnostics: readonly { readonly id: string; readonly problem: string; readonly relation: string; readonly detail: string | null; readonly sourceRef: string }[];
};

/**
 * The inspector (§16): what the node is, where it comes from, and every connection with its proof. In the right
 * rail on Command (`limit` caps the lists there) and full width on /node.
 */
export const Inspector = ({ d, limit, headingLevel = 2 }: { d: Detail; limit?: number; headingLevel?: 1 | 2 }) => {
  const n = d.node;
  const full = `/node?id=${encodeURIComponent(n.id)}`;
  const H = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <section className="card" aria-labelledby="inspector-h" data-inspector={n.id}>
      <p className="meta">{kindWord(n.kind)} · {BACKING_WORD[n.backing] ?? n.backing}</p>
      <H id="inspector-h" className="mt-1 break-words font-display text-[20px] font-semibold normal-case tracking-normal text-ink-1">{n.title}</H>
      <p className="mt-2 flex flex-wrap items-center gap-2"><Availability value={n.availability} /> <DomainChip domain={n.ownerDomain} /> <span className="meta">ownership: {OWNERSHIP_WORD[n.ownershipBasis] ?? n.ownershipBasis}</span></p>
      <dl className="mt-3 grid gap-1 text-sm">
        <div><dt className="meta inline">Source </dt><dd className="inline"><code className="break-all">{n.sourceRef}</code></dd></div>
        <div><dt className="meta inline">Revision </dt><dd className="inline">{n.revision ? <code title={n.revision}>{n.revision.length > 16 ? `${n.revision.slice(0, 12)}…` : n.revision}</code> : '—'}</dd></div>
        <div><dt className="meta inline">As of </dt><dd className="inline"><Time at={n.asOf} /></dd></div>
      </dl>
      <p className="mt-3 flex flex-wrap gap-3 text-sm">
        <a href={n.href}>Open source</a>
        {headingLevel === 2 ? <a href={full}>Full detail</a> : <a href={`/?node=${encodeURIComponent(n.id)}`}>Back to graph</a>}
      </p>
      <h3 className="mt-4 text-sm font-semibold">Connections out ({d.outgoing.length})</h3>
      {limit
        ? <ConnectionList label={`Connections from ${n.title}`} connections={d.outgoing} limit={limit} more={full} />
        : <Connections label={`Connections from ${n.title}`} connections={d.outgoing} />}
      <h3 className="mt-4 text-sm font-semibold">Connections in ({d.incoming.length})</h3>
      {limit
        ? <ConnectionList label={`Connections to ${n.title}`} connections={d.incoming} limit={limit} more={full} />
        : <Connections label={`Connections to ${n.title}`} connections={d.incoming} />}
      {d.inherited.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold">Inherited from brief</h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {d.inherited.map((i) => (
              <li key={i.targetId}>{i.target ? <NodeLink node={i.target} /> : <code>{i.targetId}</code>} <span className="meta">{i.label}: <a href={i.brief.href}>{i.brief.title}</a></span></li>
            ))}
          </ul>
        </>
      )}
      {d.history.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold">Unlinked (history)</h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {d.history.map((h) => (
              <li key={h.linkId}><code className="break-all">{h.fromId === n.id ? h.toId : h.fromId}</code> <span className="meta">linked <Time at={h.linkedAt} />, unlinked <Time at={h.retractedAt} />: {h.reason}</span></li>
            ))}
          </ul>
        </>
      )}
      {d.diagnostics.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold">Diagnostics</h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {d.diagnostics.map((x) => (
              <li key={x.id}><span className="status-warning">{x.problem}</span> {x.relation} <code className="break-all">{x.detail}</code> <span className="meta">at {x.sourceRef}</span></li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};

/**
 * The graph as a list (the sphere's accessible equivalent): each row inspects on Command and opens its source.
 * Below 960 px it is a stacked list whose items open the full-page detail (the rail would sit below the page).
 */
export const GraphList = ({ nodes, inspect }: { nodes: readonly Node[]; inspect: (id: string) => string }) => (
  <>
    <ul aria-label="Graph entities (compact)" className="flex flex-col divide-y divide-line md:hidden">
      {nodes.map((n) => (
        <li key={n.id} className="py-2">
          <a href={`/node?id=${encodeURIComponent(n.id)}`} className="break-words">{n.title}</a>
          <div className="meta mt-1 flex flex-wrap items-center gap-2">
            <span>{kindWord(n.kind)} · {BACKING_WORD[n.backing] ?? n.backing}</span> <DomainChip domain={n.ownerDomain} /> <Availability value={n.availability} />
            <a href={n.href}>Open</a>
          </div>
        </li>
      ))}
      {nodes.length === 0 && <li className="meta py-2">no entity matches this filter</li>}
    </ul>
    <div className="hidden md:block"><GraphTable nodes={nodes} inspect={inspect} /></div>
  </>
);

const GraphTable = ({ nodes, inspect }: { nodes: readonly Node[]; inspect: (id: string) => string }) => (
  <ScrollTable label="Graph entities">
    <thead><tr><th>Kind</th><th>Title</th><th>Domain</th><th>Backing</th><th>Availability</th><th /></tr></thead>
    <tbody>
      {nodes.map((n) => (
        <tr key={n.id}>
          <td className="meta">{kindWord(n.kind)}</td>
          <td className="break-all"><a href={inspect(n.id)} aria-label={`Inspect ${n.title}`}>{n.title}</a></td>
          <td><DomainChip domain={n.ownerDomain} /></td>
          <td>{BACKING_WORD[n.backing] ?? n.backing}</td>
          <td><Availability value={n.availability} /></td>
          <td><a href={n.href} className="text-sm" aria-label={`Open ${n.title}`}>Open</a></td>
        </tr>
      ))}
      {nodes.length === 0 && <tr><td colSpan={6} className="meta">no entity matches this filter</td></tr>}
    </tbody>
  </ScrollTable>
);

export const Pager = ({ page, perPage, total, at }: { page: number; perPage: number; total: number; at: (page: number) => string }) => {
  const pages = Math.max(1, Math.ceil(total / perPage));
  return (
    <nav aria-label="Graph pages" className="mt-2 flex flex-wrap items-center gap-3 text-sm">
      {page > 1 ? <a href={at(page - 1)}>← Previous</a> : <span className="meta">← Previous</span>}
      <span className="meta">page {page} of {pages} · {total} entities</span>
      {page < pages ? <a href={at(page + 1)}>Next →</a> : <span className="meta">Next →</span>}
    </nav>
  );
};

export const LENS_HINT = 'The same entities as the System lens, grouped for the X3LIUS Music System. A group counts real members only.';
