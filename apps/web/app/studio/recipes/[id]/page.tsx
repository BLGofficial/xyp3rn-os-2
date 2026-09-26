import { notFound } from 'next/navigation';
import { runtime, studioLoaders } from '../../../../lib/server';
import { ErrorBanner, Time } from '../../../ui';
import { RecipeForm, VersionTable } from '../../studio-ui';

export const dynamic = 'force-dynamic';

const Items = ({ items }: { items: readonly string[] | undefined }) =>
  items && items.length > 0 ? <ul className="list-inside list-disc">{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <span className="meta">none</span>;

export default async function Recipe({ params, searchParams }: { params: { id: string }; searchParams: Record<string, string | string[] | undefined> }) {
  const l = await (await studioLoaders()).studioLineage((await runtime()).sql, params.id);
  if (!l || l.kind !== 'recipe') notFound();
  const latest = l.versions.at(-1)!;
  const b = latest.body;
  const back = `/studio/recipes/${l.lineageId}`;
  return (
    <section>
      <h1>{b.name}</h1>
      <p className="meta mt-1">{l.schemaId} · lineage <code>{l.lineageId}</code> · approved: {l.approvedVersion ? `v${l.approvedVersion}` : 'none'}</p>
      <ErrorBanner error={searchParams.error} />

      <h2>Versions</h2>
      <VersionTable versions={l.versions} approvedVersion={l.approvedVersion} back={back} />

      <h2>v{latest.version}</h2>
      <div className="grid gap-4 text-sm md:grid-cols-2">
        <div className="md:col-span-2"><p className="meta">Style of Music (sent to Suno)</p><pre>{b.style}</pre></div>
        <div><p className="meta">Exclude styles (sent to Suno)</p><Items items={b.excludeStyles} /></div>
        <div><p className="meta">Mood</p><Items items={b.mood} /></div>
        <div><p className="meta">Production direction</p><Items items={b.production} /></div>
        <div><p className="meta">Tested notes</p><Items items={b.notes} /></div>
        {(b.sources ?? []).length > 0 && <div className="md:col-span-2 meta">Seeded from the model-written formula <code>{b.sources[0].artifactId}</code> v{b.sources[0].version}</div>}
        {latest.warnings.length > 0 && <div className="md:col-span-2 meta">Warnings: {latest.warnings.map((w) => w.message).join('; ')}</div>}
      </div>

      <h2>Edit (writes v{latest.version + 1}, a draft)</h2>
      <RecipeForm back={back} parentId={latest.id} current={b} />

      <h2>Packages built from it</h2>
      <table>
        <thead><tr><th>Package</th><th>Version used</th><th>Song</th><th>Built</th></tr></thead>
        <tbody>
          {l.packages.map((p) => (
            <tr key={p.packageId}>
              <td><a href={`/studio/packages/${p.packageId}`}>{p.title}</a></td><td>v{p.version}</td>
              <td>{p.song ? <a href={`/songs/${p.song.id}`}>{p.song.title}</a> : <span className="meta">no song</span>}</td>
              <td className="meta"><Time at={p.createdAt} /></td>
            </tr>
          ))}
          {l.packages.length === 0 && <tr><td colSpan={4} className="meta">none yet</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
