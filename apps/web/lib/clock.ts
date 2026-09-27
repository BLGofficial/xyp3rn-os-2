/**
 * The Sofia clock's arithmetic (AOS-04 design §19). Pure: the client component (app/shell/sofia-clock.tsx)
 * supplies instants and samples. Time zone correctness comes from the IANA zone `Europe/Sofia`, never a
 * fixed offset; clock accuracy is a separate question, answered by server samples and stated as a sync state.
 */

export const SOFIA_ZONE = 'Europe/Sofia';
/** Re-sample the server this often (and on tab resume or reconnect). */
export const SYNC_EVERY_MS = 300_000;
/** A server sample older than this no longer backs a "Server-synced" claim. */
export const STALE_AFTER_MS = 600_000;

const TIME = new Intl.DateTimeFormat('en-GB', { timeZone: SOFIA_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const DATE = new Intl.DateTimeFormat('en-GB', { timeZone: SOFIA_ZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const OFFSET = new Intl.DateTimeFormat('en-GB', { timeZone: SOFIA_ZONE, timeZoneName: 'longOffset' });

export type SofiaParts = { readonly time: string; readonly short: string; readonly date: string; readonly offset: string };

/**
 * @param epochMs - an instant
 * @returns Sofia wall time `HH:mm:ss` and `HH:mm`, the local date, and the UTC offset in force (`GMT+02:00` / `GMT+03:00`)
 */
export const sofiaParts = (epochMs: number): SofiaParts => {
  const d = new Date(epochMs);
  const time = TIME.format(d);
  return {
    time,
    short: time.slice(0, 5),
    // en-GB renders "Thursday, 31 December 2026" on some ICU versions; the comma is dropped so the text is stable.
    date: DATE.format(d).replace(',', ''),
    offset: OFFSET.formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? SOFIA_ZONE,
  };
};

const YMD = new Intl.DateTimeFormat('en-CA', { timeZone: SOFIA_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/**
 * An event's timestamp in Sofia time (§19): `YYYY-MM-DD HH:mm:ss +HH:MM`, the offset being the one in force
 * at that instant. Shared by the server-rendered <Time> and the clock.
 * @param epochMs - an instant
 * @returns the Sofia wall time with its UTC offset
 */
export const sofiaStamp = (epochMs: number): string => {
  const p = sofiaParts(epochMs);
  return `${YMD.format(new Date(epochMs))} ${p.time} ${p.offset.replace(/^GMT/, '') || '+00:00'}`;
};

export type Sample = { readonly offsetMs: number; readonly rttMs: number };

/**
 * One server-time sample: the server's stamp against the midpoint of the request's round trip.
 * @param s - device times at send and receive (ms, one clock), and the server's epoch ms
 * @returns the device→server offset and the round trip it was measured over
 */
export const offsetFromSample = (s: { readonly sentAt: number; readonly receivedAt: number; readonly serverEpochMs: number }): Sample => ({
  offsetMs: s.serverEpochMs - (s.sentAt + s.receivedAt) / 2,
  rttMs: s.receivedAt - s.sentAt,
});

/**
 * @param samples - the samples taken so far
 * @returns the one with the lowest round trip (the least uncertain), or null with none
 */
export const bestSample = (samples: readonly Sample[]): Sample | null =>
  samples.reduce<Sample | null>((best, s) => (best === null || s.rttMs < best.rttMs ? s : best), null);

export type SyncState = 'server-synced' | 'device-unverified' | 'stale';

/**
 * What the clock may claim about its accuracy.
 * @param last - the last successful sample (its device time), or null
 * @param now - the device's now
 * @returns server-synced within STALE_AFTER_MS of a sample; stale after; device-unverified with none
 */
export const syncState = (last: { readonly at: number } | null, now: number): SyncState =>
  last === null ? 'device-unverified' : now - last.at > STALE_AFTER_MS ? 'stale' : 'server-synced';

export const SYNC_LABEL: Readonly<Record<SyncState, string>> = {
  'server-synced': 'Server-synced',
  'device-unverified': 'Device time · not verified',
  stale: 'Server time · stale',
};
