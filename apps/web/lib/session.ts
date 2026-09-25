/**
 * The UI's session (AOS-01 §9): local and single-owner, so one shared secret, XYP_WEB_TOKEN. A
 * correct token gets `v1.<issued at, s>.<HMAC-SHA256(token, "xyp-web-session:v1:<issued at>")>`,
 * checked by the middleware on every route. Web Crypto only (no node:crypto), so the same code runs
 * in the Edge middleware, in server actions and in the tests.
 */

export const MIN_TOKEN_CHARS = 16;
export const SESSION_COOKIE = 'xyp_session';
export const SESSION_MAX_AGE_S = 12 * 60 * 60;
// A cookie issued "in the future" beyond this is refused (clock skew between issue and check is ~0 here).
const MAX_SKEW_S = 60;

/**
 * @param token - XYP_WEB_TOKEN
 * @returns why the app can't run with it, or null when it can
 */
export const tokenProblem = (token: string | undefined): string | null => {
  if (token === undefined || token === '') return 'XYP_WEB_TOKEN is not set: the UI refuses every request until it is';
  if (token.length < MIN_TOKEN_CHARS) return `XYP_WEB_TOKEN must be at least ${MIN_TOKEN_CHARS} characters`;
  return null;
};

const hmac = async (key: string, message: string): Promise<string> => {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** Constant-time for equal lengths: every character is compared whatever the first difference. */
const same = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * @param token - XYP_WEB_TOKEN
 * @param nowMs - issue time
 * @returns the cookie value
 */
export const issueSession = async (token: string, nowMs: number): Promise<string> => {
  const iat = Math.floor(nowMs / 1000);
  return `v1.${iat}.${await hmac(token, `xyp-web-session:v1:${iat}`)}`;
};

/**
 * @param token - XYP_WEB_TOKEN
 * @param cookie - the session cookie, if any
 * @param nowMs - check time
 * @returns true for a well-formed, correctly signed, unexpired session
 */
export const verifySession = async (token: string, cookie: string | undefined, nowMs: number): Promise<boolean> => {
  const m = /^v1\.(\d{1,12})\.([0-9a-f]{64})$/.exec(cookie ?? '');
  if (!m) return false;
  const iat = Number(m[1]);
  const now = Math.floor(nowMs / 1000);
  if (iat > now + MAX_SKEW_S || now - iat > SESSION_MAX_AGE_S) return false;
  return same(await hmac(token, `xyp-web-session:v1:${iat}`), m[2]!);
};

/**
 * Compares a typed token with the real one through their HMACs, so the comparison takes the same
 * time whatever the candidate's length or its first wrong character.
 * @param token - XYP_WEB_TOKEN
 * @param candidate - what was typed
 * @returns true when they are equal
 */
export const tokenMatches = async (token: string, candidate: string): Promise<boolean> =>
  same(await hmac(token, `xyp-web-login:${candidate}`), await hmac(token, `xyp-web-login:${token}`));
