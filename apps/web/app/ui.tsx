import { sofiaStamp } from '../lib/clock.ts';

// Small presentational pieces shared by the screens. Server components only.

export const ErrorBanner = ({ error }: { error?: string | string[] | undefined }) =>
  typeof error === 'string' && error !== '' ? <p className="error" role="alert">{error}</p> : null;

/** Every figure shows its time, to the second: Sofia wall time with its offset (§19); UTC on hover. */
export const Time = ({ at }: { at: string | null }) => (at ? <time dateTime={at} title={`UTC ${at}`}>{sofiaStamp(Date.parse(at))}</time> : <span>—</span>);

export const Status = ({ status }: { status: string }) => <span className={`status-${status}`}>{status}</span>;

export const SongLinks = ({ songs }: { songs: readonly { id: string; title: string }[] }) =>
  songs.length === 0 ? <span className="meta">no song</span> : <>{songs.map((s) => <a key={s.id} href={`/songs/${s.id}`} className="mr-2">{s.title}</a>)}</>;

export const Tags = ({ tags }: { tags: readonly string[] }) => <>{tags.map((t) => <a key={t} href={`/vault?tag=${encodeURIComponent(t)}`} className="tag no-underline">{t}</a>)}</>;

export const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v) || undefined;
