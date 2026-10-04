import { notFound } from 'next/navigation';
import { graphLoaders, runtime } from '../../lib/server';
import { Inspector } from '../graph-ui';
import { first } from '../ui';

export const dynamic = 'force-dynamic';

// A graph entity's full detail (AOS-04 design §13.1: wider inspection opens a full page with a return-to-graph
// action): the inspector at full width, every connection listed.
export default async function Node({ searchParams: pendingSearchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await pendingSearchParams;
  const id = first(searchParams.id);
  if (!id) notFound();
  const d = await (await graphLoaders()).nodeDetail((await runtime()).sql, id);
  if (!d) notFound();
  return <Inspector d={d} headingLevel={1} />;
}
