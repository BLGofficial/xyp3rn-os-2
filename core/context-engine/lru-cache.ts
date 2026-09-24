export type LruCache<V> = {
  readonly get: (key: string) => V | undefined;
  readonly set: (key: string, value: V) => void;
  readonly size: () => number;
};

/**
 * In-process LRU cache with a per-entry TTL. Eviction policy, explicitly:
 * - capacity: at `maxEntries`, the least-recently-used entry (read or written) is dropped;
 * - age: an entry older than `ttlMs` since its last write is dropped on the next read.
 * A Map keeps insertion order, so re-inserting on access is enough to track recency.
 * @param options - capacity, TTL, and an injectable clock for tests
 * @returns get/set/size closures over private state
 */
export const createLruCache = <V>(options: {
  readonly maxEntries: number;
  readonly ttlMs: number;
  readonly now?: () => number;
}): LruCache<V> => {
  const { maxEntries, ttlMs, now = Date.now } = options;
  if (!(maxEntries >= 1)) throw new Error(`maxEntries must be >= 1, got ${maxEntries}`);
  if (!(ttlMs > 0)) throw new Error(`ttlMs must be > 0, got ${ttlMs}`);
  const entries = new Map<string, { value: V; writtenAt: number }>();

  return {
    get: (key) => {
      const e = entries.get(key);
      if (!e) return undefined;
      if (now() - e.writtenAt >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, e);
      return e.value;
    },
    set: (key, value) => {
      entries.delete(key);
      entries.set(key, { value, writtenAt: now() });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
    },
    size: () => entries.size,
  };
};
