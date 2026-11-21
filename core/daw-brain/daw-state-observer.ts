import type { DawConnectionManager } from './daw-connection-manager.ts';
import type { DawSessionModel } from './daw-session-model.ts';
import type { DawStateSnapshot } from './types.ts';

/**
 * Strictly read-only DAW State Observer.
 * Polls adapters, attaches push subscriptions, marks unreachable hosts as `stale`/`cached`,
 * and never triggers mutating commands.
 */
export class DawStateObserver {
  readonly #connections: DawConnectionManager;
  readonly #sessions: DawSessionModel;
  readonly #pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  readonly #unsubscribers = new Map<string, () => void>();

  constructor(options: {
    readonly connections: DawConnectionManager;
    readonly sessions: DawSessionModel;
  }) {
    this.#connections = options.connections;
    this.#sessions = options.sessions;
  }

  async pollOnce(sessionId: string): Promise<DawStateSnapshot | null> {
    const sess = this.#sessions.requireSession(sessionId);
    const adapter = this.#connections.requireAdapter(sess.adapterId);
    try {
      const snapshot = await adapter.observe(sessionId);
      const updated = this.#sessions.applyObservedSnapshot(sessionId, snapshot);
      return updated.observed;
    } catch (err) {
      const degraded = this.#sessions.markStale(sessionId, (err as Error).message);
      this.#connections.transitionConnection(sessionId, {
        status: 'degraded_cached',
        consecutiveFailures: sess.connection.consecutiveFailures + 1,
      });
      return degraded.cached;
    }
  }

  attachSubscription(sessionId: string): void {
    if (this.#unsubscribers.has(sessionId)) return;
    const sess = this.#sessions.requireSession(sessionId);
    const adapter = this.#connections.requireAdapter(sess.adapterId);

    const unsub = adapter.subscribe(sessionId, (event) => {
      if (event.kind === 'snapshot_delta') {
        this.#sessions.applyObservedSnapshot(sessionId, event.snapshot);
      } else if (event.kind === 'disconnected') {
        this.#sessions.markStale(sessionId, event.reason);
        this.#connections.transitionConnection(sessionId, { status: 'degraded_cached' });
      }
    });
    this.#unsubscribers.set(sessionId, unsub);
  }

  startObserving(sessionId: string, intervalMs = 1_500): void {
    this.stopObserving(sessionId);
    this.attachSubscription(sessionId);
    const timer = setInterval(() => {
      void this.pollOnce(sessionId);
    }, Math.max(40, intervalMs));
    timer.unref?.();
    this.#pollTimers.set(sessionId, timer);
  }

  stopObserving(sessionId: string): void {
    const t = this.#pollTimers.get(sessionId);
    if (t) {
      clearInterval(t);
      this.#pollTimers.delete(sessionId);
    }
    const unsub = this.#unsubscribers.get(sessionId);
    if (unsub) {
      unsub();
      this.#unsubscribers.delete(sessionId);
    }
  }

  disposeAll(): void {
    for (const id of new Set([...this.#pollTimers.keys(), ...this.#unsubscribers.keys()])) {
      this.stopObserving(id);
    }
  }
}
