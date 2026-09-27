import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bestSample, offsetFromSample, SYNC_EVERY_MS, sofiaParts, STALE_AFTER_MS, syncState } from './clock.ts';

// AOS-04 Plan B, Task 3 (design §19): Sofia time from the IANA zone (never a fixed offset), the server-time
// offset estimate, and the sync state the clock may claim.

const at = (iso: string) => Date.parse(iso);

describe('sofiaParts', () => {
  it.each([
    ['winter', '2026-01-15T12:00:00Z', '14:00:00', 'GMT+02:00'],
    ['summer', '2026-07-15T12:00:00Z', '15:00:00', 'GMT+03:00'],
    ['the second before the spring jump', '2026-03-29T00:59:59Z', '02:59:59', 'GMT+02:00'],
    ['the spring jump (03:00 never happens)', '2026-03-29T01:00:00Z', '04:00:00', 'GMT+03:00'],
    ['the autumn hour, first pass', '2026-10-25T00:30:00Z', '03:30:00', 'GMT+03:00'],
    ['the autumn hour, repeated', '2026-10-25T01:30:00Z', '03:30:00', 'GMT+02:00'],
  ])('%s: %s → %s %s', (_name, iso, time, offset) => {
    expect(sofiaParts(at(iso))).toMatchObject({ time, offset, short: time.slice(0, 5) });
  });

  it('rolls the date at Sofia midnight, not UTC midnight', () => {
    expect(sofiaParts(at('2026-12-31T21:59:59Z'))).toMatchObject({ time: '23:59:59', date: 'Thursday 31 December 2026' });
    expect(sofiaParts(at('2026-12-31T22:00:00Z'))).toMatchObject({ time: '00:00:00', date: 'Friday 1 January 2027' });
  });

  it('gives the same answer whatever the process timezone is', () => {
    const script = `import { sofiaParts } from ${JSON.stringify(join(import.meta.dirname, 'clock.ts'))};
      console.log(JSON.stringify(sofiaParts(Date.parse('2026-07-15T12:00:00Z'))));`;
    for (const tz of ['America/New_York', 'Asia/Tokyo', 'UTC']) {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout)).toEqual(sofiaParts(at('2026-07-15T12:00:00Z')));
    }
  });
});

describe('server-time offset', () => {
  it('estimates the offset from the round trip\'s midpoint', () => {
    // Sent at 1000, received at 1100 (device clock); the server stamped 6050, i.e. 5000 ms ahead of the midpoint.
    expect(offsetFromSample({ sentAt: 1000, receivedAt: 1100, serverEpochMs: 6050 })).toEqual({ offsetMs: 5000, rttMs: 100 });
  });

  it('keeps the lowest round trip', () => {
    const samples = [{ offsetMs: 5100, rttMs: 300 }, { offsetMs: 5001, rttMs: 40 }, { offsetMs: 4900, rttMs: 120 }];
    expect(bestSample(samples)).toEqual({ offsetMs: 5001, rttMs: 40 });
    expect(bestSample([])).toBeNull();
  });
});

describe('syncState', () => {
  it('claims server sync only after a successful sample, and marks it stale after ten minutes', () => {
    const now = at('2026-09-27T12:00:00Z');
    expect(syncState(null, now)).toBe('device-unverified');
    expect(syncState({ at: now - 60_000 }, now)).toBe('server-synced');
    expect(syncState({ at: now - STALE_AFTER_MS - 1 }, now)).toBe('stale');
    expect(SYNC_EVERY_MS).toBe(300_000);
    expect(STALE_AFTER_MS).toBe(600_000);
  });
});
