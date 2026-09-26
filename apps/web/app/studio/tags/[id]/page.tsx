import { notFound } from 'next/navigation';
import { researchLoaders, runtime, studioLoaders } from '../../../../lib/server';
import { ResearchSection } from '../../../research/research-ui';
import { ErrorBanner, Time } from '../../../ui';
import { TagSetForm, tagPreview, VersionTable } from '../../studio-ui';

export const dynamic = 'force-dynamic';

type Section = { kind: string; label: string; numbered: boolean; cues: string[] };

export default async function TagSet({ params, searchParams }: { params: { id: string }; searchParams: Record<string, string | string[] | undefined> }) {
  const sl = await studioLoaders();
  const l = await sl.studioLineage((await runtime()).sql, params.id);
  if (!l || l.kind !== 'tags') notFound();
  const research = await (await researchLoaders()).researchFor((await runtime()).sql, { lineageId: l.lineageId });
  const latest = l.versions.at(-1)!;
  const b = latest.body as { name: string; sections: Section[]; notes: string[] };
  const back = `/studio/tags/${l.lineageId}`;
  return (
    <section>
      <h1>{b.name}</h1>
      <p className="meta mt-1">{l.schemaId} · lineage <code>{l.lineageId}</code> · approved: {l.approvedVersion ? `v${l.approvedVersion}` : 'none'}</p>
      <ErrorBanner error={searchParams.error} />

      <h2>Versions</h2>
      <VersionTable versions={l.versions} approvedVersion={l.approvedVersion} back={back} />

      <h2>v{latest.version}</h2>
      <table>
        <thead><tr><th>Kind</th><th>Label</th><th>Numbered</th><th>Cues</th><th>What Suno sees</th></tr></thead>
        <tbody>
          {b.sections.map((s) => (
            <tr key={s.kind}><td>{s.kind}</td><td>{s.label}</td><td>{s.numbered ? 'yes' : 'no'}</td><td>{s.cues.join(', ') || <span className="meta">none</span>}</td><td><code>{tagPreview(s)}</code></td></tr>
          ))}
        </tbody>
      </table>
      {b.notes.length > 0 && <p className="meta mt-2">Notes: {b.notes.join(' · ')}</p>}

      <h2>Edit (writes v{latest.version + 1}, a draft)</h2>
      <TagSetForm back={back} kinds={sl.tagKinds()} parentId={latest.id} current={b} />

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

      <ResearchSection research={research} />
    </section>
  );
}
