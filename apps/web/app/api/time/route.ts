// AOS-04 (design §19): the server's clock for the Sofia clock's offset estimate. Behind the session check
// (middleware.ts: no session, no answer). Never cached: a cached instant would be a wrong one.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ epochMs: Date.now() }, { headers: { 'cache-control': 'no-store' } });
}
