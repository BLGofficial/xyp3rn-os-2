import type { Sql } from '../../core/db/client.ts';
import { asRole, RESEARCH_ROLE } from '../db.ts';

/**
 * Source Verification (Phase 6C): dedup research sources by content, and score each source's
 * reliability from an explicit rubric. Every score carries the inputs that produced it.
 */

export type ResearchSourceKind = 'web' | 'doc' | 'changelog' | 'observation' | 'ingested';

/**
 * Hosts of the tools in the stack (Suno, Udio, RVC/Applio, ElevenLabs, FL Studio, Stability).
 * A match includes subdomains. Edit here — the rubric is data, not a hidden heuristic.
 */
export const VENDOR_HOSTS = ['suno.com', 'udio.com', 'applio.org', 'elevenlabs.io', 'image-line.com', 'stability.ai'] as const;
export const COMMUNITY_HOSTS = ['reddit.com', 'discord.com', 'discord.gg', 'x.com', 'twitter.com', 'youtube.com', 'tiktok.com', 'facebook.com'] as const;

/** Ordered rubric: the first matching rule decides. */
export const RELIABILITY_RUBRIC = [
  { class: 'first_party', score: 0.9, rule: 'ingested first-party document (Knowledge Layer source)' },
  { class: 'official', score: 0.9, rule: "vendor's own changelog or documentation" },
  { class: 'vendor', score: 0.8, rule: 'other page on a vendor host (blog, help centre)' },
  { class: 'studio_observation', score: 0.7, rule: 'first-hand observation recorded in the studio' },
  { class: 'independent_test', score: 0.7, rule: 'document from a non-vendor, non-community host' },
  { class: 'community', score: 0.4, rule: 'community post (forum, social, video comments)' },
  { class: 'unknown', score: 0.3, rule: 'web page on an unclassified host' },
] as const;

export type SourceClass = (typeof RELIABILITY_RUBRIC)[number]['class'];

const hostOf = (uri: string): string => {
  try {
    return new URL(uri).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const onHost = (host: string, list: readonly string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * Normalizes a URI so trivially different links to the same thing dedup: lowercase scheme and
 * host, no fragment, no utm_* parameters, no trailing slash (except the root).
 * @param uri - raw link or pseudo-URI (e.g. studio:…)
 * @returns normalized form; non-URLs are returned trimmed
 */
export const normalizeUri = (uri: string): string => {
  let u: URL;
  try {
    u = new URL(uri.trim());
  } catch {
    return uri.trim();
  }
  if (!/^https?:$/.test(u.protocol)) return uri.trim();
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (k.toLowerCase().startsWith('utm_')) u.searchParams.delete(k);
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
  const query = u.searchParams.toString();
  return `${u.protocol}//${u.host.toLowerCase()}${path === '/' ? '' : path}${query ? `?${query}` : ''}`;
};

/**
 * Classifies a source against RELIABILITY_RUBRIC.
 * @param kind - how it was obtained
 * @param uri - where it came from
 * @returns class, score, and the inputs + rule that decided
 */
export const classifySource = (kind: ResearchSourceKind, uri: string) => {
  const host = hostOf(uri);
  const cls: SourceClass =
    kind === 'ingested'
      ? 'first_party'
      : kind === 'observation'
        ? 'studio_observation'
        : kind === 'changelog' || (kind === 'doc' && onHost(host, VENDOR_HOSTS))
          ? 'official'
          : onHost(host, VENDOR_HOSTS)
            ? 'vendor'
            : onHost(host, COMMUNITY_HOSTS)
              ? 'community'
              : kind === 'doc'
                ? 'independent_test'
                : 'unknown';
  const r = RELIABILITY_RUBRIC.find((x) => x.class === cls)!;
  return { class: cls, score: r.score, inputs: { kind, host, rule: r.rule } };
};

export type RegisterSourceInput = {
  readonly researchRunId: string;
  readonly kind: ResearchSourceKind;
  readonly uri: string;
  readonly title: string;
  readonly contentSha256: string;
  readonly excerpt?: string;
  /** Knowledge Layer `sources` row, when the cited document is already ingested (F9). */
  readonly sourceId?: string;
};

/**
 * Registers a research source, content-addressed: identical bytes return the existing row.
 * @param sql - pool allowed to SET ROLE xyp_research
 * @param input - what was fetched/observed and its content hash
 * @returns the row id, whether it was a duplicate, and its reliability
 */
export const registerResearchSource = async (sql: Sql, input: RegisterSourceInput) => {
  const uri = normalizeUri(input.uri);
  const rel = classifySource(input.kind, uri);
  return asRole(sql, RESEARCH_ROLE, async (tx) => {
    const inserted = await tx<{ id: string }[]>`
      insert into research_sources (research_run_id, source_id, kind, uri, title, content_sha256, excerpt, reliability, reliability_inputs)
      values (${input.researchRunId}, ${input.sourceId ?? null}, ${input.kind}, ${uri}, ${input.title}, ${input.contentSha256},
              ${input.excerpt ?? null}, ${rel.score}, ${tx.json({ class: rel.class, ...rel.inputs })})
      on conflict (content_sha256) do nothing
      returning id`;
    if (inserted.length > 0) return { id: inserted[0]!.id, deduplicated: false, reliability: rel.score, class: rel.class };
    const [existing] = await tx<{ id: string; reliability: string }[]>`
      select id, reliability from research_sources where content_sha256 = ${input.contentSha256}`;
    return { id: existing!.id, deduplicated: true, reliability: Number(existing!.reliability), class: rel.class };
  });
};

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Cites an already-ingested Knowledge Layer document (F9) as a research source. The excerpt must
 * appear verbatim (whitespace-insensitive: PDF line wraps) in canonical text derived from that
 * source, so a citation can quote the document but never put words in its mouth.
 * @param sql - pool allowed to SET ROLE xyp_research
 * @param input - research run, the `sources` row, and the quoted passage
 * @returns the research source (first_party reliability) and the canonical slugs quoting it
 * @throws Error for an unknown source or an excerpt the document doesn't contain
 */
export const citeIngestedSource = async (
  sql: Sql,
  input: { readonly researchRunId: string; readonly sourceId: string; readonly excerpt: string },
) => {
  const excerpt = squash(input.excerpt);
  if (excerpt === '') throw new Error('a citation needs an excerpt');
  const { src, citedIn } = await asRole(sql, RESEARCH_ROLE, async (tx) => {
    const [s] = await tx<{ uri: string; title: string; checksum_sha256: string }[]>`
      select uri, title, checksum_sha256 from sources where id = ${input.sourceId}`;
    if (!s) throw new Error(`unknown source ${input.sourceId}`);
    const hits = await tx<{ slug: string }[]>`
      select distinct slug from canonical_prompts
      where source_id = ${input.sourceId} and position(${excerpt} in regexp_replace(body, '[[:space:]]+', ' ', 'g')) > 0
      order by slug`;
    return { src: s, citedIn: hits.map((h) => h.slug) };
  });
  if (citedIn.length === 0) throw new Error(`excerpt not found verbatim in ${src.uri}: "${excerpt}"`);
  const reg = await registerResearchSource(sql, {
    researchRunId: input.researchRunId, kind: 'ingested', uri: src.uri, title: src.title,
    contentSha256: src.checksum_sha256, excerpt, sourceId: input.sourceId,
  });
  return { ...reg, citedIn };
};
