import { createHash } from 'node:crypto';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import type { DawEventBus } from './daw-event-bus.ts';
import {
  DawBrainError,
  type DawCommand,
  type DawCommandResult,
  type DawConnection,
  type DawProject,
  type DawSession,
  type DawStateFreshness,
  type DawStateSnapshot,
} from './types.ts';

const collectUnavailableKeys = (snapshot: DawStateSnapshot): readonly string[] => {
  const keys: string[] = [];
  const sections = [
    ['tracks', snapshot.tracks],
    ['channels', snapshot.channels],
    ['mixerChannels', snapshot.mixerChannels],
    ['buses', snapshot.buses],
    ['routing', snapshot.routing],
    ['plugins', snapshot.plugins],
    ['automationLanes', snapshot.automationLanes],
    ['audioClips', snapshot.audioClips],
    ['midiClips', snapshot.midiClips],
    ['markers', snapshot.markers],
    ['regions', snapshot.regions],
  ] as const;

  for (const [name, field] of sections) {
    if (field.status !== 'available') {
      keys.push(`${name}:${field.status}`);
    }
  }
  return keys;
};

/**
 * Computes a stable digest across the observable musical topology to detect live drift.
 */
export const computeSnapshotDigest = (snapshot: DawStateSnapshot): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        bpm: snapshot.transport.tempo.bpm,
        playing: snapshot.transport.playing,
        tracks: snapshot.tracks,
        mixerChannels: snapshot.mixerChannels,
        routing: snapshot.routing,
        plugins: snapshot.plugins,
      }),
    )
    .digest('hex');

/**
 * Manages the 7 distinct DAW state representations per session:
 * `observed`, `cached`, `stale`, `proposed`, `applied`, `saved`, and explicit `unknownFields`,
 * syncing session headers/caches cleanly to SQLite `daw_sessions` (never conflating live vs saved).
 */
export class DawSessionModel {
  readonly #sessions = new Map<string, DawSession>();
  readonly #baselineDigestAtSave = new Map<string, string>();
  readonly #db: SqliteRuntimeDb | null;
  readonly #events: DawEventBus | null;
  readonly #staleThresholdMs: number;

  constructor(options: {
    readonly db?: SqliteRuntimeDb | null | undefined;
    readonly events?: DawEventBus | null | undefined;
    readonly staleThresholdMs?: number | undefined;
  } = {}) {
    this.#db = options.db ?? null;
    this.#events = options.events ?? null;
    this.#staleThresholdMs = Math.max(500, options.staleThresholdMs ?? 15_000);
  }

  createSession(input: {
    readonly sessionId: string;
    readonly dawId: string;
    readonly hostVersion: string;
    readonly connection: DawConnection;
    readonly project: DawProject;
    readonly initialObserved?: DawStateSnapshot | undefined;
  }): DawSession {
    const now = new Date().toISOString();
    const initialSnap = input.initialObserved
      ? {
          ...input.initialObserved,
          freshness: 'observed' as const,
          provenance: { ...input.initialObserved.provenance, freshness: 'observed' as const },
        }
      : null;

    if (initialSnap && input.project.savedSha256) {
      this.#baselineDigestAtSave.set(input.sessionId, initialSnap.stateDigest);
    }

    const session: DawSession = {
      sessionId: input.sessionId,
      adapterId: input.connection.adapterId,
      dawId: input.dawId,
      hostVersion: input.hostVersion,
      project: input.project,
      connection: input.connection,
      stateFreshness: initialSnap ? 'observed' : 'unknown',
      observed: initialSnap,
      cached: initialSnap
        ? {
            ...initialSnap,
            freshness: 'cached',
            provenance: { ...initialSnap.provenance, freshness: 'cached' },
          }
        : null,
      stale: initialSnap === null,
      saved: input.project.savedSha256 ? input.project : null,
      proposed: [],
      applied: [],
      unknownFields: initialSnap ? collectUnavailableKeys(initialSnap) : ['snapshot:unknown'],
      hasUnsavedLiveChanges: false,
      updatedAt: now,
    };

    this.#sessions.set(session.sessionId, session);
    this.#persistSessionHeader(session);
    return session;
  }

  getSession(sessionId: string): DawSession | null {
    const sess = this.#sessions.get(sessionId);
    if (!sess) return null;
    return this.evaluateFreshness(sess.sessionId);
  }

  requireSession(sessionId: string): DawSession {
    const sess = this.getSession(sessionId);
    if (!sess) {
      throw new DawBrainError('DAW_SESSION_NOT_FOUND', `DAW session not found: "${sessionId}"`);
    }
    return sess;
  }

  listSessions(): readonly DawSession[] {
    return [...this.#sessions.keys()].map((id) => this.evaluateFreshness(id)!);
  }

  updateConnection(sessionId: string, connection: DawConnection): DawSession {
    const prev = this.requireSession(sessionId);
    const offlineOrDegraded =
      connection.status === 'degraded_cached' ||
      connection.status === 'disconnected' ||
      connection.status === 'closed';

    const next: DawSession = {
      ...prev,
      connection,
      stateFreshness: offlineOrDegraded
        ? prev.cached
          ? 'stale'
          : 'unknown'
        : prev.observed
          ? prev.stateFreshness
          : 'unknown',
      stale: offlineOrDegraded ? true : prev.stale,
      observed: offlineOrDegraded ? null : prev.observed,
      updatedAt: new Date().toISOString(),
    };

    this.#sessions.set(sessionId, next);
    this.#persistSessionHeader(next);
    return next;
  }

  applyObservedSnapshot(sessionId: string, snapshot: DawStateSnapshot): DawSession {
    const prev = this.requireSession(sessionId);
    const observedSnap: DawStateSnapshot = {
      ...snapshot,
      freshness: 'observed',
      provenance: {
        ...snapshot.provenance,
        freshness: 'observed',
      },
      stateDigest: snapshot.stateDigest || computeSnapshotDigest(snapshot),
    };

    const cachedSnap: DawStateSnapshot = {
      ...observedSnap,
      freshness: 'cached',
      provenance: {
        ...observedSnap.provenance,
        freshness: 'cached',
      },
    };

    const saveBaseline = this.#baselineDigestAtSave.get(sessionId);
    const divergedFromSave =
      (saveBaseline !== undefined && observedSnap.stateDigest !== saveBaseline) ||
      prev.applied.length > 0;

    if (divergedFromSave && !prev.hasUnsavedLiveChanges) {
      this.#events?.emit('daw.session.drift_detected', sessionId, {
        previousDigest: saveBaseline ?? null,
        observedDigest: observedSnap.stateDigest,
      });
    }

