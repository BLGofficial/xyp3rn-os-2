import { osImport } from '../lib/os';

export const dynamic = 'force-dynamic';

type Client = typeof import('../../../core/db/client.ts');

// Placeholder until the AOS-01 screens (docs/artist-os/AOS-01-design.md §9). Read-only. The spike
// that proved OS modules run natively from here (a read plus a real dispatch) is recorded in §9.
export default async function Page() {
  const { connect } = await osImport<Client>('core/db/client.ts');
  const sql = connect(undefined, { max: 1 });
  try {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from agent_runs`;
    return <pre>XYP3RN Artist OS — agent runs recorded: {row!.n}</pre>;
  } finally {
    await sql.end();
  }
}
