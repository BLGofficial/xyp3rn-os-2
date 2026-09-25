// Small presentational pieces shared by the screens. Server components only.

export const ErrorBanner = ({ error }: { error?: string | string[] | undefined }) =>
  typeof error === 'string' && error !== '' ? <p className="error" role="alert">{error}</p> : null;

/** Every figure shows its time: UTC, to the second. */
export const Time = ({ at }: { at: string | null }) => (at ? <time dateTime={at}>{at.replace('T', ' ').slice(0, 19)}Z</time> : <span>—</span>);

export const Status = ({ status }: { status: string }) => <span className={`status-${status}`}>{status}</span>;

export const SongLinks = ({ songs }: { songs: readonly { id: string; title: string }[] }) =>
  songs.length === 0 ? <span className="meta">no song</span> : <>{songs.map((s) => <a key={s.id} href={`/songs/${s.id}`} className="mr-2">{s.title}</a>)}</>;

export const Tags = ({ tags }: { tags: readonly string[] }) => <>{tags.map((t) => <a key={t} href={`/vault?tag=${encodeURIComponent(t)}`} className="tag no-underline">{t}</a>)}</>;

export const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v) || undefined;
