import { researchLoaders, runtime } from '../../lib/server';
import { ErrorBanner, Status, Time, first } from '../ui';
import { BriefForm, TargetChips } from './research-ui';

export const dynamic = 'force-dynamic';

export default async function Research({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const rl = await researchLoaders();
  const rt = await runtime();
  const r = await rl.researchIndex(rt.sql, rt.deps.registry);
  const q = first(searchParams.q) ?? '';
  const preview = q ? rl.previewSelection(rt.deps.registry, q) : null;
  return (
    <section>
      <h1>Research</h1>
      <p className="meta mt-1">
        A brief asks a question for a stated use. The selected specialists read the brief&apos;s URLs and the canonical knowledge, and every claim quotes its source.
        Findings enter the <a href="/research/library">Findings Library</a> only when you accept them, and become canonical only when you approve their promotion. Read at <Time at={r.asOf} />.
      </p>
      <ErrorBanner error={searchParams.error} />

      <h2>Briefs</h2>
      <table>
        <thead><tr><th>Question</th><th>Intended use</th><th>Targets</th><th>Latest run</th><th>Opened</th></tr></thead>
        <tbody>
          {r.briefs.map((b) => (
            <tr key={b.questionId}>
              <td>{b.latestRun ? <a href={`/research/runs/${b.latestRun.id}`}>{b.question}</a> : b.question}</td>
              <td>{b.intendedUse ?? <span className="meta">not stated (before AOS-04)</span>}</td>
              <td><TargetChips targets={b.targets} /></td>
              <td>{b.latestRun ? <Status status={b.latestRun.status} /> : <span className="meta">none</span>}</td>
              <td className="meta"><Time at={b.createdAt} /></td>
            </tr>
          ))}
          {r.briefs.length === 0 && <tr><td colSpan={5} className="meta">no brief yet</td></tr>}
        </tbody>
      </table>

      <h2>New brief</h2>
      <form method="get" className="mt-2 flex flex-wrap items-end gap-2">
        <label className="field grow">Preview the specialists for a question <input name="q" defaultValue={q} className="w-full normal-case tracking-normal" /></label>
        <button type="submit">Preview</button>
      </form>
      {preview && (
        <p className="meta mt-2">
          Keyword selection (threshold {preview.threshold}): {preview.selected.length > 0 ? preview.selected.map((s) => `${s.name} (${s.score})`).join(', ') : 'nobody matches; tick your own picks below'}
        </p>
      )}
      <BriefForm question={q} preview={preview} specialists={r.specialists} workflows={r.workflows} decisions={r.decisions} songs={r.songs} lineages={r.lineages} />
    </section>
  );
}
