import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentClass, Domain } from '../contracts/taxonomy.ts';
import {
  inspectSqliteFile,
  quarantineSqliteArtifacts,
  restoreSqliteDatabase,
  type SqliteFileInspection,
  type SqliteRestoreReport,
} from './recovery.ts';
import { createRuntimeRepositories, type RuntimeRepositories } from './repositories.ts';
import {
  ALLOWED_RUNTIME_SQLITE_TABLES,
  applySqliteMigrations,
  FORBIDDEN_CANONICAL_SQLITE_TABLES,
  LATEST_SQLITE_SCHEMA_VERSION,
} from './schema-migrations.ts';

export type SqliteIntegrityReport = {
  readonly ok: boolean;
  readonly schemaVersion: number;
  readonly integrityCheck: string;
  readonly foreignKeyViolations: number;
  readonly tables: readonly string[];
  readonly views: readonly string[];
  readonly forbiddenTablesFound: readonly string[];
};

export type SqliteBackupReport = {
  readonly ok: boolean;
  readonly backupPath: string;
  readonly byteSize: number;
  readonly integrityOk: boolean;
  readonly createdAt: string;
};

export type AgentRunStatus = 'pending' | 'success' | 'error';

export type AgentRunRecord = {
  readonly id: string;
  readonly agentName: string;
  readonly class: AgentClass | null;
  readonly domain: Domain | null;
  readonly model: string | null;
  readonly input: unknown;
  readonly output: unknown;
  readonly tokensUsed: number | null;
  readonly latencyMs: number | null;
  readonly status: AgentRunStatus;
  readonly errorDetail: string | null;
  readonly jobId: string | null;
  readonly stepId: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
};

export type StartAgentRunInput = {
  readonly id?: string | undefined;
  readonly agentName: string;
  readonly class?: AgentClass | null | undefined;
  readonly domain?: Domain | null | undefined;
  readonly model?: string | null | undefined;
  readonly input: unknown;
  readonly jobId?: string | null | undefined;
  readonly stepId?: string | null | undefined;
};

export type CompleteAgentRunInput = {
  readonly output: unknown;
  readonly tokensUsed?: number | null | undefined;
  readonly latencyMs?: number | null | undefined;
  readonly model?: string | null | undefined;
};

export type FailAgentRunInput = {
  readonly errorDetail: string;
  readonly tokensUsed?: number | null | undefined;
  readonly latencyMs?: number | null | undefined;
  readonly model?: string | null | undefined;
};

export type JobKind = 'workflow' | 'research' | 'ingest' | 'index' | 'task';
export type JobStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled';

export type JobRecord = {
  readonly id: string;
  readonly kind: JobKind;
  readonly name: string;
  readonly specSha256: string | null;
  readonly input: unknown;
  readonly output: unknown;
  readonly status: JobStatus;
  readonly failedStep: string | null;
  readonly skippedSteps: readonly string[];
  readonly errorDetail: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
};

export type LockRecord = {
  readonly resourceKey: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
};

export type SessionSource = 'cli' | 'http' | 'voice' | 'ui';

