import { describe, expect, it } from 'vitest';
import { createLruCache } from './lru-cache.ts';

describe('LRU cache (explicit eviction: capacity + TTL)', () => {
  it('evicts the least-recently-used entry at capacity', () => {
    const c = createLruCache<number>({ maxEntries: 2, ttlMs: 1_000, now: () => 0 });
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // touch a → b is now LRU
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
    expect(c.size()).toBe(2);
  });

  it('expires entries after their TTL, even if recently used', () => {
    let t = 0;
    const c = createLruCache<string>({ maxEntries: 10, ttlMs: 100, now: () => t });
    c.set('k', 'v');
    t = 99;
    expect(c.get('k')).toBe('v');
    t = 100;
    expect(c.get('k')).toBeUndefined();
    expect(c.size()).toBe(0);
  });

  it('overwriting a key refreshes both its value and its TTL', () => {
    let t = 0;
    const c = createLruCache<string>({ maxEntries: 10, ttlMs: 100, now: () => t });
    c.set('k', 'old');
    t = 80;
    c.set('k', 'new');
    t = 150;
    expect(c.get('k')).toBe('new');
  });

  it('rejects nonsensical limits', () => {
    expect(() => createLruCache({ maxEntries: 0, ttlMs: 1 })).toThrow();
    expect(() => createLruCache({ maxEntries: 1, ttlMs: 0 })).toThrow();
  });
});
