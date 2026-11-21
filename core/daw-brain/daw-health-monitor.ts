import type { DawHealthReport } from './daw-adapter-sdk.ts';
import type { DawConnectionManager } from './daw-connection-manager.ts';
import type { DawEventBus } from './daw-event-bus.ts';
import type { DawSessionModel } from './daw-session-model.ts';

/**
 * Monitors DAW adapter liveness, round-trip latency, and consecutive heartbeat failures.
 * Degrades unresponsive connections gracefully to `degraded_cached` + `stale` snapshot
 * without discarding offline cache or corrupting project truth.
 */
export class DawHealthMonitor {
  readonly #connections: DawConnectionManager;
  readonly #sessions: DawSessionModel;
  readonly #events: DawEventBus;
  readonly #timers = new Map<string, ReturnType<typeof setInterval>>();
  readonly #maxConsecutiveFailures: number;

  constructor(options: {
    readonly connections: DawConnectionManager;
    readonly sessions: DawSessionModel;
    readonly events: DawEventBus;
    readonly maxConsecutiveFailures?: number | undefined;
  }) {
    this.#connections = options.connections;
    this.#sessions = options.sessions;
    this.#events = options.events;
    this.#maxConsecutiveFailures = Math.max(1, options.maxConsecutiveFailures ?? 3);
  }

  async checkNow(sessionId: string): Promise<DawHealthReport> {
    const sess = this.#sessions.requireSession(sessionId);
    const adapter = this.#connections.requireAdapter(sess.adapterId);
    const nowIso = new Date().toISOString();

    let report: DawHealthReport;
    try {
      report = await adapter.healthCheck(sess.connection.connectionId);
    } catch (err) {
      report = {
        adapterId: sess.adapterId,
        healthy: false,
        reachable: false,
        rttMs: -1,
        degradedReason: (err as Error).message,
        missingPrerequisites: [],
        provenance: {
          observedAt: nowIso,
          dawId: sess.dawId,
          adapterId: sess.adapterId,
          hostVersion: sess.hostVersion,
          sourceEvidence: `health_check_exception:${sess.adapterId}`,
          freshness: 'stale',
        },
      };
    }

    this.#events.emit('daw.health.checked', sessionId, {
      healthy: report.healthy,
      reachable: report.reachable,
      rttMs: report.rttMs,
      degradedReason: report.degradedReason,
    });

    if (report.healthy && report.reachable) {
      this.#connections.transitionConnection(sessionId, {
        status:
          sess.connection.status === 'leased_mutable'
            ? 'leased_mutable'
            : 'connected_read_only',
        lastHeartbeatAt: report.provenance.observedAt,
        lastRttMs: report.rttMs,
        consecutiveFailures: 0,
      });
      return report;
    }

    const failures = sess.connection.consecutiveFailures + 1;
    const isOffline = failures >= this.#maxConsecutiveFailures || !report.reachable;

    this.#connections.transitionConnection(sessionId, {
      status: isOffline ? 'degraded_cached' : sess.connection.status,
      lastHeartbeatAt: report.provenance.observedAt,
      lastRttMs: report.rttMs >= 0 ? report.rttMs : sess.connection.lastRttMs,
      consecutiveFailures: failures,
    });

    if (isOffline) {
      this.#sessions.markStale(sessionId, report.degradedReason ?? 'DAW host unreachable');
      this.#events.emit('daw.adapter.degraded', sessionId, {
        failures,
        reason: report.degradedReason ?? 'Host health probe failed',
      });
    }

    return report;
  }

  startMonitoring(sessionId: string, intervalMs = 3_000): void {
    this.stopMonitoring(sessionId);
    const timer = setInterval(() => {
      void this.checkNow(sessionId);
    }, Math.max(50, intervalMs));
    timer.unref?.();
    this.#timers.set(sessionId, timer);
  }

  stopMonitoring(sessionId: string): void {
    const existing = this.#timers.get(sessionId);
    if (existing) {
      clearInterval(existing);
      this.#timers.delete(sessionId);
    }
  }

  disposeAll(): void {
    for (const id of [...this.#timers.keys()]) {
      this.stopMonitoring(id);
    }
  }
}
