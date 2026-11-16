import type {
  AgentRunRecord,
  ApprovalItemType,
  ApprovalStatus,
  CompleteAgentRunInput,
  DawAudioAnalysisRecord,
  DawAudioSourceKind,
  DawCommandJournalRecord,
  DawCommandStatus,
  DawLeasePermission,
  DawSessionLeaseRecord,
  DawSessionRecord,
  DawSessionStatus,
  FailAgentRunInput,
  IndexEntryRecord,
  JobKind,
  JobRecord,
  LockRecord,
  PendingApprovalRecord,
  RuntimeEventRecord,
  SessionRecord,
  SessionSource,
  SqliteBackupReport,
  SqliteIntegrityReport,
  SqliteRetentionPolicy,
  SqliteRetentionReport,
  SqliteRuntimeDb,
  StartAgentRunInput,
  UpsertIndexEntryInput,
} from './client.ts';

export interface RunsRepository {
  start(input: StartAgentRunInput): AgentRunRecord;
  complete(id: string, input: CompleteAgentRunInput): AgentRunRecord;
  fail(id: string, input: FailAgentRunInput): AgentRunRecord;
  getById(id: string): AgentRunRecord | null;
  list(limit?: number): readonly AgentRunRecord[];
  listByJob(jobId: string): readonly AgentRunRecord[];
}

export interface JobsRepository {
  enqueue(input: {
    readonly id?: string | undefined;
    readonly kind: JobKind;
    readonly name: string;
    readonly specSha256?: string | null | undefined;
    readonly input?: unknown;
    readonly startImmediately?: boolean | undefined;
  }): JobRecord;
  start(id: string): JobRecord;
  complete(id: string, output: unknown, skippedSteps?: readonly string[]): JobRecord;
  fail(id: string, errorDetail: string, failedStep?: string | null): JobRecord;
  cancel(id: string, reason?: string): JobRecord;
  getById(id: string): JobRecord | null;
  list(limit?: number): readonly JobRecord[];
  recoverStaleRunningJobs(reason?: string): readonly JobRecord[];
}

export interface LocksRepository {
  acquire(resourceKey: string, ownerId: string, ttlMs?: number): boolean;
  renew(resourceKey: string, ownerId: string, ttlMs?: number): boolean;
  release(resourceKey: string, ownerId: string): boolean;
  get(resourceKey: string): LockRecord | null;
  listActive(): readonly LockRecord[];
  recoverStaleLocks(referenceIso?: string): {
    readonly recoveredCount: number;
    readonly resourceKeys: readonly string[];
  };
}

export interface ApprovalsRepository {
  queue(input: {
    readonly id?: string | undefined;
    readonly itemType: ApprovalItemType;
    readonly itemId: string;
    readonly request: Record<string, unknown>;
    readonly proposer: string;
  }): PendingApprovalRecord;
  decide(input: {
    readonly approvalId: string;
    readonly decision: 'approved' | 'rejected';
    readonly approver: string;
    readonly reason: string;
  }): PendingApprovalRecord;
  getById(id: string): PendingApprovalRecord | null;
  list(status?: ApprovalStatus): readonly PendingApprovalRecord[];
}

export interface EventsRepository {
  append(input: {
    readonly eventType: string;
    readonly domain: string;
    readonly actor: string;
    readonly targetPath?: string | null | undefined;
    readonly payload?: Record<string, unknown> | undefined;
    readonly checksumSha256?: string | null | undefined;
  }): RuntimeEventRecord;
  list(options?: {
    readonly afterId?: number | undefined;
    readonly eventType?: string | undefined;
    readonly limit?: number | undefined;
  }): readonly RuntimeEventRecord[];
}

export interface SessionsRepository {
  upsert(input: {
    readonly id: string;
    readonly operatorId?: string | undefined;
    readonly source: SessionSource;
    readonly activeSector?: string | null | undefined;
    readonly selectedJobId?: string | null | undefined;
    readonly exchanges?: readonly unknown[] | undefined;
  }): SessionRecord;
  appendExchange(
    sessionId: string,
    exchange: unknown,
    maxExchanges?: number,
    source?: SessionSource,
  ): SessionRecord;
  getById(id: string): SessionRecord | null;
  list(limit?: number): readonly SessionRecord[];
}

