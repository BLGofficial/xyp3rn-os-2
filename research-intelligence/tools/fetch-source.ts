import type { Sql } from '../../core/db/client.ts';
import { defineTool, type Tool } from '../../core/tool-registry/registry.ts';
import { fetchSource, TEXT_LIMIT } from '../sources/fetch.ts';
import { registerResearchSource } from '../sources/verify.ts';

/**
 * fetch_source (capability web.read, Research only): fetch a URL and register it as a research
 * source in the same step. Evidence can only cite a source id this tool (or a studio
 * observation) produced, so a specialist can't cite a page it never actually read. AOS-04: the text it
 * read is stored with the source, so the DB can verify a quote against it.
 * @param deps - pool the registration runs through (as xyp_research); `fetch` override (tests)
 * @returns the tool definition
 */
export const createFetchSourceTool = (deps: { readonly sql: Sql; readonly fetch?: typeof fetch }): Tool =>
  defineTool({
    name: 'fetch_source',
    capability: 'web.read',
    description: `Fetch an http(s) URL, register it as a research source with its text (dedup by content), return up to ${TEXT_LIMIT} chars of text.`,
    handler: async (ctx, args) => {
      if (!ctx.researchRunId) throw new Error('fetch_source requires a research run');
      const url = (args as { url?: unknown } | null)?.url;
      if (typeof url !== 'string') throw new Error('fetch_source: url must be a string');
      const page = await fetchSource(url, deps.fetch);
      const src = await registerResearchSource(deps.sql, {
        researchRunId: ctx.researchRunId,
        kind: 'web',
        uri: page.uri,
        title: page.title,
        contentSha256: page.sha256,
        excerpt: page.text.slice(0, 500),
        text: page.text,
      });
      ctx.log('info', `fetch_source ${page.uri} → ${src.deduplicated ? 'existing' : 'new'} source ${src.id} (reliability ${src.reliability})`);
      return { research_source_id: src.id, deduplicated: src.deduplicated, reliability: src.reliability, uri: page.uri, title: page.title, text: page.text };
    },
  });
