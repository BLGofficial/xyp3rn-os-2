import { describe, expect, it } from 'vitest';
import { issueSession, SESSION_MAX_AGE_S, tokenMatches, tokenProblem, verifySession } from './session.ts';

// AOS-01 §9: the UI is local and single-owner. The first visit asks for XYP_WEB_TOKEN; a correct
// token gets an HMAC-signed session cookie that the middleware checks on every other route.

const TOKEN = 'correct-horse-battery-staple-42';
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

describe('web session', () => {
  it('the app refuses to run without a token of at least 16 characters', () => {
    expect(tokenProblem(undefined)).toMatch(/XYP_WEB_TOKEN is not set/);
    expect(tokenProblem('short-token')).toMatch(/at least 16/);
    expect(tokenProblem(TOKEN)).toBeNull();
  });

  it('a session issued under the token verifies until it expires', async () => {
    const cookie = await issueSession(TOKEN, NOW);
    expect(cookie).toMatch(/^v1\.\d+\.[0-9a-f]{64}$/);
    expect(await verifySession(TOKEN, cookie, NOW)).toBe(true);
    expect(await verifySession(TOKEN, cookie, NOW + (SESSION_MAX_AGE_S - 1) * 1000)).toBe(true);
    expect(await verifySession(TOKEN, cookie, NOW + (SESSION_MAX_AGE_S + 1) * 1000)).toBe(false);
  });

  it('refuses a cookie signed with another token, a changed timestamp, a future one, or garbage', async () => {
    const cookie = await issueSession(TOKEN, NOW);
    expect(await verifySession('another-token-of-enough-length', cookie, NOW)).toBe(false);
    const [v, iat, sig] = cookie.split('.');
    expect(await verifySession(TOKEN, `${v}.${Number(iat) + 1}.${sig}`, NOW)).toBe(false);
    expect(await verifySession(TOKEN, await issueSession(TOKEN, NOW + 10 * 60_000), NOW)).toBe(false);
    for (const bad of [undefined, '', 'v1', 'v1.x.y', `v2.${iat}.${sig}`]) expect(await verifySession(TOKEN, bad, NOW)).toBe(false);
  });

  it('checks a typed token without comparing the strings directly', async () => {
    expect(await tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(await tokenMatches(TOKEN, `${TOKEN} `)).toBe(false);
    expect(await tokenMatches(TOKEN, '')).toBe(false);
  });
});
