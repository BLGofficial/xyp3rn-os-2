import { graphLoaders, runtime } from '../../lib/server';
import { DomainChip, kindWord } from '../graph-ui';
import { first, Time } from '../ui';

export const dynamic = 'force-dynamic';

// Search everything (AOS-04 design §16): every entity in the index whose title or path contains the words,
// grouped by type. A result focuses its neighbourhood on the graph; "Open" goes to its own page.
export default async function Search({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const q = first(searchParams.q) ?? '';
  const r = q.trim() ? await (await graphLoaders()).search((await runtime()).sql, q) : null;
  return (
    <section>
      <h1>Search everything</h1>
      <form action="/search" method="get" role="search" className="mt-3 flex flex-wrap items-end gap-2">
        <label className="field min-w-0 flex-1">Words to find in titles and paths <input name="q" type="search" defaultValue={q} className="w-full" /></label>
        <button type="submit">Search</button>
      </form>
      {r === null && <p className="meta mt-3">Searches the whole index: files, songs, lineages, agents, workflows, decisions, research and runs.</p>}
      {r && r.groups.length === 0 && <p className="mt-4" data-search-empty>No entity in the index matches “{q}”.</p>}
      {r && r.groups.length > 0 && <p className="meta mt-3">Read at <Time at={r.asOf} />.</p>}
      {r?.groups.map((g) => (
        <section key={g.kind} aria-labelledby={`g-${g.kind}`} data-search-group={g.kind}>
          <h2 id={`g-${g.kind}`}>{g.label} <span className="meta normal-case tracking-normal">{g.hits.length < g.total ? `showing ${g.hits.length} of ${g.total}` : `${g.total}`}</span></h2>
          <ul className="flex flex-col gap-2">
            {g.hits.map((h) => (
              <li key={h.id} className="card p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <a href={h.href} className="break-all">{h.title}</a>
                  <a href={h.destination} className="text-sm">Open</a>
                </div>
                <div className="meta mt-1 flex flex-wrap items-center gap-2">
                  <span>{kindWord(h.kind)}</span> <DomainChip domain={h.domain} />
                  {h.path && <code className="break-all">{h.path}</code>}
                  {h.revision && <code title={h.revision}>{h.revision.length > 16 ? `${h.revision.slice(0, 12)}…` : h.revision}</code>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
