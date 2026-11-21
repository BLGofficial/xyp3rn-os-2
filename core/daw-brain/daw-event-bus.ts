import type { SqliteRuntimeDb } from '../sqlite/client.ts';

export type DawEventType =
  | 'daw.instance.discovered'
  | 'daw.connection.state_changed'
  | 'daw.adapter.connected'
  | 'daw.adapter.disconnected'
  | 'daw.adapter.degraded'
  | 'daw.health.checked'
  | 'daw.version.checked'
  | 'daw.session.observed'
  | 'daw.session.stale'
  | 'daw.session.drift_detected'
  | 'daw.capability.denied'
  | 'daw.lease.granted'
  | 'daw.lease.revoked'
  | 'daw.command.proposed'
  | 'daw.command.dry_run'
  | 'daw.command.prepared'
  | 'daw.command.executed'
  | 'daw.command.denied'
  | 'daw.command.cancelled'
  | 'daw.command.timed_out'
  | 'daw.command.recovered'
  | 'daw.command.rolled_back'
  | 'daw.plugin.analyzed'
  | 'daw.audio.analyzed'
  | 'daw.audio.rejected';

export type DawEventEnvelope = {
  readonly eventType: DawEventType;
  readonly sessionId: string | null;
  readonly actor: string;
  readonly timestamp: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type DawEventListener = (event: DawEventEnvelope) => void;

const DURABLE_EVENT_TYPES = new Set<DawEventType>([
  'daw.adapter.connected',
  'daw.adapter.disconnected',
  'daw.adapter.degraded',
  'daw.capability.denied',
  'daw.lease.granted',
  'daw.lease.revoked',
  'daw.command.dry_run',
  'daw.command.prepared',
  'daw.command.executed',
  'daw.command.denied',
  'daw.command.cancelled',
  'daw.command.timed_out',
  'daw.command.recovered',
  'daw.command.rolled_back',
  'daw.plugin.analyzed',
  'daw.audio.analyzed',
  'daw.audio.rejected',
]);

/**
 * Vendor-independent DAW Brain Event Bus supporting coalesced high-frequency
 * observation throttling plus durable SQLite audit mirroring for security-critical events.
 */
export class DawEventBus {
  readonly #db: SqliteRuntimeDb | null;
  readonly #listeners = new Map<string, Set<DawEventListener>>();
  readonly #recentEvents: DawEventEnvelope[] = [];
  readonly #lastCoalesceAt = new Map<string, number>();
  readonly #coalesceWindowMs: number;
  readonly #maxHistory: number;

  constructor(options: {
    readonly db?: SqliteRuntimeDb | null | undefined;
    readonly coalesceWindowMs?: number | undefined;
    readonly maxHistory?: number | undefined;
  } = {}) {
    this.#db = options.db ?? null;
    this.#coalesceWindowMs = Math.max(0, options.coalesceWindowMs ?? 0);
    this.#maxHistory = Math.max(20, options.maxHistory ?? 500);
  }

  subscribe(eventTypeOrWildcard: DawEventType | '*', listener: DawEventListener): () => void {
    const set = this.#listeners.get(eventTypeOrWildcard) ?? new Set<DawEventListener>();
    set.add(listener);
    this.#listeners.set(eventTypeOrWildcard, set);
    return () => {
      set.delete(listener);
    };
  }

  emit(
    eventType: DawEventType,
    sessionId: string | null,
    payload: Readonly<Record<string, unknown>> = {},
    actor = 'daw-core',
  ): boolean {
    if (eventType === 'daw.session.observed' && this.#coalesceWindowMs > 0) {
      const key = `${eventType}:${sessionId ?? 'global'}`;
      const now = Date.now();
      const prev = this.#lastCoalesceAt.get(key) ?? 0;
      if (now - prev < this.#coalesceWindowMs) {
        return false;
      }
      this.#lastCoalesceAt.set(key, now);
    }

    const envelope: DawEventEnvelope = {
      eventType,
      sessionId,
      actor,
      timestamp: new Date().toISOString(),
      payload,
    };

    this.#recentEvents.push(envelope);
    if (this.#recentEvents.length > this.#maxHistory) {
      this.#recentEvents.shift();
    }

    if (DURABLE_EVENT_TYPES.has(eventType) && this.#db && this.#db.isOpen) {
      try {
        this.#db.appendEvent({
          eventType,
          domain: 'TECH',
          actor,
          targetPath: sessionId ? `daw://session/${sessionId}` : null,
          payload: { sessionId, ...payload },
        });
      } catch {
        // Never allow telemetry failure to destabilize DAW command/rollback paths
      }
    }

    for (const key of [eventType, '*'] as const) {
      const group = this.#listeners.get(key);
      if (!group) continue;
      for (const listener of group) {
        try {
          listener(envelope);
        } catch {
          // Isolate subscriber errors cleanly
        }
      }
    }

    return true;
  }

  listRecent(limit = 50): readonly DawEventEnvelope[] {
    return this.#recentEvents.slice(-limit).reverse();
  }
}