export interface IndexStateRepository {
  upsert(entry: UpsertIndexEntryInput): IndexEntryRecord;
  remove(vaultPath: string): boolean;
  get(vaultPath: string): IndexEntryRecord | null;
  search(
    query: string,
    options?: { readonly sector?: string | undefined; readonly limit?: number | undefined },
  ): readonly IndexEntryRecord[];
  list(sector?: string, limit?: number): readonly IndexEntryRecord[];
  stats(): { readonly totalFiles: number; readonly bySector: Readonly<Record<string, number>> };
  setMeta(key: string, value: unknown): void;
  getMeta<T = unknown>(key: string): T | null;
}

export interface DawSessionsRepository {
  upsert(input: {
    readonly id?: string | undefined;
    readonly adapterId: string;
    readonly hostVersion: string;
    readonly projectPath?: string | null | undefined;
    readonly savedSha256?: string | null | undefined;
    readonly cachedSnapshot?: Record<string, unknown> | null | undefined;
    readonly cachedAt?: string | null | undefined;
    readonly status: DawSessionStatus;
  }): DawSessionRecord;
  getById(id: string): DawSessionRecord | null;
  list(status?: DawSessionStatus, limit?: number): readonly DawSessionRecord[];
  markStatus(id: string, status: DawSessionStatus): DawSessionRecord;
}

export interface DawLeasesRepository {
  grant(input: {
    readonly id?: string | undefined;
    readonly sessionId: string;
    readonly maxPermission: DawLeasePermission;
    readonly grantedBy: string;
    readonly allowedTargets?: readonly string[] | undefined;
    readonly ttlMs?: number | undefined;
  }): DawSessionLeaseRecord;
  getById(id: string): DawSessionLeaseRecord | null;
  getActiveForSession(sessionId: string, referenceIso?: string): DawSessionLeaseRecord | null;
  revoke(id: string): boolean;
  listBySession(sessionId: string): readonly DawSessionLeaseRecord[];
}

export interface DawCommandJournalRepository {
  append(input: {
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
  }): DawCommandJournalRecord;
  getById(id: string): DawCommandJournalRecord | null;
  listBySession(sessionId: string, limit?: number): readonly DawCommandJournalRecord[];
}

export interface DawAudioAnalysesRepository {
  record(input: {
    readonly id?: string | undefined;
    readonly sessionId?: string | null | undefined;
    readonly sourceKind: DawAudioSourceKind;
    readonly sourceSha256: string;
    readonly traceAnalysis: Record<string, unknown>;
    readonly traceReport: Record<string, unknown>;
  }): DawAudioAnalysisRecord;
  getById(id: string): DawAudioAnalysisRecord | null;
  list(options?: { readonly sessionId?: string | undefined; readonly limit?: number | undefined }): readonly DawAudioAnalysisRecord[];
}

export interface RuntimeMaintenanceRepository {
  prune(policy?: SqliteRetentionPolicy): SqliteRetentionReport;
  checkIntegrity(): SqliteIntegrityReport;
  backup(destPath: string): SqliteBackupReport;
  transaction<T>(fn: () => T): T;
}

export type RuntimeRepositories = {
  readonly runs: RunsRepository;
  readonly jobs: JobsRepository;
  readonly locks: LocksRepository;
  readonly approvals: ApprovalsRepository;
  readonly events: EventsRepository;
  readonly sessions: SessionsRepository;
  readonly indexState: IndexStateRepository;
  readonly dawSessions: DawSessionsRepository;
  readonly dawLeases: DawLeasesRepository;
  readonly dawCommandJournal: DawCommandJournalRepository;
  readonly dawAudioAnalyses: DawAudioAnalysesRepository;
  readonly maintenance: RuntimeMaintenanceRepository;
};

