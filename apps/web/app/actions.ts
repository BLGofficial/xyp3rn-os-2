'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { attempt, back, opt, text } from './action-kit';
import { issueSession, SESSION_COOKIE, SESSION_MAX_AGE_S, tokenMatches, tokenProblem } from '../lib/session';
import { ops, runtime } from '../lib/server';

// The UI's writes (AOS-01 §9, A2). Each action re-checks the session (the middleware already did)
// and calls apps/web/server/ops.ts: an agent run through dispatch, or the owner's decision. A
// refusal comes back to the page as ?error=, never as a crash. The Command Center's writes (AOS-02)
// are in catalog-actions.ts.

export async function login(form: FormData) {
  const token = process.env.XYP_WEB_TOKEN;
  const next = text(form, 'next');
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/vault';
  if (tokenProblem(token) || !(await tokenMatches(token!, text(form, 'token')))) back(`/login?next=${encodeURIComponent(safeNext)}`, 'wrong token');
  cookies().set(SESSION_COOKIE, await issueSession(token!, Date.now()), {
    httpOnly: true, sameSite: 'strict', path: '/', maxAge: SESSION_MAX_AGE_S, secure: false,
  });
  redirect(safeNext);
}

export async function logout() {
  cookies().delete(SESSION_COOKIE);
  redirect('/login');
}

export async function upload(form: FormData) {
  const files = form.getAll('files').filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f && (f as File).size > 0);
  return attempt('/ingest', async () => {
    if (files.length === 0) throw new Error('choose at least one file');
    const uploads = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    const tags = text(form, 'tags').split(',').map((t) => t.trim()).filter(Boolean);
    const as = opt(form, 'as');
    const language = opt(form, 'language');
    const songId = opt(form, 'songId');
    return (await ops()).uploadFiles((await runtime()).deps, uploads, { ...(as ? { as } : {}), ...(language ? { language } : {}), ...(songId ? { songId } : {}), tags });
  }, (r) => {
    const lyrics = r.map((x) => x.lyrics).find((l) => l !== null);
    return lyrics ? `/vault/lineages/${lyrics.lineageId}` : r.length === 1 ? `/vault/files/${r[0]!.file.sourceId}` : '/ingest';
  });
}

export async function decideVersion(form: FormData) {
  const lineageId = text(form, 'lineageId');
  const decision = text(form, 'decision') === 'approve' ? 'approve' : 'reject';
  return attempt(`/vault/lineages/${lineageId}`, async () => {
    const rt = await runtime();
    return (await ops()).decide(rt.sql, text(form, 'artifactId'), decision, text(form, 'reason'), rt.owner);
  });
}

export async function editVersion(form: FormData) {
  const lineageId = text(form, 'lineageId');
  const language = opt(form, 'language');
  return attempt(`/vault/lineages/${lineageId}`, async () =>
    (await ops()).editLyrics((await runtime()).deps, { parentId: text(form, 'parentId'), text: String(form.get('text') ?? ''), ...(language ? { language } : {}) }));
}

const songFields = (form: FormData) =>
  Object.fromEntries((['title', 'artist', 'language', 'genre', 'status', 'notes'] as const).map((k) => [k, opt(form, k)]).filter(([, v]) => v !== undefined)) as Record<string, string>;

export async function createSong(form: FormData) {
  return attempt('/songs', async () => {
    const f = songFields(form);
    return (await ops()).songCreate((await runtime()).deps, { ...f, title: f.title ?? '', artist: f.artist ?? '' });
  }, (r) => `/songs/${r.songId}`);
}

export async function reviseSong(form: FormData) {
  const songId = text(form, 'songId');
  return attempt(`/songs/${songId}`, async () => (await ops()).songRevise((await runtime()).deps, { songId, ...songFields(form) }));
}

const LINK_KINDS: Readonly<Record<string, string>> = { artifact: 'artifactId', file: 'sourceId', take: 'takeId', track: 'trackId', question: 'researchQuestionId' };

export async function linkSong(form: FormData) {
  const songId = text(form, 'songId');
  return attempt(`/songs/${songId}`, async () => {
    const key = LINK_KINDS[text(form, 'kind')];
    if (!key) throw new Error('choose what to link');
    const role = opt(form, 'role');
    return (await ops()).songLink((await runtime()).deps, { songId, [key]: text(form, 'targetId'), ...(role ? { role } : {}) });
  });
}

export async function unlinkSong(form: FormData) {
  const songId = text(form, 'songId');
  return attempt(`/songs/${songId}`, async () => (await ops()).songUnlink((await runtime()).deps, { linkId: text(form, 'linkId'), reason: text(form, 'reason') }));
}
