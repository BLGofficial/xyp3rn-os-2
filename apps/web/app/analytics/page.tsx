import { analyticsLoaders, runtime } from '../../lib/server';
import { ScrollTable, Time } from '../ui';

export const dynamic = 'force-dynamic';

// Platforms whose access Prompt 11 has to establish (official APIs, the owner's accounts). Named, never claimed.
const PLATFORMS = ['Spotify for Artists', 'Apple Music for Artists', 'YouTube', 'TikTok', 'Instagram', 'SoundCloud', 'Distributor'] as const;
const PLATFORM_WORD: Readonly<Record<string, string>> = {
  spotify: 'Spotify', apple_music: 'Apple Music', youtube: 'YouTube', youtube_music: 'YouTube Music', soundcloud: 'SoundCloud', bandcamp: 'Bandcamp',
  tidal: 'TIDAL', deezer: 'Deezer', amazon_music: 'Amazon Music', tiktok: 'TikTok', instagram: 'Instagram', other: 'Other',
};

// Analytics (Jarvis Prompt 01, J1): honest. No connector, so no statistic; the recorded links are shown as links.
export default async function Analytics() {
  const o = await (await analyticsLoaders()).analyticsOverview((await runtime()).sql);
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1>Analytics</h1>
        <span className="meta">as of <Time at={o.asOf} /> · source: current_platform_links</span>
      </div>
      <p className="card mt-4 p-4" data-analytics-state>
        No platform connector is configured. Metrics arrive with Prompt 11; nothing here is a statistic.
      </p>

      <h2>Recorded platform links (links, not metrics)</h2>
      <p className="meta">Where a release or track was recorded as published, by platform. A link says where it is, not how it does.</p>
      <ScrollTable label="Recorded platform links by platform" className="mt-2">
        <thead><tr><th>Platform</th><th>Links</th><th>On releases</th><th>On tracks</th></tr></thead>
        <tbody>
          {o.links.map((l) => (
            <tr key={l.platform} data-platform={l.platform}>
              <td>{PLATFORM_WORD[l.platform] ?? l.platform}</td><td className="num">{l.total}</td><td className="num">{l.releases}</td><td className="num">{l.tracks}</td>
            </tr>
          ))}
          {o.links.length === 0 && <tr><td colSpan={4} className="meta">No platform link recorded yet (a release page records them).</td></tr>}
        </tbody>
      </ScrollTable>

      <h2>Platform access</h2>
      <ul className="flex flex-col gap-1 text-sm">
        {PLATFORMS.map((p) => <li key={p}>{p}: <span className="meta">to be verified at Prompt 11</span></li>)}
      </ul>
    </section>
  );
}
