import type { RuntimeEventRecord, SqliteRuntimeDb } from '../sqlite/client.ts';

export type VaultAuditOperation =
  | 'read'
  | 'readMetadata'
  | 'list'
  | 'search'
  | 'write'
  | 'update'
  | 'append'
  | 'validate'
  | 'link'
  | 'backlinks'
  | 'history'
  | 'restore'
  | 'promote'
  | 'snapshot';

export type VaultAuditResultStatus = 'success' | 'denied' | 'conflict' | 'invalid' | 'error';

export type VaultAuditRecord = {
  readonly id: string;
  readonly actor: string;
  readonly operation: VaultAuditOperation;
  readonly entityId: string | null;
  readonly filePath: string;
  readonly previousChecksum: string | null;
  readonly newChecksum: string | null;
  readonly reason: string;
  readonly timestamp: string;
  readonly result: VaultAuditResultStatus;
};

export type RecordVaultAuditInput = {
  readonly actor: string;
  readonly operation: VaultAuditOperation;
  readonly entityId?: string | null | undefined;
  readonly filePath: string;
  readonly previousChecksum?: string | null | undefined;
  readonly newChecksum?: string | null | undefined;
  readonly reason: string;
  readonly result: VaultAuditResultStatus;
  readonly domain?: string | undefined;
  readonly extra?: Record<string, unknown> | undefined;
};

/**
 * Immutable audit logger for all VaultEngine operations, backed by the append-only
 * `runtime_events` table in local SQLite.
 */
export class VaultAuditLogger {
  readonly #db: SqliteRuntimeDb | null;
  readonly #fallbackRecords: VaultAuditRecord[] = [];

  constructor(db?: SqliteRuntimeDb | null) {
    this.#db = db ?? null;
  }

  #isDbReady(): boolean {
    return Boolean(this.#db && this.#db.isOpen);
  }

  record(input: RecordVaultAuditInput): VaultAuditRecord {
    const entityId = input.entityId ?? null;
    const previousChecksum = input.previousChecksum ?? null;
    const newChecksum = input.newChecksum ?? null;

    if (this.#isDbReady() && this.#db) {
      try {
        const event: RuntimeEventRecord = this.#db.appendEvent({
          eventType: 'vault.audit',
          domain: input.domain ?? 'KNOWLEDGE',
          actor: input.actor,
          targetPath: input.filePath,
          checksumSha256: newChecksum ?? previousChecksum ?? undefined,
          payload: {
            auditVersion: 1,
            operation: input.operation,
            entityId,
            filePath: input.filePath,
            previousChecksum,
            newChecksum,
            reason: input.reason,
            result: input.result,
            ...(input.extra ?? {}),
          },
        });

        return {
          id: String(event.id),
          actor: event.actor,
          operation: input.operation,
          entityId,
          filePath: input.filePath,
          previousChecksum,
          newChecksum,
          reason: input.reason,
          timestamp: event.createdAt,
          result: input.result,
        };
      } catch {
        // Fallback to in-memory audit log if SQLite is unavailable
      }
    }

    const fallback: VaultAuditRecord = {
      id: `mem-${this.#fallbackRecords.length + 1}`,
      actor: input.actor,
      operation: input.operation,
      entityId,
      filePath: input.filePath,
      previousChecksum,
      newChecksum,
      reason: input.reason,
      timestamp: new Date().toISOString(),
      result: input.result,
    };
    this.#fallbackRecords.unshift(fallback);
    return fallback;
  }

  list(filter?: {
    readonly filePath?: string | undefined;
    readonly actor?: string | undefined;
    readonly operation?: VaultAuditOperation | undefined;
    readonly result?: VaultAuditResultStatus | undefined;
    readonly limit?: number | undefined;
  }): readonly VaultAuditRecord[] {
    if (!this.#isDbReady() || !this.#db) {
      return this.#fallbackRecords.filter((rec) => {
        if (filter?.filePath && rec.filePath !== filter.filePath) return false;
        if (filter?.actor && rec.actor !== filter.actor) return false;
        if (filter?.operation && rec.operation !== filter.operation) return false;
        if (filter?.result && rec.result !== filter.result) return false;
        return true;
      }).slice(0, filter?.limit ?? 100);
    }

    const rawEvents = this.#db.listEvents({ limit: filter?.limit ? filter.limit * 4 : 400 });
    const records: VaultAuditRecord[] = [];

    for (const ev of rawEvents) {
      if (ev.eventType !== 'vault.audit') continue;
      const p = ev.payload;
      if (p.auditVersion !== 1) continue;

      const rec: VaultAuditRecord = {
        id: String(ev.id),
        actor: ev.actor,
        operation: p.operation as VaultAuditOperation,
        entityId: typeof p.entityId === 'string' ? p.entityId : null,
        filePath: typeof p.filePath === 'string' ? p.filePath : (ev.targetPath ?? ''),
        previousChecksum: typeof p.previousChecksum === 'string' ? p.previousChecksum : null,
        newChecksum: typeof p.newChecksum === 'string' ? p.newChecksum : null,
        reason: typeof p.reason === 'string' ? p.reason : '',
        timestamp: ev.createdAt,
        result: (p.result as VaultAuditResultStatus) ?? 'success',
      };

      if (filter?.filePath && rec.filePath !== filter.filePath) continue;
      if (filter?.actor && rec.actor !== filter.actor) continue;
      if (filter?.operation && rec.operation !== filter.operation) continue;
      if (filter?.result && rec.result !== filter.result) continue;

      records.push(rec);
      if (filter?.limit && records.length >= filter.limit) break;
    }

    return records;
  }
}
