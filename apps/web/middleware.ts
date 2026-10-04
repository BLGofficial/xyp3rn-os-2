import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, tokenProblem, verifySession } from './lib/session';

// AOS-01 §9: nothing but /login is served without a valid session; without a usable
// XYP_WEB_TOKEN nothing is served at all.
export async function middleware(req: NextRequest) {
  const token = process.env.XYP_WEB_TOKEN;
  const problem = tokenProblem(token);
  if (problem) return new NextResponse(problem, { status: 503, headers: { 'content-type': 'text/plain' } });
  if (req.nextUrl.pathname === '/login') return NextResponse.next();
  if (await verifySession(token!, req.cookies.get(SESSION_COOKIE)?.value, Date.now())) {
    // Reject malformed opaque IDs before the app shell streams a 200 response.
    const filePath = req.nextUrl.pathname;
    if (filePath.startsWith('/index/files/') &&
        !/^\/index\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/raw)?\/?$/i.test(filePath)) {
      return new NextResponse('Not found', { status: 404 });
    }
    return NextResponse.next();
  }
  if (req.method !== 'GET') return new NextResponse('session required', { status: 401 });
  // Not a redirect: Next rewrites an absolute Location to localhost (and refuses a relative one), and
  // switching host would lose the session cookie, which belongs to the host it was set on. A
  // relative meta refresh keeps the browser on the host it used.
  const login = `/login?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return new NextResponse(`<!doctype html><meta http-equiv="refresh" content="0;url=${login}"><a href="${login}">Log in</a>`, {
    status: 401, headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest).*)'] };
