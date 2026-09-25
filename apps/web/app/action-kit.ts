import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, tokenProblem, verifySession } from '../lib/session.ts';

// Shared by the server action files (a 'use server' file may only export async actions): form reading,
// the session re-check, and the write wrapper that turns a refusal into ?error= on the page.

export const text = (f: FormData, k: string): string => String(f.get(k) ?? '').trim();
export const opt = (f: FormData, k: string): string | undefined => text(f, k) || undefined;
export const back = (path: string, error?: string): never =>
  redirect(error ? `${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(error)}` : path);

export const guard = async (): Promise<void> => {
  const token = process.env.XYP_WEB_TOKEN;
  if (tokenProblem(token) || !(await verifySession(token!, cookies().get(SESSION_COOKIE)?.value, Date.now()))) redirect('/login');
};

/** Runs a write; on failure returns to `path` with the refusal, on success to `done` (default `path`). */
export const attempt = async <T>(path: string, fn: () => Promise<T>, done?: (r: T) => string): Promise<never> => {
  await guard();
  let r: T;
  try {
    r = await fn();
  } catch (e) {
    return back(path, e instanceof Error ? e.message : String(e));
  }
  revalidatePath('/', 'layout');
  return back(done ? done(r) : path);
};

export { local } from '../lib/paths.ts';
