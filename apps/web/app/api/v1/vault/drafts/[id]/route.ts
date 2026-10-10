import { runtime } from '../../../../../../lib/server';
import { getDraft } from '../../../../../../server/vault-drafts';

export const dynamic = 'force-dynamic';

// One staged note with its markdown, for the explorer's drawer. The middleware has already required the owner session.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const draft = await getDraft((await runtime()).sql, (await params).id);
    return draft ? Response.json(draft, { headers: { 'cache-control': 'private, no-store' } }) : Response.json({ error: 'No such draft.' }, { status: 404 });
  } catch (e) {
    console.error('v1 vault draft failed:', e);
    return Response.json({ error: 'the server could not read the draft' }, { status: 500 });
  }
}
