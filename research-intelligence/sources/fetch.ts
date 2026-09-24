import { createHash } from 'node:crypto';
import { extractPdfPages, isPdf } from '../../knowledge/ingestion/extract-pdf.ts';

/**
 * Plain HTTP fetch for research sources: bytes → checksum + readable text. No LLM, no
 * rendering, no cookies. Explicit limits so one bad URL can't stall or flood a research run.
 */

export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BYTES = 2_000_000;
/** Text handed back to the agent; the checksum always covers the full body. */
export const TEXT_LIMIT = 20_000;

export type FetchedSource = {
  readonly uri: string;
  readonly contentType: string;
  readonly title: string;
  readonly text: string;
  readonly sha256: string;
  readonly bytes: number;
};

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', apos: "'" };

/**
 * HTML → readable text: drops script/style/noscript, strips tags, decodes common entities.
 * @param html - page source
 * @returns title (from <title>) and whitespace-collapsed text
 */
export const htmlToText = (html: string): { title: string; text: string } => {
  const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp|apos);/g, (_, e: string) => ENTITIES[e] ?? _);
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim();
  const text = decode(
    html
      .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<title[^>]*>[\s\S]*?<\/title>/i, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
  return { title, text };
};

/**
 * Fetches a URL within the limits and extracts text.
 * @param url - http(s) URL
 * @returns final URI, content type, title, text (≤ TEXT_LIMIT chars), sha256 of the full body
 * @throws Error on non-2xx, oversize body, timeout or unsupported content type
 */
export const fetchSource = async (url: string): Promise<FetchedSource> => {
  if (!/^https?:\/\//i.test(url)) throw new Error(`fetch_source: only http(s) URLs are allowed: ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch_source: ${url} returned HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > FETCH_MAX_BYTES) throw new Error(`fetch_source: ${url} is ${declared} bytes (limit ${FETCH_MAX_BYTES})`);
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.length > FETCH_MAX_BYTES) throw new Error(`fetch_source: ${url} is ${body.length} bytes (limit ${FETCH_MAX_BYTES})`);
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const sha256 = createHash('sha256').update(body).digest('hex');

  let title: string;
  let text: string;
  if (isPdf(body)) {
    const pages = await extractPdfPages(body);
    text = pages.join('\n').replace(/\s+/g, ' ').trim();
    title = pages[0]?.split('\n')[0]?.trim() || url;
  } else if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    ({ title, text } = htmlToText(new TextDecoder().decode(body)));
  } else if (contentType.startsWith('text/') || contentType === 'application/json') {
    text = new TextDecoder().decode(body).trim();
    title = url;
  } else {
    throw new Error(`fetch_source: unsupported content type "${contentType}" at ${url}`);
  }
  return { uri: res.url || url, contentType, title: title || url, text: text.slice(0, TEXT_LIMIT), sha256, bytes: body.length };
};
