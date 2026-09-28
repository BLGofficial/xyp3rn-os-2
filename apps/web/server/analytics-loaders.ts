import type { Sql } from '../../../core/db/client.ts';
import { asWeb } from './loaders.ts';

/**
 * Analytics (Jarvis Prompt 01, J1): no platform connector exists yet (Prompt 11), so there is nothing to measure.
 * The one real data point is what the owner recorded: live platform links (AOS-02), by platform. They are links,
 * not metrics; this module returns no number that could read as one.
 */

/**
 * @param sql - the app's pool
 * @returns live links by platform (retracted ones excluded), their total, and the configured connectors (none)
 */
export const analyticsOverview = (sql: Sql) =>
  asWeb(sql, async (tx) => {
    const links = await tx<{ platform: string; total: number; releases: number; tracks: number }[]>`
      select platform, count(*)::int as total, count(release_id)::int as releases, count(track_id)::int as tracks
      from current_platform_links group by platform order by platform`;
    const [now] = await tx<{ now: Date }[]>`select now()`;
    return {
      links: links.map((l) => ({ platform: l.platform, total: l.total, releases: l.releases, tracks: l.tracks })),
      totalLinks: links.reduce((s, l) => s + l.total, 0),
      // Prompt 11 adds connectors behind adapters; until then this list is empty by construction, not by query.
      connectors: [] as { readonly name: string }[],
      asOf: now!.now.toISOString(),
    };
  });