    const next: DawSession = {
      ...prev,
      stateFreshness: 'observed',
      observed: observedSnap,
      cached: cachedSnap,
      stale: false,
      unknownFields: collectUnavailableKeys(observedSnap),
      hasUnsavedLiveChanges: divergedFromSave,
      updatedAt: new Date().toISOString(),
    };

    this.#sessions.set(sessionId, next);
    this.#persistSessionHeader(next);
    this.#events?.emit('daw.session.observed', sessionId, {
      snapshotId: observedSnap.snapshotId,
      digest: observedSnap.stateDigest,
      unknownCount: next.unknownFields.length,
    });
    return next;
  }

  markStale(sessionId: string, reason = 'observation expired or connection degraded'): DawSession {
    const prev = this.requireSession(sessionId);
    const staleCached = prev.cached
      ? {
          ...prev.cached,
          freshness: 'stale' as const,
          provenance: { ...prev.cached.provenance, freshness: 'stale' as const },
        }
      : null;

    const next: DawSession = {
      ...prev,
      observed: null,
      cached: staleCached,
      stale: true,
      stateFreshness: staleCached ? 'stale' : 'unknown',
      updatedAt: new Date().toISOString(),
    };
    this.#sessions.set(sessionId, next);
    this.#persistSessionHeader(next);
    this.#events?.emit('daw.session.stale', sessionId, { reason });
    return next;
  }

  evaluateFreshness(sessionId: string, nowMs = Date.now()): DawSession | null {
    const sess = this.#sessions.get(sessionId);
    if (!sess) return null;
    if (!sess.observed) return sess;

    const obsMs = Date.parse(sess.observed.provenance.observedAt);
    if (!Number.isNaN(obsMs) && nowMs - obsMs > this.#staleThresholdMs) {
      return this.markStale(sessionId, `observedAt exceeded stale threshold (${this.#staleThresholdMs}ms)`);
    }
    return sess;
  }

  setSavedProject(sessionId: string, savedProject: DawProject): DawSession {
    const prev = this.requireSession(sessionId);
    if (prev.observed) {
      this.#baselineDigestAtSave.set(sessionId, prev.observed.stateDigest);
    }
    const next: DawSession = {
      ...prev,
      project: savedProject,
      saved: savedProject,
      hasUnsavedLiveChanges: false,
      updatedAt: new Date().toISOString(),
    };
    this.#sessions.set(sessionId, next);
    this.#persistSessionHeader(next);
    return next;
  }

  addProposal(sessionId: string, command: DawCommand): DawSession {
    const prev = this.requireSession(sessionId);
    const next: DawSession = {
      ...prev,
      proposed: [...prev.proposed, command],
      updatedAt: new Date().toISOString(),
    };
    this.#sessions.set(sessionId, next);
    this.#events?.emit(
      'daw.command.proposed',
      sessionId,
      { commandId: command.commandId, kind: command.kind, capabilityId: command.capabilityId, targetRef: command.targetRef },
      command.requestedBy,
    );
    return next;
  }

  recordAppliedResult(sessionId: string, result: DawCommandResult): DawSession {
    const prev = this.requireSession(sessionId);
    const next: DawSession = {
      ...prev,
      proposed: prev.proposed.filter((p) => p.commandId !== result.commandId),
      applied: [...prev.applied, result],
      hasUnsavedLiveChanges: result.ok && result.stateFreshness === 'applied' ? true : prev.hasUnsavedLiveChanges,
      updatedAt: new Date().toISOString(),
    };
    this.#sessions.set(sessionId, next);
    this.#persistSessionHeader(next);
    return next;
  }

  #persistSessionHeader(session: DawSession): void {
    if (!this.#db || !this.#db.isOpen) return;
    const dbStatus =
      session.connection.status === 'closed'
        ? 'closed'
        : session.connection.status === 'disconnected'
          ? 'disconnected'
          : session.stale || session.connection.status === 'degraded_cached'
            ? 'stale'
            : 'connected';

    const cachePayload = session.cached
      ? {
          snapshotId: session.cached.snapshotId,
          freshness: session.stateFreshness,
          stale: session.stale,
          observedAt: session.cached.provenance.observedAt,
          transport: {
            playing: session.cached.transport.playing,
            bpm: session.cached.transport.tempo.bpm,
          },
          pluginsCount:
            session.cached.plugins.status === 'available' ? session.cached.plugins.value.length : null,
        }
      : null;

    this.#db.upsertDawSession({
      id: session.sessionId,
      adapterId: session.adapterId,
      hostVersion: session.hostVersion,
      projectPath: session.project.projectPath,
      savedSha256: session.saved?.savedSha256 ?? null,
      cachedSnapshot: cachePayload,
      status: dbStatus,
    });
  }
}

export type { DawStateFreshness };