export type SessionRecord = {
  readonly id: string;
  readonly operatorId: string;
  readonly source: SessionSource;
  readonly activeSector: string | null;
  readonly selectedJobId: string | null;
  readonly exchanges: readonly unknown[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type RuntimeEventRecord = {
  readonly id: number;
  readonly eventType: string;
  readonly domain: string;
  readonly actor: string;
  readonly targetPath: string | null;
  readonly payload: Record<string, unknown>;
  readonly checksumSha256: string | null;
  readonly createdAt: string;
};

export type ApprovalItemType =
  | 'knowledge_candidate'
  | 'split_proposal'
  | 'artifact_version'
  | 'critique_escalation'
  | 'rd_backlog_item'
  | 'vault_promotion';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type PendingApprovalRecord = {
  readonly id: string;
  readonly itemType: ApprovalItemType;
  readonly itemId: string;
  readonly status: ApprovalStatus;
  readonly request: Record<string, unknown>;
  readonly proposer: string;
  readonly approver: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
};

export type IndexEntryRecord = {
  readonly vaultPath: string;
  readonly sector: string;
  readonly fileExt: string;
  readonly byteSize: number;
  readonly mtimeMs: number;
  readonly sha256: string;
  readonly title: string;
  readonly domain: string | null;
  readonly docType: string | null;
  readonly status: string | null;
  readonly tags: readonly string[];
  readonly wikilinks: readonly {
    readonly target: string;
    readonly heading: string | null;
    readonly alias: string | null;
    readonly embed: boolean;
    readonly raw: string;
  }[];
  readonly frontmatter: Record<string, unknown>;
  readonly frontmatterError: string | null;
  readonly indexedAt: string;
};

export type UpsertIndexEntryInput = Omit<IndexEntryRecord, 'indexedAt'>;

export type DawSessionStatus = 'connected' | 'stale' | 'disconnected' | 'closed';
export type DawLeasePermission = 'observe' | 'analyze' | 'propose' | 'prepare' | 'execute' | 'rollback';
export type DawCommandStatus = 'prepared' | 'executed' | 'failed' | 'rolled_back' | 'denied';
export type DawAudioSourceKind = 'bounce_wav' | 'trace_vst' | 'browser_dsp';

export type DawSessionRecord = {
  readonly id: string;
  readonly adapterId: string;
  readonly hostVersion: string;
  readonly projectPath: string | null;
  readonly savedSha256: string | null;
  readonly cachedSnapshot: Record<string, unknown> | null;
  readonly cachedAt: string | null;
  readonly status: DawSessionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type DawSessionLeaseRecord = {
  readonly id: string;
  readonly sessionId: string;
  readonly maxPermission: DawLeasePermission;
  readonly grantedBy: string;
  readonly allowedTargets: readonly string[];
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly createdAt: string;
};

export type DawCommandJournalRecord = {
  readonly id: string;
  readonly sessionId: string;
  readonly approvalId: string | null;
  readonly capabilityId: string;
  readonly targetRef: string;
  readonly command: Record<string, unknown>;
  readonly beforeState: Record<string, unknown> | null;
  readonly afterState: Record<string, unknown> | null;
  readonly status: DawCommandStatus;
  readonly errorDetail: string | null;
  readonly executedAt: string;
};

export type DawAudioAnalysisRecord = {
  readonly id: string;
  readonly sessionId: string | null;
  readonly sourceKind: DawAudioSourceKind;
  readonly sourceSha256: string;
  readonly traceAnalysis: Record<string, unknown>;
  readonly traceReport: Record<string, unknown>;
  readonly createdAt: string;
};

export type SqliteRetentionPolicy = {
  readonly sessionMaxAgeDays?: number | undefined;
  readonly closedDawSessionMaxAgeDays?: number | undefined;
  readonly audioAnalysisMaxAgeDays?: number | undefined;
  readonly leaseExpiredGraceDays?: number | undefined;
  readonly referenceIso?: string | undefined;
};

export type SqliteRetentionReport = {
  readonly expiredLocksRemoved: number;
  readonly expiredLeasesPruned: number;
  readonly staleSessionsRemoved: number;
  readonly closedDawSessionsRemoved: number;
  readonly audioAnalysesRemoved: number;
  readonly retainedImmutableCounts: {
    readonly agentRuns: number;
    readonly jobs: number;
    readonly runtimeEvents: number;
    readonly pendingApprovals: number;
    readonly dawCommandJournal: number;
  };
  readonly executedAt: string;
};

export type SqliteRecoveryOpenResult = {
  readonly db: SqliteRuntimeDb;
  readonly recovered: boolean;
  readonly source: 'primary' | 'backup' | 'fresh-rebuild';
  readonly quarantinePath: string | null;
  readonly restoredFromBackupPath: string | null;
  readonly inspectionError: string | null;
};

const nowIso = (): string => new Date().toISOString();

const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/**
 * Local SQLite runtime database wrapper for XYP3RN OS 3.0.
 * Uses Node 22 built-in `node:sqlite` (DatabaseSync) with strict append-only and seal triggers.
 */
export class SqliteRuntimeDb {
  readonly #db: DatabaseSync;
  readonly #path: string;
  readonly #repositories: RuntimeRepositories;
  #isOpen = true;
  #txDepth = 0;

  constructor(dbPath = ':memory:') {
    this.#path = dbPath === ':memory:' ? ':memory:' : resolve(dbPath);
    if (this.#path !== ':memory:') {
      mkdirSync(dirname(this.#path), { recursive: true });
    }
    this.#db = new DatabaseSync(this.#path);
    this.#db.exec('PRAGMA foreign_keys = ON;');
    if (this.#path !== ':memory:') {
      this.#db.exec('PRAGMA journal_mode = WAL;');
    }
    this.#db.exec('PRAGMA synchronous = NORMAL;');
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec('PRAGMA temp_store = MEMORY;');
    applySqliteMigrations(this.#db);
    this.#repositories = createRuntimeRepositories(this);
  }

  get dbPath(): string {
    return this.#path;
  }

  get raw(): DatabaseSync {
    return this.#db;
  }

  get isOpen(): boolean {
    return this.#isOpen;
  }

  get repositories(): RuntimeRepositories {
    return this.#repositories;
  }

  close(): void {
    if (!this.#isOpen) return;
    this.#isOpen = false;
    this.#db.close();
  }

  /**
   * Executes `fn` inside a synchronous SQLite transaction (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`),
   * or a nested `SAVEPOINT` if already inside an active transaction.
   */
  transaction<T>(fn: () => T): T {
    const depth = this.#txDepth;
    const spName = `sp_os3_${depth}`;
    if (depth === 0) {
      this.#db.exec('BEGIN IMMEDIATE;');
    } else {
      this.#db.exec(`SAVEPOINT ${spName};`);
    }
    this.#txDepth += 1;
    try {
      const result = fn();
      this.#txDepth -= 1;
      if (depth === 0) {
        this.#db.exec('COMMIT;');
      } else {
        this.#db.exec(`RELEASE SAVEPOINT ${spName};`);
      }
      return result;
    } catch (err) {
      this.#txDepth -= 1;
      if (depth === 0) {
        this.#db.exec('ROLLBACK;');
      } else {
        this.#db.exec(`ROLLBACK TO SAVEPOINT ${spName};`);
        this.#db.exec(`RELEASE SAVEPOINT ${spName};`);
      }
      throw err;
    }
  }

  // ─── 1. Agent Runs ──────────────────────────────────────────────────────────

  startAgentRun(input: StartAgentRunInput): AgentRunRecord {
    const id = input.id ?? randomUUID();
    const createdAt = nowIso();
    this.#db
      .prepare(
        `INSERT INTO agent_runs (
          id, agent_name, class, domain, model, input_json, status, job_id, step_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        input.agentName,
        input.class ?? null,
        input.domain ?? null,
        input.model ?? null,
        JSON.stringify(input.input ?? null),
        input.jobId ?? null,
        input.stepId ?? null,
        createdAt,
      );
    return this.getAgentRun(id)!;
  }

  completeAgentRun(id: string, input: CompleteAgentRunInput): AgentRunRecord {
    const completedAt = nowIso();
    this.#db
      .prepare(
        `UPDATE agent_runs
         SET status = 'success',
             output_json = ?,
             tokens_used = ?,
             latency_ms = ?,
             model = COALESCE(?, model),
             completed_at = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(input.output ?? null),
        input.tokensUsed ?? null,
        input.latencyMs ?? null,
        input.model ?? null,
        completedAt,
        id,
      );
    return this.getAgentRun(id)!;
  }

  failAgentRun(id: string, input: FailAgentRunInput): AgentRunRecord {
    const completedAt = nowIso();
    const detail = input.errorDetail.trim() || 'unspecified error';
    this.#db
      .prepare(
        `UPDATE agent_runs
         SET status = 'error',
             error_detail = ?,
             tokens_used = ?,
             latency_ms = ?,
             model = COALESCE(?, model),
             completed_at = ?
         WHERE id = ?`,
      )
      .run(detail, input.tokensUsed ?? null, input.latencyMs ?? null, input.model ?? null, completedAt, id);
    return this.getAgentRun(id)!;
  }

  getAgentRun(id: string): AgentRunRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM agent_runs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.#mapAgentRun(row) : null;
  }

  listAgentRuns(limit = 50): readonly AgentRunRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.#mapAgentRun(r));
  }

  listAgentRunsByJob(jobId: string): readonly AgentRunRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM agent_runs WHERE job_id = ? ORDER BY created_at ASC')
      .all(jobId) as Record<string, unknown>[];
    return rows.map((r) => this.#mapAgentRun(r));
  }

  #mapAgentRun(row: Record<string, unknown>): AgentRunRecord {
    return {
      id: String(row.id),
      agentName: String(row.agent_name),
      class: (row.class as AgentClass | null) ?? null,
      domain: (row.domain as Domain | null) ?? null,
      model: (row.model as string | null) ?? null,
      input: parseJson(row.input_json as string | null, null),
      output: parseJson(row.output_json as string | null, null),
      tokensUsed: typeof row.tokens_used === 'number' ? row.tokens_used : null,
      latencyMs: typeof row.latency_ms === 'number' ? row.latency_ms : null,
      status: row.status as AgentRunStatus,
      errorDetail: (row.error_detail as string | null) ?? null,
      jobId: (row.job_id as string | null) ?? null,
      stepId: (row.step_id as string | null) ?? null,
      createdAt: String(row.created_at),
      completedAt: (row.completed_at as string | null) ?? null,
    };
  }

  // ─── 2. Jobs ────────────────────────────────────────────────────────────────

  enqueueJob(input: {
    readonly id?: string | undefined;
    readonly kind: JobKind;
    readonly name: string;
    readonly specSha256?: string | null | undefined;
    readonly input?: unknown;
    readonly startImmediately?: boolean | undefined;
  }): JobRecord {
    const id = input.id ?? randomUUID();
    const now = nowIso();
    const status: JobStatus = input.startImmediately ? 'running' : 'queued';
    this.#db
      .prepare(
        `INSERT INTO jobs (id, kind, name, spec_sha256, input_json, status, created_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.name,
        input.specSha256 ?? null,
        JSON.stringify(input.input ?? {}),
        status,
        now,
        input.startImmediately ? now : null,
      );
    return this.getJob(id)!;
  }

  startJob(id: string): JobRecord {
    const now = nowIso();
    this.#db
      .prepare(`UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`)
      .run(now, id);
    return this.getJob(id)!;
  }

  completeJob(id: string, output: unknown, skippedSteps: readonly string[] = []): JobRecord {
    const now = nowIso();
    this.#db
      .prepare(
        `UPDATE jobs
         SET status = 'success',
             output_json = ?,
             skipped_steps_json = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(output ?? null), JSON.stringify(skippedSteps), now, id);
    return this.getJob(id)!;
  }

  failJob(id: string, errorDetail: string, failedStep?: string | null): JobRecord {
    const now = nowIso();
    this.#db
      .prepare(
        `UPDATE jobs
         SET status = 'error',
             error_detail = ?,
             failed_step = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .run(errorDetail.trim() || 'job failed', failedStep ?? null, now, id);
    return this.getJob(id)!;
  }

  cancelJob(id: string, reason = 'cancelled by operator'): JobRecord {
    const now = nowIso();
    this.#db
      .prepare(
        `UPDATE jobs
         SET status = 'cancelled',
             error_detail = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .run(reason.trim() || 'cancelled', now, id);
    return this.getJob(id)!;
  }

  recoverStaleRunningJobs(
    reason = 'recovered stale running job after runtime restart',
    options: { readonly olderThanIso?: string | undefined } = {},
  ): readonly JobRecord[] {
    return this.transaction(() => {
      const runningRows = (
        options.olderThanIso
          ? this.#db.prepare(`SELECT id FROM jobs WHERE status = 'running' AND COALESCE(started_at, created_at) <= ?`).all(options.olderThanIso)
          : this.#db.prepare(`SELECT id FROM jobs WHERE status = 'running'`).all()
      ) as { id: string }[];

      const recovered: JobRecord[] = [];
      for (const r of runningRows) {
        recovered.push(this.failJob(r.id, reason, 'stale-recovery'));
      }
      if (recovered.length > 0) {
        this.appendEvent({
          eventType: 'runtime.jobs.recovered',
          domain: 'CORE',
          actor: 'runtime-watchdog',
          payload: {
            recoveredCount: recovered.length,
            jobIds: recovered.map((j) => j.id),
            reason,
          },
        });
      }
      return recovered;
    });
  }

  getJob(id: string): JobRecord | null {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.#mapJob(row) : null;
  }

  listJobs(limit = 50): readonly JobRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.#mapJob(r));
  }

  #mapJob(row: Record<string, unknown>): JobRecord {
    return {
      id: String(row.id),
      kind: row.kind as JobKind,
      name: String(row.name),
      specSha256: (row.spec_sha256 as string | null) ?? null,
      input: parseJson(row.input_json as string | null, {}),
      output: parseJson(row.output_json as string | null, null),
      status: row.status as JobStatus,
      failedStep: (row.failed_step as string | null) ?? null,
      skippedSteps: parseJson<string[]>(row.skipped_steps_json as string | null, []),
      errorDetail: (row.error_detail as string | null) ?? null,
      createdAt: String(row.created_at),
      startedAt: (row.started_at as string | null) ?? null,
      completedAt: (row.completed_at as string | null) ?? null,
    };
  }

  // ─── 3. Locks ───────────────────────────────────────────────────────────────

  acquireLock(resourceKey: string, ownerId: string, ttlMs = 30_000): boolean {
    return this.transaction(() => {
      const now = Date.now();
      const nowStr = new Date(now).toISOString();
      const expiresStr = new Date(now + Math.max(100, ttlMs)).toISOString();

      this.#db.prepare('DELETE FROM locks WHERE expires_at <= ?').run(nowStr);
      const existing = this.#db
        .prepare('SELECT owner_id FROM locks WHERE resource_key = ?')
        .get(resourceKey) as { owner_id: string } | undefined;

      if (existing && existing.owner_id !== ownerId) {
        return false;
      }

      this.#db
        .prepare(
          `INSERT INTO locks (resource_key, owner_id, acquired_at, expires_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(resource_key) DO UPDATE SET
             acquired_at = excluded.acquired_at,
             expires_at = excluded.expires_at
           WHERE locks.owner_id = excluded.owner_id`,
        )
        .run(resourceKey, ownerId, nowStr, expiresStr);
      return true;
    });
  }

  releaseLock(resourceKey: string, ownerId: string): boolean {
    const res = this.#db
      .prepare('DELETE FROM locks WHERE resource_key = ? AND owner_id = ?')
      .run(resourceKey, ownerId);
    return Number(res.changes) > 0;
  }

  renewLock(resourceKey: string, ownerId: string, ttlMs = 30_000): boolean {
    const now = Date.now();
    const expiresStr = new Date(now + Math.max(100, ttlMs)).toISOString();
    const res = this.#db
      .prepare('UPDATE locks SET expires_at = ? WHERE resource_key = ? AND owner_id = ?')
      .run(expiresStr, resourceKey, ownerId);
    return Number(res.changes) > 0;
  }

  listLocks(): readonly LockRecord[] {
    const nowStr = nowIso();
    this.#db.prepare('DELETE FROM locks WHERE expires_at <= ?').run(nowStr);
    const rows = this.#db
      .prepare('SELECT * FROM locks ORDER BY acquired_at ASC')
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      resourceKey: String(row.resource_key),
      ownerId: String(row.owner_id),
      acquiredAt: String(row.acquired_at),
      expiresAt: String(row.expires_at),
    }));
  }

  recoverStaleLocks(referenceIso?: string): {
    readonly recoveredCount: number;
    readonly resourceKeys: readonly string[];
  } {
    return this.transaction(() => {
      const cutoff = referenceIso ?? nowIso();
      const staleRows = this.#db
        .prepare('SELECT resource_key, owner_id FROM locks WHERE expires_at <= ?')
        .all(cutoff) as { resource_key: string; owner_id: string }[];

      if (staleRows.length === 0) {
        return { recoveredCount: 0, resourceKeys: [] };
      }

      const keys = staleRows.map((r) => String(r.resource_key));
      this.#db.prepare('DELETE FROM locks WHERE expires_at <= ?').run(cutoff);

      this.appendEvent({
        eventType: 'runtime.locks.recovered',
        domain: 'CORE',
        actor: 'runtime-watchdog',
        payload: {
          recoveredCount: keys.length,
          resourceKeys: keys,
          cutoff,
        },
      });

      return { recoveredCount: keys.length, resourceKeys: keys };
    });
  }

  getLock(resourceKey: string): LockRecord | null {
    const nowStr = nowIso();
    this.#db.prepare('DELETE FROM locks WHERE expires_at <= ?').run(nowStr);
    const row = this.#db
      .prepare('SELECT * FROM locks WHERE resource_key = ?')
      .get(resourceKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      resourceKey: String(row.resource_key),
      ownerId: String(row.owner_id),
      acquiredAt: String(row.acquired_at),
      expiresAt: String(row.expires_at),
    };
  }

  // ─── 4. Sessions ────────────────────────────────────────────────────────────

  upsertSession(input: {
    readonly id: string;
    readonly operatorId?: string | undefined;
    readonly source: SessionSource;
    readonly activeSector?: string | null | undefined;
    readonly selectedJobId?: string | null | undefined;
    readonly exchanges?: readonly unknown[] | undefined;
  }): SessionRecord {
    const now = nowIso();
    const existing = this.getSession(input.id);
    const exchanges = input.exchanges ?? existing?.exchanges ?? [];
    this.#db
      .prepare(
        `INSERT INTO sessions (id, operator_id, source, active_sector, selected_job_id, exchanges_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source = excluded.source,
           active_sector = excluded.active_sector,
           selected_job_id = excluded.selected_job_id,
           exchanges_json = excluded.exchanges_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.operatorId ?? 'owner',
        input.source,
        input.activeSector ?? null,
        input.selectedJobId ?? null,
        JSON.stringify(exchanges),
        existing?.createdAt ?? now,
        now,
      );
    return this.getSession(input.id)!;
  }

  appendSessionExchange(sessionId: string, exchange: unknown, maxExchanges = 60, source: SessionSource = 'ui'): SessionRecord {
    return this.transaction(() => {
      const current = this.getSession(sessionId);
      const next = [...(current?.exchanges ?? []), exchange].slice(-maxExchanges);
      return this.upsertSession({
        id: sessionId,
        operatorId: current?.operatorId ?? 'owner',
        source: current?.source ?? source,
        activeSector: current?.activeSector ?? null,
        selectedJobId: current?.selectedJobId ?? null,
        exchanges: next,
      });
    });
  }

  getSession(id: string): SessionRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      operatorId: String(row.operator_id),
      source: row.source as SessionSource,
      activeSector: (row.active_sector as string | null) ?? null,
      selectedJobId: (row.selected_job_id as string | null) ?? null,
      exchanges: parseJson<unknown[]>(row.exchanges_json as string | null, []),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listSessions(limit = 50): readonly SessionRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      operatorId: String(row.operator_id),
      source: row.source as SessionSource,
      activeSector: (row.active_sector as string | null) ?? null,
      selectedJobId: (row.selected_job_id as string | null) ?? null,
      exchanges: parseJson<unknown[]>(row.exchanges_json as string | null, []),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  // ─── 5. Runtime & Audit Events ──────────────────────────────────────────────

  appendEvent(input: {
    readonly eventType: string;
    readonly domain: string;
    readonly actor: string;
    readonly targetPath?: string | null | undefined;
    readonly payload?: Record<string, unknown> | undefined;
    readonly checksumSha256?: string | null | undefined;
  }): RuntimeEventRecord {
    const createdAt = nowIso();
    const res = this.#db
      .prepare(
        `INSERT INTO runtime_events (event_type, domain, actor, target_path, payload_json, checksum_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.eventType,
        input.domain,
        input.actor,
        input.targetPath ?? null,
        JSON.stringify(input.payload ?? {}),
        input.checksumSha256 ?? null,
        createdAt,
      );
    const id = Number(res.lastInsertRowid);
    const row = this.#db
      .prepare('SELECT * FROM runtime_events WHERE id = ?')
      .get(id) as Record<string, unknown>;
    return this.#mapEvent(row);
  }

  listEvents(options: { readonly afterId?: number | undefined; readonly eventType?: string | undefined; readonly limit?: number | undefined } = {}): readonly RuntimeEventRecord[] {
    const afterId = options.afterId ?? 0;
    const limit = options.limit ?? 100;
    if (options.eventType) {
      const rows = this.#db
        .prepare('SELECT * FROM runtime_events WHERE id > ? AND event_type = ? ORDER BY id ASC LIMIT ?')
        .all(afterId, options.eventType, limit) as Record<string, unknown>[];
      return rows.map((r) => this.#mapEvent(r));
    }
    const rows = this.#db
      .prepare('SELECT * FROM runtime_events WHERE id > ? ORDER BY id ASC LIMIT ?')
      .all(afterId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.#mapEvent(r));
  }

  #mapEvent(row: Record<string, unknown>): RuntimeEventRecord {
    return {
      id: Number(row.id),
      eventType: String(row.event_type),
      domain: String(row.domain),
      actor: String(row.actor),
      targetPath: (row.target_path as string | null) ?? null,
      payload: parseJson<Record<string, unknown>>(row.payload_json as string | null, {}),
      checksumSha256: (row.checksum_sha256 as string | null) ?? null,
      createdAt: String(row.created_at),
    };
  }

  // ─── 6. Pending Approvals (Promotion Gate & Human Queue) ────────────────────

  queueApproval(input: {
    readonly id?: string | undefined;
    readonly itemType: ApprovalItemType;
    readonly itemId: string;
    readonly request: Record<string, unknown>;
    readonly proposer: string;
  }): PendingApprovalRecord {
    const id = input.id ?? randomUUID();
    const createdAt = nowIso();
    this.#db
      .prepare(
        `INSERT INTO pending_approvals (id, item_type, item_id, status, request_json, proposer, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(id, input.itemType, input.itemId, JSON.stringify(input.request), input.proposer, createdAt);

    this.appendEvent({
      eventType: 'approval.queued',
      domain: 'GOVERNANCE',
      actor: input.proposer,
      payload: { approvalId: id, itemType: input.itemType, itemId: input.itemId },
    });

    return this.getApproval(id)!;
  }

  decideApproval(input: {
    readonly approvalId: string;
    readonly decision: 'approved' | 'rejected';
    readonly approver: string;
    readonly reason: string;
  }): PendingApprovalRecord {
    const decidedAt = nowIso();
    this.#db
      .prepare(
        `UPDATE pending_approvals
         SET status = ?,
             approver = ?,
             reason = ?,
             decided_at = ?
         WHERE id = ?`,
      )
      .run(input.decision, input.approver.trim(), input.reason.trim(), decidedAt, input.approvalId);

    const updated = this.getApproval(input.approvalId);
    if (!updated) {
      throw new Error(`approval not found: ${input.approvalId}`);
    }

    this.appendEvent({
      eventType: `approval.${input.decision}`,
      domain: 'GOVERNANCE',
      actor: input.approver.trim(),
      payload: {
        approvalId: updated.id,
        itemType: updated.itemType,
        itemId: updated.itemId,
        reason: input.reason.trim(),
      },
    });

    return updated;
  }

  getApproval(id: string): PendingApprovalRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM pending_approvals WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.#mapApproval(row) : null;
  }

  listApprovals(status?: ApprovalStatus): readonly PendingApprovalRecord[] {
    if (status) {
      const rows = this.#db
        .prepare('SELECT * FROM pending_approvals WHERE status = ? ORDER BY created_at ASC')
        .all(status) as Record<string, unknown>[];
      return rows.map((r) => this.#mapApproval(r));
    }
    const rows = this.#db
      .prepare('SELECT * FROM pending_approvals ORDER BY created_at DESC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.#mapApproval(r));
  }

  #mapApproval(row: Record<string, unknown>): PendingApprovalRecord {
    return {
      id: String(row.id),
      itemType: row.item_type as ApprovalItemType,
      itemId: String(row.item_id),
      status: row.status as ApprovalStatus,
      request: parseJson<Record<string, unknown>>(row.request_json as string | null, {}),
      proposer: String(row.proposer),
      approver: (row.approver as string | null) ?? null,
      reason: (row.reason as string | null) ?? null,
      createdAt: String(row.created_at),
      decidedAt: (row.decided_at as string | null) ?? null,
    };
  }

  // ─── 7. Index State (Disposable Structural Cache) ───────────────────────────

  upsertIndexEntry(entry: UpsertIndexEntryInput): IndexEntryRecord {
    const indexedAt = nowIso();
    this.#db
      .prepare(
        `INSERT INTO index_state (
          vault_path, sector, file_ext, byte_size, mtime_ms, sha256,
          title, domain, doc_type, status, tags_json, wikilinks_json,
          frontmatter_json, frontmatter_error, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(vault_path) DO UPDATE SET
          sector = excluded.sector,
          file_ext = excluded.file_ext,
          byte_size = excluded.byte_size,
          mtime_ms = excluded.mtime_ms,
          sha256 = excluded.sha256,
          title = excluded.title,
          domain = excluded.domain,
          doc_type = excluded.doc_type,
          status = excluded.status,
          tags_json = excluded.tags_json,
          wikilinks_json = excluded.wikilinks_json,
          frontmatter_json = excluded.frontmatter_json,
          frontmatter_error = excluded.frontmatter_error,
          indexed_at = excluded.indexed_at`,
      )
      .run(
        entry.vaultPath,
        entry.sector,
        entry.fileExt,
        entry.byteSize,
        entry.mtimeMs,
        entry.sha256,
        entry.title,
        entry.domain,
        entry.docType,
        entry.status,
        JSON.stringify(entry.tags),
        JSON.stringify(entry.wikilinks),
        JSON.stringify(entry.frontmatter),
        entry.frontmatterError,
        indexedAt,
      );
    return this.getIndexEntry(entry.vaultPath)!;
  }

  removeIndexEntry(vaultPath: string): boolean {
    const res = this.#db.prepare('DELETE FROM index_state WHERE vault_path = ?').run(vaultPath);
    return Number(res.changes) > 0;
  }

  getIndexEntry(vaultPath: string): IndexEntryRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM index_state WHERE vault_path = ?')
      .get(vaultPath) as Record<string, unknown> | undefined;
    return row ? this.#mapIndexEntry(row) : null;
  }

  searchIndex(query: string, options: { readonly sector?: string | undefined; readonly limit?: number | undefined } = {}): readonly IndexEntryRecord[] {
    const limit = options.limit ?? 25;
    const needle = `%${query.trim().toLowerCase()}%`;
    if (options.sector) {
      const rows = this.#db
        .prepare(
          `SELECT * FROM index_state
           WHERE sector = ?
             AND (lower(title) LIKE ? OR lower(vault_path) LIKE ? OR lower(tags_json) LIKE ?)
           ORDER BY title ASC
           LIMIT ?`,
        )
        .all(options.sector, needle, needle, needle, limit) as Record<string, unknown>[];
      return rows.map((r) => this.#mapIndexEntry(r));
    }
    const rows = this.#db
      .prepare(
        `SELECT * FROM index_state
         WHERE lower(title) LIKE ? OR lower(vault_path) LIKE ? OR lower(tags_json) LIKE ?
         ORDER BY title ASC
         LIMIT ?`,
      )
      .all(needle, needle, needle, limit) as Record<string, unknown>[];
    return rows.map((r) => this.#mapIndexEntry(r));
  }

  listIndexEntries(sector?: string, limit = 500): readonly IndexEntryRecord[] {
    if (sector) {
      const rows = this.#db
        .prepare('SELECT * FROM index_state WHERE sector = ? ORDER BY vault_path ASC LIMIT ?')
        .all(sector, limit) as Record<string, unknown>[];
      return rows.map((r) => this.#mapIndexEntry(r));
    }
    const rows = this.#db
      .prepare('SELECT * FROM index_state ORDER BY vault_path ASC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.#mapIndexEntry(r));
  }

  getIndexStats(): { readonly totalFiles: number; readonly bySector: Readonly<Record<string, number>> } {
    const totalRow = this.#db.prepare('SELECT COUNT(*) as c FROM index_state').get() as { c: number };
    const sectorRows = this.#db
      .prepare('SELECT sector, COUNT(*) as c FROM index_state GROUP BY sector ORDER BY sector ASC')
      .all() as { sector: string; c: number }[];
    const bySector: Record<string, number> = {};
    for (const r of sectorRows) {
      bySector[r.sector] = Number(r.c);
    }
    return { totalFiles: Number(totalRow.c), bySector };
  }

  setIndexMeta(key: string, value: unknown): void {
    this.#db
      .prepare(
        `INSERT INTO index_meta (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), nowIso());
  }

  getIndexMeta<T = unknown>(key: string): T | null {
    const row = this.#db
      .prepare('SELECT value_json FROM index_meta WHERE key = ?')
      .get(key) as { value_json: string } | undefined;
    return row ? parseJson<T | null>(row.value_json, null) : null;
  }

  #mapIndexEntry(row: Record<string, unknown>): IndexEntryRecord {
    return {
      vaultPath: String(row.vault_path),
      sector: String(row.sector),
      fileExt: String(row.file_ext),
      byteSize: Number(row.byte_size),
      mtimeMs: Number(row.mtime_ms),
      sha256: String(row.sha256),
      title: String(row.title),
      domain: (row.domain as string | null) ?? null,
      docType: (row.doc_type as string | null) ?? null,
      status: (row.status as string | null) ?? null,
      tags: parseJson<string[]>(row.tags_json as string | null, []),
      wikilinks: parseJson(row.wikilinks_json as string | null, []),
      frontmatter: parseJson<Record<string, unknown>>(row.frontmatter_json as string | null, {}),
      frontmatterError: (row.frontmatter_error as string | null) ?? null,
      indexedAt: String(row.indexed_at),
    };
  }

  // ─── 8. Approved DAW Runtime Entities (`OS3_DATA_ARCHITECTURE.md` §4) ───────

  upsertDawSession(input: {
    readonly id?: string | undefined;
    readonly adapterId: string;
    readonly hostVersion: string;
    readonly projectPath?: string | null | undefined;
    readonly savedSha256?: string | null | undefined;
    readonly cachedSnapshot?: Record<string, unknown> | null | undefined;
    readonly cachedAt?: string | null | undefined;
    readonly status: DawSessionStatus;
  }): DawSessionRecord {
    return this.transaction(() => {
      const id = input.id ?? randomUUID();
      const now = nowIso();
      const existing = this.getDawSession(id);
      const cachedAt =
        input.cachedAt !== undefined
          ? input.cachedAt
          : input.cachedSnapshot !== undefined
            ? now
            : (existing?.cachedAt ?? null);
      this.#db
        .prepare(
          `INSERT INTO daw_sessions (
            id, adapter_id, host_version, project_path, saved_sha256,
            cached_snapshot_json, cached_at, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            adapter_id = excluded.adapter_id,
            host_version = excluded.host_version,
            project_path = COALESCE(excluded.project_path, daw_sessions.project_path),
            saved_sha256 = COALESCE(excluded.saved_sha256, daw_sessions.saved_sha256),
            cached_snapshot_json = COALESCE(excluded.cached_snapshot_json, daw_sessions.cached_snapshot_json),
            cached_at = COALESCE(excluded.cached_at, daw_sessions.cached_at),
            status = excluded.status,
            updated_at = excluded.updated_at`,
        )
        .run(
          id,
          input.adapterId,
          input.hostVersion,
          input.projectPath ?? null,
          input.savedSha256 ?? null,
          input.cachedSnapshot !== undefined && input.cachedSnapshot !== null
            ? JSON.stringify(input.cachedSnapshot)
            : null,
          cachedAt,
          input.status,
          existing?.createdAt ?? now,
          now,
        );
      return this.getDawSession(id)!;
    });
  }

  getDawSession(id: string): DawSessionRecord | null {
    const row = this.#db.prepare('SELECT * FROM daw_sessions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#mapDawSession(row) : null;
  }

  listDawSessions(status?: DawSessionStatus, limit = 50): readonly DawSessionRecord[] {
    const rows = status
      ? (this.#db
          .prepare('SELECT * FROM daw_sessions WHERE status = ? ORDER BY updated_at DESC LIMIT ?')
          .all(status, limit) as Record<string, unknown>[])
      : (this.#db
          .prepare('SELECT * FROM daw_sessions ORDER BY updated_at DESC LIMIT ?')
          .all(limit) as Record<string, unknown>[]);
    return rows.map((r) => this.#mapDawSession(r));
  }

  markDawSessionStatus(id: string, status: DawSessionStatus): DawSessionRecord {
    const now = nowIso();
    this.#db.prepare('UPDATE daw_sessions SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
    const updated = this.getDawSession(id);
    if (!updated) throw new Error(`DAW session not found: ${id}`);
    return updated;
  }

  #mapDawSession(row: Record<string, unknown>): DawSessionRecord {
    return {
      id: String(row.id),
      adapterId: String(row.adapter_id),
      hostVersion: String(row.host_version),
      projectPath: (row.project_path as string | null) ?? null,
      savedSha256: (row.saved_sha256 as string | null) ?? null,
      cachedSnapshot: parseJson<Record<string, unknown> | null>(row.cached_snapshot_json as string | null, null),
      cachedAt: (row.cached_at as string | null) ?? null,
      status: row.status as DawSessionStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  grantDawLease(input: {
    readonly id?: string | undefined;
    readonly sessionId: string;
    readonly maxPermission: DawLeasePermission;
    readonly grantedBy: string;
    readonly allowedTargets?: readonly string[] | undefined;
    readonly ttlMs?: number | undefined;
  }): DawSessionLeaseRecord {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + Math.max(500, input.ttlMs ?? 300_000)).toISOString();
    this.#db
      .prepare(
        `INSERT INTO daw_session_leases (
          id, session_id, max_permission, granted_by, allowed_targets_json, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.maxPermission,
        input.grantedBy.trim(),
        JSON.stringify(input.allowedTargets ?? []),
        expiresAt,
        createdAt,
      );
    return this.getDawLease(id)!;
  }

  getDawLease(id: string): DawSessionLeaseRecord | null {
    const row = this.#db.prepare('SELECT * FROM daw_session_leases WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#mapDawLease(row) : null;
  }

  getActiveDawLease(sessionId: string, referenceIso?: string): DawSessionLeaseRecord | null {
    const ref = referenceIso ?? nowIso();
    const row = this.#db
      .prepare(
        `SELECT * FROM daw_session_leases
         WHERE session_id = ?
           AND revoked_at IS NULL
           AND expires_at > ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(sessionId, ref) as Record<string, unknown> | undefined;
    return row ? this.#mapDawLease(row) : null;
  }

  revokeDawLease(id: string): boolean {
    const now = nowIso();
    const res = this.#db
      .prepare('UPDATE daw_session_leases SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
      .run(now, id);
    return Number(res.changes) > 0;
  }

  listDawLeases(sessionId: string): readonly DawSessionLeaseRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM daw_session_leases WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => this.#mapDawLease(r));
  }

  #mapDawLease(row: Record<string, unknown>): DawSessionLeaseRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      maxPermission: row.max_permission as DawLeasePermission,
      grantedBy: String(row.granted_by),
      allowedTargets: parseJson<string[]>(row.allowed_targets_json as string | null, []),
      expiresAt: String(row.expires_at),
      revokedAt: (row.revoked_at as string | null) ?? null,
      createdAt: String(row.created_at),
    };
  }

  appendDawCommand(input: {
    readonly id?: string | undefined;
    readonly sessionId: string;
    readonly approvalId?: string | null | undefined;
    readonly capabilityId: string;
    readonly targetRef: string;
    readonly command: Record<string, unknown>;
    readonly beforeState?: Record<string, unknown> | null | undefined;
    readonly afterState?: Record<string, unknown> | null | undefined;
    readonly status: DawCommandStatus;
    readonly errorDetail?: string | null | undefined;
  }): DawCommandJournalRecord {
    const id = input.id ?? randomUUID();
    const executedAt = nowIso();
    this.#db
      .prepare(
        `INSERT INTO daw_command_journal (
          id, session_id, approval_id, capability_id, target_ref,
          command_json, before_state_json, after_state_json, status, error_detail, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.approvalId ?? null,
        input.capabilityId,
        input.targetRef,
        JSON.stringify(input.command),
        input.beforeState !== undefined && input.beforeState !== null ? JSON.stringify(input.beforeState) : null,
        input.afterState !== undefined && input.afterState !== null ? JSON.stringify(input.afterState) : null,
        input.status,
        input.errorDetail ?? null,
        executedAt,
      );
    return this.getDawCommand(id)!;
  }

  getDawCommand(id: string): DawCommandJournalRecord | null {
    const row = this.#db.prepare('SELECT * FROM daw_command_journal WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#mapDawCommand(row) : null;
  }

  listDawCommandsBySession(sessionId: string, limit = 100): readonly DawCommandJournalRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM daw_command_journal WHERE session_id = ? ORDER BY executed_at DESC LIMIT ?')
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.#mapDawCommand(r));
  }

  #mapDawCommand(row: Record<string, unknown>): DawCommandJournalRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      approvalId: (row.approval_id as string | null) ?? null,
      capabilityId: String(row.capability_id),
      targetRef: String(row.target_ref),
      command: parseJson<Record<string, unknown>>(row.command_json as string | null, {}),
      beforeState: parseJson<Record<string, unknown> | null>(row.before_state_json as string | null, null),
      afterState: parseJson<Record<string, unknown> | null>(row.after_state_json as string | null, null),
      status: row.status as DawCommandStatus,
      errorDetail: (row.error_detail as string | null) ?? null,
      executedAt: String(row.executed_at),
    };
  }

  recordDawAudioAnalysis(input: {
    readonly id?: string | undefined;
    readonly sessionId?: string | null | undefined;
    readonly sourceKind: DawAudioSourceKind;
    readonly sourceSha256: string;
    readonly traceAnalysis: Record<string, unknown>;
    readonly traceReport: Record<string, unknown>;
  }): DawAudioAnalysisRecord {
    const id = input.id ?? randomUUID();
    const createdAt = nowIso();
    this.#db
      .prepare(
        `INSERT INTO daw_audio_analyses (
          id, session_id, source_kind, source_sha256, trace_analysis_json, trace_report_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId ?? null,
        input.sourceKind,
        input.sourceSha256,
        JSON.stringify(input.traceAnalysis),
        JSON.stringify(input.traceReport),
        createdAt,
      );
    return this.getDawAudioAnalysis(id)!;
  }

  getDawAudioAnalysis(id: string): DawAudioAnalysisRecord | null {
    const row = this.#db.prepare('SELECT * FROM daw_audio_analyses WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#mapDawAudioAnalysis(row) : null;
  }

  listDawAudioAnalyses(options: { readonly sessionId?: string | undefined; readonly limit?: number | undefined } = {}): readonly DawAudioAnalysisRecord[] {
    const limit = options.limit ?? 50;
    const rows = options.sessionId
      ? (this.#db
          .prepare('SELECT * FROM daw_audio_analyses WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(options.sessionId, limit) as Record<string, unknown>[])
      : (this.#db
          .prepare('SELECT * FROM daw_audio_analyses ORDER BY created_at DESC LIMIT ?')
          .all(limit) as Record<string, unknown>[]);
    return rows.map((r) => this.#mapDawAudioAnalysis(r));
  }

  #mapDawAudioAnalysis(row: Record<string, unknown>): DawAudioAnalysisRecord {
    return {
      id: String(row.id),
      sessionId: (row.session_id as string | null) ?? null,
      sourceKind: row.source_kind as DawAudioSourceKind,
      sourceSha256: String(row.source_sha256),
      traceAnalysis: parseJson<Record<string, unknown>>(row.trace_analysis_json as string | null, {}),
      traceReport: parseJson<Record<string, unknown>>(row.trace_report_json as string | null, {}),
      createdAt: String(row.created_at),
    };
  }

  // ─── 9. Retention Policy (Prunes Disposable State Only; Preserves Immutable Audit History) ─

  pruneRuntimeState(policy: SqliteRetentionPolicy = {}): SqliteRetentionReport {
    return this.transaction(() => {
      const refMs = policy.referenceIso ? Date.parse(policy.referenceIso) : Date.now();
      const refIso = new Date(refMs).toISOString();
      const dayMs = 86_400_000;

      const leaseCutoff = new Date(refMs - Math.max(0, policy.leaseExpiredGraceDays ?? 7) * dayMs).toISOString();
      const sessionCutoff = new Date(refMs - Math.max(0, policy.sessionMaxAgeDays ?? 30) * dayMs).toISOString();
      const dawSessionCutoff = new Date(
        refMs - Math.max(0, policy.closedDawSessionMaxAgeDays ?? 30) * dayMs,
      ).toISOString();
      const audioCutoff = new Date(
        refMs - Math.max(0, policy.audioAnalysisMaxAgeDays ?? 30) * dayMs,
      ).toISOString();

      const lockRes = this.#db.prepare('DELETE FROM locks WHERE expires_at <= ?').run(refIso);
      const leaseRes = this.#db
        .prepare(
          `DELETE FROM daw_session_leases
           WHERE expires_at <= ?
              OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
        )
        .run(leaseCutoff, leaseCutoff);
      const sessionRes = this.#db.prepare('DELETE FROM sessions WHERE updated_at <= ?').run(sessionCutoff);
      const audioRes = this.#db.prepare('DELETE FROM daw_audio_analyses WHERE created_at <= ?').run(audioCutoff);
      const dawSessRes = this.#db
        .prepare(
          `DELETE FROM daw_sessions
           WHERE status IN ('closed', 'disconnected')
             AND updated_at <= ?
             AND NOT EXISTS (SELECT 1 FROM daw_command_journal j WHERE j.session_id = daw_sessions.id)`,
        )
        .run(dawSessionCutoff);

      const countTable = (tbl: string): number =>
        Number((this.#db.prepare(`SELECT COUNT(*) as c FROM ${tbl}`).get() as { c: number }).c);

      const report: SqliteRetentionReport = {
        expiredLocksRemoved: Number(lockRes.changes),
        expiredLeasesPruned: Number(leaseRes.changes),
        staleSessionsRemoved: Number(sessionRes.changes),
        closedDawSessionsRemoved: Number(dawSessRes.changes),
        audioAnalysesRemoved: Number(audioRes.changes),
        retainedImmutableCounts: {
          agentRuns: countTable('agent_runs'),
          jobs: countTable('jobs'),
          runtimeEvents: countTable('runtime_events'),
          pendingApprovals: countTable('pending_approvals'),
          dawCommandJournal: countTable('daw_command_journal'),
        },
        executedAt: refIso,
      };

      this.appendEvent({
        eventType: 'runtime.retention.pruned',
        domain: 'CORE',
        actor: 'runtime-retention',
        payload: report,
      });

      return report;
    });
  }

  // ─── 10. Database Integrity Checks, Online Backup & Recovery ────────────────

  checkIntegrity(): SqliteIntegrityReport {
    const integrityRows = this.#db.prepare('PRAGMA integrity_check;').all() as Record<string, unknown>[];
    const firstMsg = String(Object.values(integrityRows[0] ?? {})[0] ?? 'unknown');

    const fkRows = this.#db.prepare('PRAGMA foreign_key_check;').all() as Record<string, unknown>[];
    const masterRows = this.#db
      .prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`)
      .all() as { name: string; type: string }[];

    const tables = masterRows.filter((r) => r.type === 'table').map((r) => String(r.name));
    const views = masterRows.filter((r) => r.type === 'view').map((r) => String(r.name));

    const forbiddenSet = new Set<string>(FORBIDDEN_CANONICAL_SQLITE_TABLES);
    const allowedSet = new Set<string>(ALLOWED_RUNTIME_SQLITE_TABLES);
    const forbiddenTablesFound = tables.filter((t) => forbiddenSet.has(t) || !allowedSet.has(t));

    const verRow = this.#db.prepare('SELECT MAX(version) as v FROM schema_meta').get() as { v: number | null };
    const schemaVersion = Number(verRow?.v ?? 0);

    const ok =
      firstMsg.toLowerCase() === 'ok' &&
      fkRows.length === 0 &&
      forbiddenTablesFound.length === 0 &&
      schemaVersion >= LATEST_SQLITE_SCHEMA_VERSION;

    return {
      ok,
      schemaVersion,
      integrityCheck: firstMsg,
      foreignKeyViolations: fkRows.length,
      tables,
      views,
      forbiddenTablesFound,
    };
  }

  backupDatabase(destPathInput: string): SqliteBackupReport {
    const backupPath = resolve(destPathInput);
    mkdirSync(dirname(backupPath), { recursive: true });
    rmSync(backupPath, { force: true });

    if (this.#path !== ':memory:') {
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    }

    const escaped = backupPath.replace(/'/g, "''");
    this.#db.exec(`VACUUM INTO '${escaped}';`);

    const st = statSync(backupPath);
    const verifyDb = new DatabaseSync(backupPath, { readOnly: true });
    let integrityOk = false;
    try {
      const checkRow = verifyDb.prepare('PRAGMA integrity_check;').get() as Record<string, unknown> | undefined;
      integrityOk = String(Object.values(checkRow ?? {})[0] ?? '').toLowerCase() === 'ok';
    } finally {
      verifyDb.close();
    }

    const createdAt = nowIso();
    this.appendEvent({
      eventType: 'runtime.db.backup',
      domain: 'CORE',
      actor: 'runtime-backup',
      targetPath: backupPath,
      payload: {
        byteSize: st.size,
        integrityOk,
      },
    });

    return {
      ok: integrityOk && st.size > 0,
      backupPath,
      byteSize: st.size,
      integrityOk,
      createdAt,
    };
  }
}

export const openRuntimeDb = (dbPath = ':memory:'): SqliteRuntimeDb => new SqliteRuntimeDb(dbPath);

/**
 * Opens an on-disk SQLite runtime store with automatic corruption detection,
 * artifact quarantine, backup restoration, or clean runtime rebuild.
 */
export const openRuntimeDbWithRecovery = (
  dbPath: string,
  options: {
    readonly backupPaths?: readonly string[] | undefined;
    readonly quarantineDir?: string | undefined;
  } = {},
): SqliteRecoveryOpenResult => {
  if (dbPath === ':memory:') {
    return {
      db: openRuntimeDb(':memory:'),
      recovered: false,
      source: 'primary',
      quarantinePath: null,
      restoredFromBackupPath: null,
      inspectionError: null,
    };
  }

  const targetAbs = resolve(dbPath);
  let inspectionError: string | null = null;

  if (existsSync(targetAbs)) {
    const check = inspectSqliteFile(targetAbs);
    if (!check.corrupt && (check.ok || check.schemaVersion === 0)) {
      try {
        const db = openRuntimeDb(targetAbs);
        if (db.checkIntegrity().ok) {
          return {
            db,
            recovered: false,
            source: 'primary',
            quarantinePath: null,
            restoredFromBackupPath: null,
            inspectionError: null,
          };
        }
        inspectionError = 'Database integrity or schema check failed after open';
        db.close();
      } catch (err) {
        inspectionError = (err as Error).message;
      }
    } else {
      inspectionError = check.error ?? check.integrityCheck;
    }

    // Primary DB on disk is corrupted: quarantine it before recovery so evidence is preserved
    const quarantinePath = quarantineSqliteArtifacts(targetAbs, options.quarantineDir);

    for (const candidateBackup of options.backupPaths ?? []) {
      const bCheck = inspectSqliteFile(candidateBackup);
      if (bCheck.exists && bCheck.ok && !bCheck.corrupt) {
        const restored = restoreSqliteDatabase({
          backupPath: candidateBackup,
          targetPath: targetAbs,
          quarantineDir: options.quarantineDir,
        });
        const db = openRuntimeDb(targetAbs);
        db.appendEvent({
          eventType: 'runtime.db.recovered',
          domain: 'CORE',
          actor: 'runtime-recovery',
          targetPath: targetAbs,
          payload: {
            source: 'backup',
            backupPath: restored.backupPath,
            quarantinePath,
            inspectionError,
          },
        });
        return {
          db,
          recovered: true,
          source: 'backup',
          quarantinePath,
          restoredFromBackupPath: restored.backupPath,
          inspectionError,
        };
      }
    }

    const freshDb = openRuntimeDb(targetAbs);
    freshDb.appendEvent({
      eventType: 'runtime.db.recovered',
      domain: 'CORE',
      actor: 'runtime-recovery',
      targetPath: targetAbs,
      payload: {
        source: 'fresh-rebuild',
        quarantinePath,
        inspectionError,
      },
    });
    return {
      db: freshDb,
      recovered: true,
      source: 'fresh-rebuild',
      quarantinePath,
      restoredFromBackupPath: null,
      inspectionError,
    };
  }

  return {
    db: openRuntimeDb(targetAbs),
    recovered: false,
    source: 'primary',
    quarantinePath: null,
    restoredFromBackupPath: null,
    inspectionError: null,
  };
};

export {
  ALLOWED_RUNTIME_SQLITE_TABLES,
  FORBIDDEN_CANONICAL_SQLITE_TABLES,
  LATEST_SQLITE_SCHEMA_VERSION,
  applySqliteMigrations,
  inspectSqliteFile,
  quarantineSqliteArtifacts,
  restoreSqliteDatabase,
  type SqliteFileInspection,
  type SqliteRestoreReport,
};
