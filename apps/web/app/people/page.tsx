import { catalogLoaders, runtime } from '../../lib/server';
import { aliasAction, personAction } from '../catalog-actions';
import { ErrorBanner, ScrollTable, Time } from '../ui';

export const dynamic = 'force-dynamic';

// People and their aliases (AOS-02 B1): one case-insensitive namespace, so a credit can name anyone by
// any of their names. Names are never edited in place (F39); a wrong one is a new alias.
export default async function People({ searchParams: pendingSearchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await pendingSearchParams;
  const people = await (await catalogLoaders()).peopleList((await runtime()).sql);
  return (
    <section>
      <h1>People</h1>
      <ErrorBanner error={searchParams.error} />
      <ScrollTable label="People" className="mt-4">
        <thead><tr><th>Name</th><th>Aliases</th><th>Live credits</th><th>Added</th><th /></tr></thead>
        <tbody>{people.map((p) => (
          <tr key={p.id}>
            <td>{p.name}</td><td>{p.aliases.join(', ') || <span className="meta">none</span>}</td><td>{p.credits}</td><td className="meta"><Time at={p.createdAt} /></td>
            <td>
              <form action={aliasAction} className="flex gap-1">
                <input type="hidden" name="personId" value={p.id} />
                <input name="alias" required size={12} placeholder="alias" aria-label={`alias for ${p.name}`} />
                <button className="btn-quiet">Add alias</button>
              </form>
            </td>
          </tr>
        ))}</tbody>
      </ScrollTable>
      {people.length === 0 && <p className="meta">no people yet</p>}

      <h2>Add a person</h2>
      <form action={personAction} className="flex flex-wrap items-end gap-3">
        <label className="field">Name<input name="name" required /></label>
        <button type="submit">Add</button>
      </form>
    </section>
  );
}
