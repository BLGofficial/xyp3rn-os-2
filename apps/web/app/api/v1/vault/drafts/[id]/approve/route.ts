import { runtime } from '../../../../../../../lib/server';
import { queueDraft, UUID } from '../../../../../../../server/vault-drafts';

// "Approve to Promotion Gate": queues the note for the operator's decision; it writes no canonical knowledge. Same-origin
// only (as /api/jarvis/start): another site must not be able to queue notes on the owner's behalf.
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  let sameOrigin = false;
  try { sameOrigin = new URL(request.headers.get('origin') ?? '').host === request.headers.get('host'); } catch { /* refuse */ }
  if (!sameOrigin) return json({ error: 'Same-origin request required.' }, 403);
  const { id } = await params;
  if (!UUID.test(id)) return json({ error: 'No such draft.' }, 404);
  try {
    const rt = await runtime();
    const approvalId = await queueDraft(rt.sql, id, rt.owner, 'owner approved this note from the /vault explorer');
    return json({ approvalId, status: 'queued' });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '23505') return json({ error: 'This note is already in the gate queue.' }, 409);
    if (code === '55000') return json({ error: 'This note is no longer pending approval.' }, 409);
    if (code === '23503') return json({ error: 'No such draft.' }, 404);
    console.error('v1 vault approve failed:', e);
    return json({ error: 'the server could not queue the draft' }, 500);
  }
}
