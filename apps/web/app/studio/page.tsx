import { runtime, studioLoaders } from '../../lib/server';
import { defaultTagSetAction } from '../studio-actions';
import { ErrorBanner, ScrollTable, Time } from '../ui';
import { RecipeForm, TagSetForm } from './studio-ui';

export const dynamic = 'force-dynamic';

export default async function Studio({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const sl = await studioLoaders();
  const s = await sl.studioIndex((await runtime()).sql);
  return (
    <section>
      <h1>Studio</h1>
      <p className="meta mt-1">
        Style recipes and meta-tag sets are versioned; the owner approves each version. A Suno package is built from a song&apos;s page and
        handed off once its lyric, recipe and tag set versions are approved. Read at <Time at={s.asOf} />.
      </p>
      <ErrorBanner error={searchParams.error} />

      <h2>Style recipes</h2>
      <ScrollTable label="Style recipes">
        <thead><tr><th>Recipe</th><th>Latest</th><th>Approved</th><th>Packages</th><th>Updated</th></tr></thead>
        <tbody>
          {s.recipes.map((r) => (
            <tr key={r.lineageId}>
              <td><a href={`/studio/recipes/${r.lineageId}`}>{r.name}</a></td><td>v{r.latestVersion}</td>
              <td>{r.approvedVersion ? <span className="status-approved">v{r.approvedVersion}</span> : <span className="meta">none</span>}</td>
              <td>{r.packages}</td><td className="meta"><Time at={r.updatedAt} /></td>
            </tr>
          ))}
          {s.recipes.length === 0 && <tr><td colSpan={5} className="meta">no recipe yet</td></tr>}
        </tbody>
      </ScrollTable>
      <h2>New style recipe</h2>
      <RecipeForm back="/studio" />

      <h2>Meta-tag sets</h2>
      <ScrollTable label="Meta-tag sets">
        <thead><tr><th>Tag set</th><th>Latest</th><th>Approved</th><th>Packages</th><th>Updated</th></tr></thead>
        <tbody>
          {s.tagSets.map((t) => (
            <tr key={t.lineageId}>
              <td><a href={`/studio/tags/${t.lineageId}`}>{t.name}</a></td><td>v{t.latestVersion}</td>
              <td>{t.approvedVersion ? <span className="status-approved">v{t.approvedVersion}</span> : <span className="meta">none</span>}</td>
              <td>{t.packages}</td><td className="meta"><Time at={t.updatedAt} /></td>
            </tr>
          ))}
          {s.tagSets.length === 0 && <tr><td colSpan={5} className="meta">no tag set yet</td></tr>}
        </tbody>
      </ScrollTable>
      <form action={defaultTagSetAction} className="mt-2">
        <button type="submit">Create the default tag set (the code labels)</button>
      </form>
      <h2>New tag set</h2>
      <TagSetForm back="/studio" kinds={sl.tagKinds()} />

      <h2>Recent attempts</h2>
      <ScrollTable label="Recent attempts">
        <thead><tr><th>At</th><th>Song</th><th>Package</th><th>Model</th><th>Adapter</th><th>Takes</th><th>Traced</th></tr></thead>
        <tbody>
          {s.attempts.map((a) => (
            <tr key={a.submissionId}>
              <td className="meta"><Time at={a.createdAt} /></td>
              <td>{a.songId ? <a href={`/songs/${a.songId}`}>{a.songTitle}</a> : <span className="meta">no song</span>}</td>
              <td><a href={`/studio/packages/${a.packageId}`}>{a.title ?? a.packageId}</a></td>
              <td>{a.sunoModel}</td><td>{a.adapter}</td><td>{a.takeCount}</td>
              <td>{a.isTraced ? 'yes' : <span className="meta">no (before AOS-03)</span>}</td>
            </tr>
          ))}
          {s.attempts.length === 0 && <tr><td colSpan={7} className="meta">no attempt yet</td></tr>}
        </tbody>
      </ScrollTable>
    </section>
  );
}
