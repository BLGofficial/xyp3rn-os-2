/**
 * Turns a user-facing assistant reply into text worth speaking. Meaning (uncertainty, errors,
 * approval requirements) is kept verbatim; only unreadable or unsafe-to-voice tokens are replaced.
 * The full original reply stays on screen.
 */

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_TOKEN = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
// Provider keys, bearer tokens, and long opaque strings (keys, hashes, base64 payloads).
const SECRET = /\bBearer\s+\S+|\b(?:sk|pk|rk|ghp|gho|github_pat|xox[abprs]|AKIA)[-_A-Za-z0-9]{8,}|\b[A-Za-z0-9+/_-]{32,}={0,2}/g;

export const speechText = (reply: string): string => {
  let t = reply
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/<[^>]+>/g, ' ');
  // JSON-like tool payloads, innermost first.
  for (let i = 0; i < 3; i++) t = t.replace(/\{[^{}]*\}|\[[^[\]]*[:{][^[\]]*\]/g, ' (details omitted) ');
  return t
    .replace(URL_TOKEN, ' (link on screen) ')
    .replace(UUID, ' (ID on screen) ')
    .replace(SECRET, ' (hidden value) ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
    .replace(/[*_`#>|~^]+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
};

export const CHUNK_CHARS = 600;

/** Sentence-bounded chunks of at most `max` chars; one chunk when the text already fits. */
export const speechChunks = (text: string, max = CHUNK_CHARS): string[] => {
  if (!text) return [];
  if (text.length <= max) return [text];
  const pieces = (text.match(/[^.!?…]+(?:[.!?…]+|$)\s*/g) ?? [text]).flatMap((s) => {
    if (s.length <= max) return [s];
    const words: string[] = []; let cur = '';
    for (const w of s.split(/(\s+)/)) { if ((cur + w).length > max && cur.trim()) { words.push(cur); cur = ''; } cur += w.length > max ? w.slice(0, max) : w; }
    return cur.trim() ? [...words, cur] : words;
  });
  const chunks: string[] = []; let cur = '';
  for (const p of pieces) { if ((cur + p).length > max && cur.trim()) { chunks.push(cur.trim()); cur = ''; } cur += p; }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
};