export const createRuntimeRepositories = (db: SqliteRuntimeDb): RuntimeRepositories => ({
  runs: {
    start: (input) => db.startAgentRun(input),
    complete: (id, input) => db.completeAgentRun(id, input),
    fail: (id, input) => db.failAgentRun(id, input),
    getById: (id) => db.getAgentRun(id),
    list: (limit) => db.listAgentRuns(limit),
    listByJob: (jobId) => db.listAgentRunsByJob(jobId),
  },
  jobs: {
    enqueue: (input) => db.enqueueJob(input),
    start: (id) => db.startJob(id),
    complete: (id, output, skippedSteps) => db.completeJob(id, output, skippedSteps),
    fail: (id, errorDetail, failedStep) => db.failJob(id, errorDetail, failedStep),
    cancel: (id, reason) => db.cancelJob(id, reason),
    getById: (id) => db.getJob(id),
    list: (limit) => db.listJobs(limit),
    recoverStaleRunningJobs: (reason) => db.recoverStaleRunningJobs(reason),
  },
  locks: {
    acquire: (resourceKey, ownerId, ttlMs) => db.acquireLock(resourceKey, ownerId, ttlMs),
    renew: (resourceKey, ownerId, ttlMs) => db.renewLock(resourceKey, ownerId, ttlMs),
    release: (resourceKey, ownerId) => db.releaseLock(resourceKey, ownerId),
    get: (resourceKey) => db.getLock(resourceKey),
    listActive: () => db.listLocks(),
    recoverStaleLocks: (referenceIso) => db.recoverStaleLocks(referenceIso),
  },
  approvals: {
    queue: (input) => db.queueApproval(input),
    decide: (input) => db.decideApproval(input),
    getById: (id) => db.getApproval(id),
    list: (status) => db.listApprovals(status),
  },
  events: {
    append: (input) => db.appendEvent(input),
    list: (options) => db.listEvents(options),
  },
  sessions: {
    upsert: (input) => db.upsertSession(input),
    appendExchange: (sessionId, exchange, maxExchanges, source) =>
      db.appendSessionExchange(sessionId, exchange, maxExchanges, source),
    getById: (id) => db.getSession(id),
    list: (limit) => db.listSessions(limit),
  },
  indexState: {
    upsert: (entry) => db.upsertIndexEntry(entry),
    remove: (vaultPath) => db.removeIndexEntry(vaultPath),
    get: (vaultPath) => db.getIndexEntry(vaultPath),
    search: (query, options) => db.searchIndex(query, options),
    list: (sector, limit) => db.listIndexEntries(sector, limit),
    stats: () => db.getIndexStats(),
    setMeta: (key, value) => db.setIndexMeta(key, value),
    getMeta: <T = unknown>(key: string) => db.getIndexMeta<T>(key),
  },
  dawSessions: {
    upsert: (input) => db.upsertDawSession(input),
    getById: (id) => db.getDawSession(id),
    list: (status, limit) => db.listDawSessions(status, limit),
    markStatus: (id, status) => db.markDawSessionStatus(id, status),
  },
  dawLeases: {
    grant: (input) => db.grantDawLease(input),
    getById: (id) => db.getDawLease(id),
    getActiveForSession: (sessionId, referenceIso) => db.getActiveDawLease(sessionId, referenceIso),
    revoke: (id) => db.revokeDawLease(id),
    listBySession: (sessionId) => db.listDawLeases(sessionId),
  },
  dawCommandJournal: {
    append: (input) => db.appendDawCommand(input),
    getById: (id) => db.getDawCommand(id),
    listBySession: (sessionId, limit) => db.listDawCommandsBySession(sessionId, limit),
  },
  dawAudioAnalyses: {
    record: (input) => db.recordDawAudioAnalysis(input),
    getById: (id) => db.getDawAudioAnalysis(id),
    list: (options) => db.listDawAudioAnalyses(options),
  },
  maintenance: {
    prune: (policy) => db.pruneRuntimeState(policy),
    checkIntegrity: () => db.checkIntegrity(),
    backup: (destPath) => db.backupDatabase(destPath),
    transaction: (fn) => db.transaction(fn),
  },
});
