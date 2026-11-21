import { randomUUID } from 'node:crypto';
import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import type { DawCapabilityRegistry } from './daw-capability-registry.ts';
import type { DawConnectionManager } from './daw-connection-manager.ts';
import type { DawEventBus } from './daw-event-bus.ts';
import type { DawSessionModel } from './daw-session-model.ts';
import {
  DawCommandPolicyEngine,
  verifyDawInstanceIdentity,
  verifyProjectIdentity,
  verifyStateFreshness,
  type DawCommandPolicyConfig,
  type DawCommandRiskAssessment,
} from './command-policy.ts';
import { DawDryRunEngine } from './dry-run-engine.ts';
import {
  DawBrainError,
  type DawCommand,
  type DawCommandLifecycleStage,
  type DawCommandResult,
  type DawDryRunResult,
  type DawErrorCode,
  type DawExecutionReceipt,
  type DawObservationProvenance,
  type DawProjectIdentityCheck,
  type DawRecoveryOutcome,
  type DawStateSnapshot,
} from './types.ts';

export type PreparedDawCommand = {
  readonly prepareId: string;
  readonly command: DawCommand;
  readonly beforeState: Readonly<Record<string, unknown>>;
  readonly expectedBeforeDigest: string;
  readonly approvalId: string | null;
  readonly assessment: DawCommandRiskAssessment;
  readonly dryRun: DawDryRunResult;
};

export type DawCommandPrepareOptions = {
  readonly leaseId?: string | undefined;
  readonly queueApproval?: boolean | undefined;
  readonly maxStateAgeMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
};

export type DawCommandExecuteOptions = {
  readonly actor: string;
  readonly approvalId?: string | undefined;
  readonly leaseId?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxStateAgeMs?: number | undefined;
  readonly strongApprovalConfirmed?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
};

const AGENT_OR_SYSTEM_ACTOR_RE =
  /^(agent:|system$|jarvis$|auto$|x3lius-|tech-|records-)|-(agent|researcher|orchestrator|curator|summarizer|retriever|checker|generator|editor|advisor|assessor|forecaster|advocate|engine)$/i;

const NO_RECOVERY: DawRecoveryOutcome = {
  attempted: false,
  succeeded: true,
  strategy: 'none',
  message: 'No recovery required',
};

const sleepOrAbort = async <T>(
  work: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ readonly kind: 'ok'; readonly value: T } | { readonly kind: 'aborted' } | { readonly kind: 'timed_out' }> => {
  if (signal?.aborted) return { kind: 'aborted' };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;

  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (
        res: { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'aborted' } | { readonly kind: 'timed_out' },
      ) => {
        if (settled) return;
        settled = true;
        resolve(res);
      };

      timer = setTimeout(() => {
        finish({ kind: 'timed_out' });
      }, Math.max(10, timeoutMs));

      if (signal) {
        onAbort = () => finish({ kind: 'aborted' });
        signal.addEventListener('abort', onAbort, { once: true });
      }

      work.then(
        (value) => finish({ kind: 'ok', value }),
        (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        },
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
};

const buildProvenance = (
  dawId: string,
  adapterId: string,
  hostVersion: string,
  capabilityId: string,
  freshness: DawObservationProvenance['freshness'],
): DawObservationProvenance => ({
  observedAt: new Date().toISOString(),
  dawId,
  adapterId,
  hostVersion,
  sourceEvidence: `gateway:${capabilityId}`,
  freshness,
});

/**
 * Sole mutating execution choke point for DAW Brain (`Phase 16`).
 * Enforces an 11-stage command lifecycle:
 * Request -> Capability Verification -> Input Validation -> Permission & Policy Check ->
 * Risk Classification -> Dry-Run Simulation -> Human Approval Gate -> Single-Shot Execution ->
 * Postcondition Readback Verification -> Immutable Audit Receipt -> Recovery / Rollback.
 */
export class DawCommandGateway {
  readonly #connections: DawConnectionManager;
  readonly #capabilities: DawCapabilityRegistry;
  readonly #sessions: DawSessionModel;
  readonly #events: DawEventBus;
  readonly #db: SqliteRuntimeDb | null;
  readonly #policy: DawCommandPolicyEngine;
  readonly #dryRunEngine: DawDryRunEngine;

  readonly #prepared = new Map<string, PreparedDawCommand>();
  readonly #cancelledPrepared = new Map<string, string>();
  readonly #inFlightCommandIds = new Set<string>();
  readonly #completedCommandIds = new Set<string>();
  readonly #completedIdempotencyKeys = new Map<string, string>();
  readonly #receipts = new Map<string, DawExecutionReceipt>();
  readonly #rolledBackReceipts = new Set<string>();
  readonly #consumedApprovalIds = new Set<string>();

  constructor(options: {
    readonly connections: DawConnectionManager;
    readonly capabilities: DawCapabilityRegistry;
    readonly sessions: DawSessionModel;
    readonly events: DawEventBus;
    readonly db?: SqliteRuntimeDb | null | undefined;
    readonly executionPolicy?: Partial<DawCommandPolicyConfig> | undefined;
  }) {
    this.#connections = options.connections;
    this.#capabilities = options.capabilities;
    this.#sessions = options.sessions;
    this.#events = options.events;
    this.#db = options.db ?? null;
    this.#policy = new DawCommandPolicyEngine(options.executionPolicy);
    this.#dryRunEngine = new DawDryRunEngine();
  }

  get policy(): DawCommandPolicyConfig {
    return this.#policy.config;
  }

  getReceipt(receiptId: string): DawExecutionReceipt | null {
    return this.#receipts.get(receiptId) ?? null;
  }

  listReceipts(sessionId?: string): readonly DawExecutionReceipt[] {
    const all = [...this.#receipts.values()];
    return sessionId ? all.filter((r) => r.sessionId === sessionId) : all;
  }

  getAuditTrail(correlationIdOrCommandId: string): readonly DawExecutionReceipt[] {
    return [...this.#receipts.values()].filter(
      (r) => r.correlationId === correlationIdOrCommandId || r.commandId === correlationIdOrCommandId,
    );
  }

  classify(command: DawCommand): DawCommandRiskAssessment {
    const sess = this.#sessions.getSession(command.sessionId);
    const cap = sess ? this.#capabilities.getCapability(sess.adapterId, command.capabilityId) : null;
    return this.#policy.classifyCommand(command, cap, sess?.observed ?? sess?.cached ?? null);
  }

  /**
   * Cancels a previously prepared command before dispatch so subsequent execution refuses cleanly.
   */
  cancelPrepared(prepareId: string, actor: string, reason = 'Cancelled by operator prior to dispatch'): boolean {
    const prep = this.#prepared.get(prepareId);
    this.#cancelledPrepared.set(prepareId, reason);
    if (!prep) return false;
    this.#prepared.delete(prepareId);

    const sess = this.#sessions.getSession(prep.command.sessionId);
    const projectIdentity = sess
      ? verifyProjectIdentity(sess, prep.command)
      : {
          verified: false,
          sessionProjectId: 'unknown',
          sessionProjectPath: null,
          sessionSavedSha256: null,
          mismatchReason: 'Session unavailable at cancellation',
        };

    const receipt = this.#buildReceipt({
      receiptId: `cancel-${randomUUID()}`,
      command: prep.command,
      adapterId: sess?.adapterId ?? 'unknown',
      assessment: prep.assessment,
      approvalId: prep.approvalId,
      leaseId: null,
      projectIdentity,
      executedBy: actor,
      stages: [
        'request',
        'capability_verification',
        'input_validation',
        'permission_check',
        'risk_classification',
        'dry_run',
        'audit',
      ],
      beforeState: prep.beforeState,
      afterState: null,
      dryRunDiff: prep.dryRun.diff,
      verifiedByReadback: false,
      postconditionVerified: false,
      cancelled: true,
      timedOut: false,
      durationMs: 0,
      recovery: NO_RECOVERY,
      status: 'cancelled',
      error: { code: 'DAW_CANCELLED', message: reason },
    });
    this.#persistReceipt(receipt, prep.command, 'failed', `DAW_CANCELLED: ${reason}`);
    this.#events.emit(
      'daw.command.cancelled',
      prep.command.sessionId,
      {
        commandId: prep.command.commandId,
        correlationId: prep.command.correlationId,
        prepareId,
        receiptId: receipt.receiptId,
        reason,
      },
      actor,
    );
    return true;
  }

  /**
   * Executes Stages 1–6 (Request -> Capability -> Input Validation -> Permission/Freshness/Project ->
   * Risk Classification -> Dry-Run Simulation) strictly without mutating DAW host state.
   */
  async dryRun(
    command: DawCommand,
    options: Pick<DawCommandPrepareOptions, 'leaseId' | 'maxStateAgeMs' | 'signal'> = {},
  ): Promise<DawDryRunResult> {
    const { assessment, dryRun } = await this.#runPreExecutionStages(command, {
      ...options,
      requestedTier: command.kind === 'session.observe' ? 'observe' : 'prepare',
    });

    this.#events.emit(
      'daw.command.dry_run',
      command.sessionId,
      {
        commandId: command.commandId,
        correlationId: command.correlationId,
        capabilityId: command.capabilityId,
        commandClass: assessment.commandClass,
        rollbackSupported: assessment.rollbackSupported,
        approvalRequirement: assessment.approvalRequirement,
        diffCount: dryRun.diff.length,
      },
      command.requestedBy,
    );

    return dryRun;
  }

  /**
   * Prepares a mutating command through Stages 1–6 and optionally queues human approval (Stage 7).
   */
  async prepare(
    command: DawCommand,
    options: DawCommandPrepareOptions = {},
  ): Promise<PreparedDawCommand> {
    const { currentSnapshot, assessment, beforeState, dryRun } = await this.#runPreExecutionStages(command, {
      ...options,
      requestedTier: 'prepare',
    });

    let approvalId: string | null = null;
    if (options.queueApproval && this.#db?.isOpen) {
      const appr = this.#db.queueApproval({
        itemType: 'artifact_version',
        itemId: `daw_patch:${command.commandId}`,
        proposer: command.requestedBy,
        request: {
          sessionId: command.sessionId,
          commandId: command.commandId,
          correlationId: command.correlationId,
          capabilityId: command.capabilityId,
          commandKind: command.kind,
          commandClass: assessment.commandClass,
          approvalRequirement: assessment.approvalRequirement,
          rollbackSupported: assessment.rollbackSupported,
          warnings: assessment.warnings,
          targetRef: command.targetRef,
          params: command.params,
          beforeState,
          predictedAfterState: dryRun.predictedAfterState,
          diff: dryRun.diff,
        },
      });
      approvalId = appr.id;
    }

    const prepared: PreparedDawCommand = {
      prepareId: command.commandId,
      command: { ...command, expectedBeforeDigest: currentSnapshot.stateDigest },
      beforeState,
      expectedBeforeDigest: currentSnapshot.stateDigest,
      approvalId,
      assessment,
      dryRun,
    };
    this.#prepared.set(prepared.prepareId, prepared);

    this.#sessions.addProposal(command.sessionId, prepared.command);
    this.#events.emit(
      'daw.command.prepared',
      command.sessionId,
      {
        commandId: command.commandId,
        correlationId: command.correlationId,
        capabilityId: command.capabilityId,
        commandClass: assessment.commandClass,
        rollbackSupported: assessment.rollbackSupported,
        approvalRequirement: assessment.approvalRequirement,
        targetRef: command.targetRef,
        approvalId,
      },
      command.requestedBy,
    );
    return prepared;
  }

  /**
   * Executes a prepared or direct DAW command through the full 11-stage safety pipeline.
   */
  async execute(
    commandOrPrepareId: DawCommand | string,
    options: DawCommandExecuteOptions,
  ): Promise<DawCommandResult> {
    const startedMs = Date.now();
    const prep =
      typeof commandOrPrepareId === 'string' ? this.#prepared.get(commandOrPrepareId) : undefined;
    const cancelledReason =
      typeof commandOrPrepareId === 'string' ? this.#cancelledPrepared.get(commandOrPrepareId) : undefined;

    if (typeof commandOrPrepareId === 'string' && cancelledReason !== undefined && !prep) {
      throw new DawBrainError(
        'DAW_CANCELLED',
        `Prepared DAW command "${commandOrPrepareId}" was cancelled: ${cancelledReason}`,
      );
    }

    const command =
      typeof commandOrPrepareId === 'string' ? prep?.command : commandOrPrepareId;

    if (!command) {
      throw new DawBrainError(
        'DAW_INVALID_COMMAND',
        `Prepared DAW command not found: "${String(commandOrPrepareId)}"`,
      );
    }

    const stages: DawCommandLifecycleStage[] = ['request'];

    const sess = this.#sessions.requireSession(command.sessionId);
    const adapter = this.#connections.requireAdapter(sess.adapterId);
    const capMeta = this.#capabilities.getCapability(sess.adapterId, command.capabilityId);
    const assessment = this.#policy.classifyCommand(command, capMeta, sess.observed ?? sess.cached);
    const projectIdentity = verifyProjectIdentity(sess, command);

    const makeProv = (freshness: DawObservationProvenance['freshness'] = 'unknown') =>
      buildProvenance(sess.dawId, sess.adapterId, sess.hostVersion, command.capabilityId, freshness);

    const finishWithDeny = (
      code: DawErrorCode,
      message: string,
      opts: {
        readonly status?: DawCommandResult['status'] | undefined;
        readonly cancelled?: boolean | undefined;
        readonly timedOut?: boolean | undefined;
        readonly recovery?: DawRecoveryOutcome | undefined;
        readonly beforeState?: Readonly<Record<string, unknown>> | null | undefined;
        readonly afterState?: Readonly<Record<string, unknown>> | null | undefined;
      } = {},
    ): DawCommandResult => {
      stages.push('audit');
      const finalStatus =
        opts.status ??
        (code === 'DAW_CAPABILITY_UNSUPPORTED'
          ? 'unsupported'
          : code === 'DAW_CANCELLED'
            ? 'cancelled'
            : code === 'DAW_TIMEOUT'
              ? 'timed_out'
              : 'denied');
      const dbStatus =
        finalStatus === 'cancelled' || finalStatus === 'timed_out' || finalStatus === 'failed'
          ? 'failed'
          : 'denied';

      const receipt = this.#buildReceipt({
        receiptId: `rcpt-deny-${randomUUID()}`,
        command,
        adapterId: sess.adapterId,
        assessment,
        approvalId: options.approvalId ?? prep?.approvalId ?? null,
        leaseId: options.leaseId ?? null,
        projectIdentity,
        executedBy: options.actor,
        stages,
        beforeState: opts.beforeState ?? prep?.beforeState ?? null,
        afterState: opts.afterState ?? null,
        dryRunDiff: prep?.dryRun.diff ?? [],
        verifiedByReadback: false,
        postconditionVerified: false,
        cancelled: opts.cancelled ?? code === 'DAW_CANCELLED',
        timedOut: opts.timedOut ?? code === 'DAW_TIMEOUT',
        durationMs: Date.now() - startedMs,
        recovery: opts.recovery ?? NO_RECOVERY,
        status: finalStatus,
        error: { code, message },
      });
      this.#persistReceipt(receipt, command, dbStatus, `${code}: ${message}`);
      this.#recordDenyEvent(command, code, message, receipt.receiptId);

      return {
        commandId: command.commandId,
        sessionId: command.sessionId,
        ok: false,
        status: finalStatus,
        stateFreshness: 'unknown',
        capabilityId: command.capabilityId,
        beforeState: receipt.beforeState,
        afterState: receipt.afterState,
        verifiedByReadback: false,
        rollbackSupported: assessment.rollbackSupported,
        provenance: makeProv(sess.observed && !sess.stale ? 'observed' : 'unknown'),
        evidence: [...assessment.warnings, message],
        receiptId: receipt.receiptId,
        correlationId: command.correlationId,
        commandClass: assessment.commandClass,
        lifecycleStages: stages,
        postconditionVerified: false,
        warnings: assessment.warnings,
        cancelled: receipt.cancelled,
        timedOut: receipt.timedOut,
        recovery: receipt.recovery,
        receipt,
        error: { code, message },
      };
    };

    // Stage 1 safeguards: cancellation + duplicate command / idempotency protection
    if (options.signal?.aborted) {
      return finishWithDeny('DAW_CANCELLED', `Command "${command.commandId}" was aborted before dispatch`, {
        status: 'cancelled',
        cancelled: true,
      });
    }

    const dupReason = this.#checkDuplicateCommand(command);
    if (dupReason) {
      return finishWithDeny('DAW_DUPLICATE_COMMAND', dupReason);
    }

    // Stage 2: Capability verification (strictly before input validation & permissions)
    stages.push('capability_verification');
    const supCheck = this.#capabilities.verifyCapabilitySupport({
      adapterId: sess.adapterId,
      sessionId: sess.sessionId,
      capabilityId: command.capabilityId,
      requestedTier: 'execute',
      actor: options.actor,
    });
    if (!supCheck.supported) {
      return finishWithDeny(supCheck.code, supCheck.reason);
    }

    // Check host offline/staleness cleanly for Stage 3 target validation, failing with stale/offline if unavailable
    const freshness = verifyStateFreshness(
      sess,
      { maxStateAgeMs: options.maxStateAgeMs ?? command.maxStateAgeMs },
      this.#policy.config.defaultMaxStateAgeMs,
    );
    if (!freshness.ok) {
      return finishWithDeny(freshness.code ?? 'DAW_STALE_STATE', freshness.reason);
    }
    const currentSnapshot = sess.observed!;

    // Stage 3: Input validation + safety ranges + adapter validation
    stages.push('input_validation');
    const inputCheck = this.#policy.validateInputAndSafety(command, currentSnapshot);
    if (!inputCheck.ok) {
      return finishWithDeny(inputCheck.code, inputCheck.reason);
    }

    const adapterVal = await adapter.validateCommand(command, currentSnapshot);
    if (!adapterVal.capabilitySupported) {
      return finishWithDeny('DAW_CAPABILITY_UNSUPPORTED', adapterVal.reason);
    }
    if (!adapterVal.valid) {
      return finishWithDeny('DAW_INVALID_COMMAND', adapterVal.reason);
    }

    // Stage 4: DAW instance & project identity, explicit allowlist policy, lease
    stages.push('permission_check');
    const instanceIdentity = verifyDawInstanceIdentity(sess, command, currentSnapshot);
    if (!instanceIdentity.verified) {
      return finishWithDeny(
        'DAW_PERMISSION_DENIED',
        instanceIdentity.mismatchReason ?? 'DAW instance identity verification failed',
      );
    }
    if (!projectIdentity.verified) {
      return finishWithDeny(
        'DAW_PROJECT_MISMATCH',
        projectIdentity.mismatchReason ?? 'Project identity verification failed',
      );
    }

    const policyCheck = this.#policy.checkAllowlistPolicy(command, assessment);
    if (!policyCheck.ok) {
      return finishWithDeny(policyCheck.code, policyCheck.reason);
    }

    const capCheck = this.#capabilities.checkCapability({
      adapterId: sess.adapterId,
      sessionId: sess.sessionId,
      capabilityId: command.capabilityId,
      requestedTier: 'execute',
      targetRef: command.targetRef,
      actor: options.actor,
      actorClass: command.requestedClass,
      leaseId: options.leaseId,
      allowMutationsByVersion: sess.connection.versionCompatibility === 'compatible',
    });
    if (!capCheck.allowed) {
      return finishWithDeny(capCheck.code, capCheck.reason);
    }

    // Stage 5 & 6: Risk classification + dry-run baseline
    stages.push('risk_classification', 'dry_run');
    const beforeState = adapterVal.normalizedBeforeState ?? prep?.beforeState ?? {
      stateDigest: currentSnapshot.stateDigest,
      targetRef: command.targetRef,
    };
    const dryRun = this.#dryRunEngine.simulate({
      command,
      session: sess,
      snapshot: currentSnapshot,
      beforeState,
      assessment,
      maxStateAgeMs: options.maxStateAgeMs ?? command.maxStateAgeMs ?? this.#policy.config.defaultMaxStateAgeMs ?? 15_000,
    });

    // Stage 7: Human approval verification (default deny without valid approval; single-use consumption lock)
    stages.push('approval');
    const resolvedApprovalId = options.approvalId ?? prep?.approvalId ?? undefined;
    if (!this.#db?.isOpen) {
      return finishWithDeny(
        'DAW_APPROVAL_REQUIRED',
        'Default deny: mutating DAW commands require an active SQLite approval registry and human approvalId',
      );
    }
    if (!resolvedApprovalId) {
      return finishWithDeny(
        'DAW_APPROVAL_REQUIRED',
        `Execution of "${command.capabilityId}" requires an approved human approvalId`,
      );
    }
    if (this.#consumedApprovalIds.has(resolvedApprovalId)) {
      return finishWithDeny(
        'DAW_APPROVAL_REQUIRED',
        `Approval "${resolvedApprovalId}" was already consumed by a completed command execution`,
      );
    }
    const approval = this.#db.getApproval(resolvedApprovalId);
    if (!approval || approval.status !== 'approved') {
      return finishWithDeny(
        'DAW_APPROVAL_REQUIRED',
        `Approval "${resolvedApprovalId}" has status "${approval?.status ?? 'missing'}" (requires "approved")`,
      );
    }
    const approver = (approval.approver ?? '').trim();
    if (
      !approver ||
      approver.toLowerCase() === approval.proposer.toLowerCase() ||
      approver.toLowerCase() === command.requestedBy.toLowerCase() ||
      AGENT_OR_SYSTEM_ACTOR_RE.test(approver)
    ) {
      return finishWithDeny(
        'DAW_PERMISSION_DENIED',
        `Security violation: approval "${resolvedApprovalId}" lacks valid independent human approver ("${approver}")`,
      );
    }

    const reqMeta = approval.request as Record<string, unknown>;
    if (typeof reqMeta.sessionId === 'string' && reqMeta.sessionId !== command.sessionId) {
      return finishWithDeny(
        'DAW_PERMISSION_DENIED',
        `Approval "${resolvedApprovalId}" belongs to session "${reqMeta.sessionId}", not "${command.sessionId}"`,
      );
    }
    if (typeof reqMeta.targetRef === 'string' && reqMeta.targetRef !== command.targetRef) {
      return finishWithDeny(
        'DAW_PERMISSION_DENIED',
        `Approval "${resolvedApprovalId}" scoped to target "${reqMeta.targetRef}", not "${command.targetRef}"`,
      );
    }

    if (assessment.approvalRequirement === 'human_strong') {
      const strongConfirmed =
        options.strongApprovalConfirmed === true ||
        Boolean(command.strongApprovalReason?.trim()) ||
        /strong|no.?rollback|irreversible|acknowledge|override|master/i.test(approval.reason ?? '');
      if (!strongConfirmed) {
        return finishWithDeny(
          'DAW_APPROVAL_REQUIRED',
          `Stronger human confirmation required for "${command.capabilityId}" (${assessment.warnings[0] ?? 'high risk / no reliable rollback'})`,
        );
      }
    }

    // Stage 8: Single-shot execution (guarded against duplicate concurrent calls, timeout, and abort signal)
    stages.push('execution');
    this.#inFlightCommandIds.add(command.commandId);
    const timeoutMs = command.timeoutMs ?? options.timeoutMs ?? this.#policy.config.defaultTimeoutMs ?? 5_000;

    let rawResult: DawCommandResult | null = null;
    try {
      const raced = await sleepOrAbort(adapter.execute(command, currentSnapshot), timeoutMs, options.signal);

      if (raced.kind === 'aborted' || raced.kind === 'timed_out') {
        const isAbort = raced.kind === 'aborted';
        const code: DawErrorCode = isAbort ? 'DAW_CANCELLED' : 'DAW_TIMEOUT';
        const msg = isAbort
          ? `Command "${command.commandId}" was cancelled during execution`
          : `Command "${command.commandId}" exceeded timeout of ${timeoutMs} ms`;

        stages.push('recovery_or_rollback');
        const recovery = await this.#attemptInterruptedRecovery({
          adapter,
          command,
          sessionId: command.sessionId,
          beforeState,
          previousDigest: currentSnapshot.stateDigest,
          rollbackSupported: assessment.rollbackSupported,
          actor: options.actor,
        });

        this.#recordTerminalCommand(command);
        this.#prepared.delete(command.commandId);

        this.#events.emit(
          isAbort ? 'daw.command.cancelled' : 'daw.command.timed_out',
          command.sessionId,
          {
            commandId: command.commandId,
            correlationId: command.correlationId,
            capabilityId: command.capabilityId,
            recovery,
          },
          options.actor,
        );

        return finishWithDeny(code, msg, {
          status: isAbort ? 'cancelled' : 'timed_out',
          cancelled: isAbort,
          timedOut: !isAbort,
          recovery,
          beforeState,
        });
      }

      rawResult = raced.value;
    } finally {
      this.#inFlightCommandIds.delete(command.commandId);
    }

    // Stage 9: Postcondition Verification via mandatory live host readback
    stages.push('postcondition_verification');
    let verifiedSnapshot: DawStateSnapshot | null = null;
    let postconditionVerified = false;
    let mismatches: readonly string[] = [];
    let finalOk = rawResult.ok;
    let finalError = rawResult.error;
    let recovery: DawRecoveryOutcome = NO_RECOVERY;

    if (rawResult.ok) {
      verifiedSnapshot = await adapter.observe(command.sessionId).catch(() => null);
      if (verifiedSnapshot) {
        this.#sessions.applyObservedSnapshot(command.sessionId, verifiedSnapshot);
      }

      const postcond = this.#dryRunEngine.verifyPostcondition({
        command,
        observedSnapshot: verifiedSnapshot,
        reportedAfterState: rawResult.afterState,
        predictedAfterState: dryRun.predictedAfterState,
      });
      postconditionVerified = postcond.verified;
      mismatches = postcond.mismatches;

      if (!postconditionVerified) {
        finalOk = false;
        finalError = {
          code: 'DAW_POSTCONDITION_FAILED',
          message: `Postcondition verification failed: ${mismatches.join('; ')}`,
        };
        stages.push('recovery_or_rollback');
        recovery = await this.#attemptInterruptedRecovery({
          adapter,
          command,
          sessionId: command.sessionId,
          beforeState,
          previousDigest: currentSnapshot.stateDigest,
          rollbackSupported: assessment.rollbackSupported,
          actor: options.actor,
          forceRollback: true,
        });
      }
    }

    // Stage 10: Audit & Immutable Execution Receipt
    stages.push('audit');
    this.#recordTerminalCommand(command);
    this.#prepared.delete(command.commandId);
    if (finalOk) {
      this.#consumedApprovalIds.add(resolvedApprovalId);
    }

    const receiptId = `rcpt-${randomUUID()}`;
    const resolvedAfterState = rawResult.afterState ? { ...rawResult.afterState } : null;
    const finalStatus: DawExecutionReceipt['status'] = finalOk
      ? 'succeeded'
      : rawResult.status === 'unsupported'
        ? 'unsupported'
        : 'failed';

    const receipt = this.#buildReceipt({
      receiptId,
      command,
      adapterId: sess.adapterId,
      assessment,
      approvalId: resolvedApprovalId,
      leaseId: capCheck.leaseId,
      projectIdentity,
      executedBy: options.actor,
      stages,
      beforeState: rawResult.beforeState ? { ...rawResult.beforeState } : { ...beforeState },
      afterState: resolvedAfterState,
      dryRunDiff: dryRun.diff,
      verifiedByReadback: rawResult.ok && verifiedSnapshot !== null,
      postconditionVerified,
      cancelled: false,
      timedOut: false,
      durationMs: Date.now() - startedMs,
      recovery,
      status: finalStatus,
      error: finalError,
    });

    this.#persistReceipt(
      receipt,
      command,
      finalOk ? 'executed' : 'failed',
      finalOk ? null : finalError?.message ?? 'Execution failed',
    );

    const finalResult: DawCommandResult = {
      ...rawResult,
      ok: finalOk,
      status: finalOk ? 'succeeded' : finalStatus === 'unsupported' ? 'unsupported' : 'failed',
      beforeState: receipt.beforeState,
      afterState: receipt.afterState,
      verifiedByReadback: receipt.verifiedByReadback,
      rollbackSupported: assessment.rollbackSupported,
      evidence: [
        ...rawResult.evidence,
        ...assessment.warnings,
        ...(mismatches.length > 0 ? [`POSTCONDITION_MISMATCH: ${mismatches.join('; ')}`] : []),
      ],
      receiptId,
      correlationId: command.correlationId,
      commandClass: assessment.commandClass,
      lifecycleStages: stages,
      postconditionVerified,
      warnings: assessment.warnings,
      cancelled: false,
      timedOut: false,
      recovery,
      receipt,
      error: finalError,
    };

    this.#sessions.recordAppliedResult(command.sessionId, finalResult);

    if (finalOk) {
      this.#events.emit(
        'daw.command.executed',
        command.sessionId,
        {
          commandId: command.commandId,
          correlationId: command.correlationId,
          receiptId,
          capabilityId: command.capabilityId,
          commandClass: assessment.commandClass,
          verifiedByReadback: finalResult.verifiedByReadback,
          postconditionVerified,
          rollbackSupported: assessment.rollbackSupported,
        },
        options.actor,
      );
    }

    return finalResult;
  }

  /**
   * Executes Stage 11 rollback ONLY when the underlying DAW capability genuinely supports rollback.
   */
  async rollback(
    receiptId: string,
    options: { readonly actor: string; readonly approvalId?: string | undefined; readonly leaseId?: string | undefined },
  ): Promise<DawCommandResult> {
    if (!this.#db?.isOpen) {
      throw new DawBrainError('DAW_CAPABILITY_UNSUPPORTED', 'Rollback requires SQLite runtime journal');
    }
    if (this.#rolledBackReceipts.has(receiptId)) {
      throw new DawBrainError('DAW_DUPLICATE_COMMAND', `Receipt "${receiptId}" has already been rolled back`);
    }

    const dbReceipt = this.#db.getDawCommand(receiptId);
    const memReceipt = this.#receipts.get(receiptId);
    if (!dbReceipt || !dbReceipt.beforeState) {
      throw new DawBrainError('DAW_INVALID_COMMAND', `Rollback receipt or beforeState not found: "${receiptId}"`);
    }
    if (memReceipt && !memReceipt.rollbackSupported) {
      throw new DawBrainError(
        'DAW_ROLLBACK_UNSUPPORTED',
        `Receipt "${receiptId}" (${dbReceipt.capabilityId}) does not support reliable DAW rollback`,
      );
    }

    const sess = this.#sessions.requireSession(dbReceipt.sessionId);
    const adapter = this.#connections.requireAdapter(sess.adapterId);
    const freshness = verifyStateFreshness(sess, undefined, this.#policy.config.defaultMaxStateAgeMs);
    if (!freshness.ok) {
      throw new DawBrainError(freshness.code ?? 'DAW_HOST_OFFLINE', freshness.reason);
    }

    const capCheck = this.#capabilities.checkCapability({
      adapterId: sess.adapterId,
      sessionId: sess.sessionId,
      capabilityId: dbReceipt.capabilityId,
      requestedTier: 'rollback',
      targetRef: dbReceipt.targetRef,
      actor: options.actor,
      leaseId: options.leaseId,
      allowMutationsByVersion: sess.connection.versionCompatibility === 'compatible',
    });

    if (!capCheck.allowed) {
      throw new DawBrainError(capCheck.code, capCheck.reason);
    }
    if (!capCheck.capability.rollbackSupported) {
      throw new DawBrainError(
        'DAW_ROLLBACK_UNSUPPORTED',
        `Capability "${dbReceipt.capabilityId}" on "${sess.adapterId}" does not support rollback`,
      );
    }

    const origKind = String((dbReceipt.command as Record<string, unknown>).kind ?? 'mixer.volume_pan_mute') as DawCommand['kind'];
    const rollbackCmd: DawCommand = {
      commandId: `rb-${randomUUID()}`,
      sessionId: dbReceipt.sessionId,
      kind: origKind,
      capabilityId: dbReceipt.capabilityId,
      targetRef: dbReceipt.targetRef,
      params: { ...dbReceipt.beforeState, _rollbackOfReceiptId: receiptId },
      requestedBy: options.actor,
      requestedClass: 'Execution',
      correlationId: `corr-rb-${receiptId}`,
      createdAt: new Date().toISOString(),
    };

    const currentSnapshot = sess.observed!;
    const execOut = await adapter.execute(rollbackCmd, currentSnapshot);
    const updatedSnap = await adapter.observe(dbReceipt.sessionId).catch(() => null);
    if (updatedSnap) {
      this.#sessions.applyObservedSnapshot(dbReceipt.sessionId, updatedSnap);
    }

    const rbReceiptId = `rbrcpt-${randomUUID()}`;
    if (execOut.ok) {
      this.#rolledBackReceipts.add(receiptId);
      if (memReceipt) {
        this.#receipts.set(receiptId, {
          ...memReceipt,
          rollbackStatus: 'rolled_back',
          rollbackReceiptId: rbReceiptId,
        });
      }
    }

    this.#db.appendDawCommand({
      id: rbReceiptId,
      sessionId: dbReceipt.sessionId,
      approvalId: options.approvalId ?? dbReceipt.approvalId,
      capabilityId: dbReceipt.capabilityId,
      targetRef: dbReceipt.targetRef,
      command: { ...rollbackCmd },
      beforeState: dbReceipt.afterState,
      afterState: execOut.afterState ? { ...execOut.afterState } : null,
      status: execOut.ok ? 'rolled_back' : 'failed',
      errorDetail: execOut.error?.message ?? (execOut.ok ? null : 'Rollback execution failed'),
    });

    this.#events.emit(
      'daw.command.rolled_back',
      dbReceipt.sessionId,
      {
        originalReceiptId: receiptId,
        rollbackReceiptId: rbReceiptId,
        correlationId: rollbackCmd.correlationId,
        ok: execOut.ok,
      },
      options.actor,
    );

    return {
      ...execOut,
      status: execOut.ok ? 'rolled_back' : 'failed',
      verifiedByReadback: execOut.ok && updatedSnap !== null,
      rollbackSupported: true,
      receiptId: rbReceiptId,
      correlationId: rollbackCmd.correlationId,
      commandClass: 'reversible',
      lifecycleStages: [
        'request',
        'capability_verification',
        'permission_check',
        'execution',
        'postcondition_verification',
        'audit',
        'recovery_or_rollback',
      ],
      postconditionVerified: execOut.ok && updatedSnap !== null,
    };
  }

  async #runPreExecutionStages(
    command: DawCommand,
    options: DawCommandPrepareOptions & { readonly requestedTier: 'prepare' | 'observe' },
  ) {
    if (options.signal?.aborted) {
      throw new DawBrainError('DAW_CANCELLED', `Command "${command.commandId}" cancelled before pre-flight`);
    }
    const dupReason = this.#checkDuplicateCommand(command, true);
    if (dupReason) {
      this.#recordDenyEvent(command, 'DAW_DUPLICATE_COMMAND', dupReason);
      throw new DawBrainError('DAW_DUPLICATE_COMMAND', dupReason);
    }

    const sess = this.#sessions.requireSession(command.sessionId);
    const adapter = this.#connections.requireAdapter(sess.adapterId);
    const freshness = verifyStateFreshness(
      sess,
      { maxStateAgeMs: options.maxStateAgeMs ?? command.maxStateAgeMs },
      this.#policy.config.defaultMaxStateAgeMs,
    );
    if (!freshness.ok) {
      const code = freshness.code ?? 'DAW_STALE_STATE';
      this.#recordJournalDeny(command, code, freshness.reason);
      throw new DawBrainError(code, freshness.reason);
    }
    const currentSnapshot = sess.observed!;

    // Stage 2: Pure capability support check (runs BEFORE input validation & permission lease checks)
    const supCheck = this.#capabilities.verifyCapabilitySupport({
      adapterId: sess.adapterId,
      sessionId: sess.sessionId,
      capabilityId: command.capabilityId,
      requestedTier: options.requestedTier,
      actor: command.requestedBy,
    });
    if (!supCheck.supported) {
      this.#recordJournalDeny(command, supCheck.code, supCheck.reason);
      throw new DawBrainError(supCheck.code, supCheck.reason);
    }

    const assessment = this.#policy.classifyCommand(command, supCheck.capability, currentSnapshot);

    // Stage 3: Input validation + safety ranges + adapter target validation
    const inputVal = this.#policy.validateInputAndSafety(command, currentSnapshot);
    if (!inputVal.ok) {
      this.#recordJournalDeny(command, inputVal.code, inputVal.reason);
      throw new DawBrainError(inputVal.code, inputVal.reason);
    }

    const val = await adapter.validateCommand(command, currentSnapshot);
    if (!val.capabilitySupported) {
      this.#recordJournalDeny(command, 'DAW_CAPABILITY_UNSUPPORTED', val.reason);
      throw new DawBrainError('DAW_CAPABILITY_UNSUPPORTED', val.reason);
    }
    if (!val.valid) {
      this.#recordJournalDeny(command, 'DAW_INVALID_COMMAND', val.reason);
      throw new DawBrainError('DAW_INVALID_COMMAND', val.reason);
    }

    // Stage 4: DAW instance & project identity, explicit allowlist policy, actor class, & TTL lease check
    const instanceIdentity = verifyDawInstanceIdentity(sess, command, currentSnapshot);
    if (!instanceIdentity.verified) {
      const msg = instanceIdentity.mismatchReason ?? 'DAW instance identity verification failed';
      this.#recordJournalDeny(command, 'DAW_PERMISSION_DENIED', msg);
      throw new DawBrainError('DAW_PERMISSION_DENIED', msg);
    }

    const projectIdentity = verifyProjectIdentity(sess, command);
    if (!projectIdentity.verified) {
      const msg = projectIdentity.mismatchReason ?? 'Project identity mismatch';
      this.#recordJournalDeny(command, 'DAW_PROJECT_MISMATCH', msg);
      throw new DawBrainError('DAW_PROJECT_MISMATCH', msg);
    }

    const allowCheck = this.#policy.checkAllowlistPolicy(command, assessment);
    if (!allowCheck.ok) {
      this.#recordJournalDeny(command, allowCheck.code, allowCheck.reason);
      throw new DawBrainError(allowCheck.code, allowCheck.reason);
    }

    const capCheck = this.#capabilities.checkCapability({
      adapterId: sess.adapterId,
      sessionId: sess.sessionId,
      capabilityId: command.capabilityId,
      requestedTier: options.requestedTier,
      targetRef: command.targetRef,
      actor: command.requestedBy,
      actorClass: command.requestedClass,
      leaseId: options.leaseId,
      allowMutationsByVersion: sess.connection.versionCompatibility === 'compatible',
    });
    if (!capCheck.allowed) {
      this.#recordJournalDeny(command, capCheck.code, capCheck.reason);
      throw new DawBrainError(capCheck.code, capCheck.reason);
    }

    const beforeState = val.normalizedBeforeState ?? {
      stateDigest: currentSnapshot.stateDigest,
      targetRef: command.targetRef,
    };

    // Stage 5 & 6: Risk classification & side-effect-free dry-run diff
    const dryRun = this.#dryRunEngine.simulate({
      command,
      session: sess,
      snapshot: currentSnapshot,
      beforeState,
      assessment,
      maxStateAgeMs: options.maxStateAgeMs ?? command.maxStateAgeMs ?? this.#policy.config.defaultMaxStateAgeMs ?? 15_000,
    });

    return { sess, currentSnapshot, cap: capCheck.capability, assessment, beforeState, dryRun };
  }

  #checkDuplicateCommand(command: DawCommand, checkingPrepare = false): string | null {
    if (this.#inFlightCommandIds.has(command.commandId)) {
      return `Command "${command.commandId}" is already executing in flight`;
    }
    if (this.#completedCommandIds.has(command.commandId)) {
      return `Duplicate command "${command.commandId}" has already reached terminal execution`;
    }
    if (checkingPrepare && this.#prepared.has(command.commandId)) {
      return `Duplicate command "${command.commandId}" is already prepared`;
    }
    if (checkingPrepare && this.#cancelledPrepared.has(command.commandId)) {
      return `Duplicate command "${command.commandId}" was already cancelled`;
    }
    if (command.idempotencyKey) {
      const priorId = this.#completedIdempotencyKeys.get(command.idempotencyKey);
      if (priorId) {
        return `Duplicate idempotencyKey "${command.idempotencyKey}" already satisfied by command "${priorId}"`;
      }
    }
    if (this.#db?.isOpen && this.#db.getDawSession(command.sessionId)) {
      const recent = this.#db.listDawCommandsBySession(command.sessionId, 500);
      for (const row of recent) {
        if (row.status === 'executed' || row.status === 'rolled_back') {
          const rowCmd = row.command as Record<string, unknown>;
          if (String(rowCmd.commandId ?? '') === command.commandId) {
            return `Command "${command.commandId}" already recorded in SQLite journal (${row.id})`;
          }
          if (command.idempotencyKey && rowCmd.idempotencyKey === command.idempotencyKey) {
            return `Idempotency key "${command.idempotencyKey}" already recorded in SQLite journal (${row.id})`;
          }
        }
      }
    }
    return null;
  }

  #recordTerminalCommand(command: DawCommand): void {
    this.#completedCommandIds.add(command.commandId);
    if (command.idempotencyKey) {
      this.#completedIdempotencyKeys.set(command.idempotencyKey, command.commandId);
    }
  }

  async #attemptInterruptedRecovery(input: {
    readonly adapter: ReturnType<DawConnectionManager['requireAdapter']>;
    readonly command: DawCommand;
    readonly sessionId: string;
    readonly beforeState: Readonly<Record<string, unknown>>;
    readonly previousDigest: string;
    readonly rollbackSupported: boolean;
    readonly actor: string;
    readonly forceRollback?: boolean;
  }): Promise<DawRecoveryOutcome> {
    const snap = await input.adapter.observe(input.sessionId).catch(() => null);
    if (!snap) {
      this.#sessions.markStale(input.sessionId, 'Host readback unavailable during failure recovery');
      return {
        attempted: true,
        succeeded: false,
        strategy: 'marked_stale_reobserve',
        message: 'Host could not be re-observed after interruption; session marked stale for manual check.',
      };
    }

    this.#sessions.applyObservedSnapshot(input.sessionId, snap);
    const hostChanged = snap.stateDigest !== input.previousDigest;
    if (!hostChanged && !input.forceRollback) {
      return {
        attempted: true,
        succeeded: true,
        strategy: 'none',
        message: 'Verified via live readback that interrupted command left DAW state unchanged.',
      };
    }

    if (!input.rollbackSupported) {
      return {
        attempted: true,
        succeeded: false,
        strategy: 'manual_intervention_required',
        message: 'Host state changed during failed/interrupted non-rollbackable command; operator manual check required.',
      };
    }

    const rbCmd: DawCommand = {
      commandId: `rec-rb-${randomUUID()}`,
      sessionId: input.sessionId,
      kind: input.command.kind,
      capabilityId: input.command.capabilityId,
      targetRef: input.command.targetRef,
      params: { ...input.beforeState, _recoveryOfCommandId: input.command.commandId },
      requestedBy: input.actor,
      requestedClass: 'Execution',
      correlationId: input.command.correlationId,
      createdAt: new Date().toISOString(),
    };

    try {
      const rbOut = await input.adapter.execute(rbCmd, snap);
      const restoredSnap = await input.adapter.observe(input.sessionId).catch(() => null);
      if (restoredSnap) {
        this.#sessions.applyObservedSnapshot(input.sessionId, restoredSnap);
      }
      const rbId = `recrcpt-${randomUUID()}`;
      if (this.#db?.isOpen && this.#db.getDawSession(input.sessionId)) {
        this.#db.appendDawCommand({
          id: rbId,
          sessionId: input.sessionId,
          approvalId: null,
          capabilityId: input.command.capabilityId,
          targetRef: input.command.targetRef,
          command: { ...rbCmd },
          beforeState: null,
          afterState: rbOut.afterState ? { ...rbOut.afterState } : null,
          status: rbOut.ok ? 'rolled_back' : 'failed',
          errorDetail: rbOut.ok ? null : rbOut.error?.message ?? 'Recovery rollback failed',
        });
      }
      this.#events.emit(
        'daw.command.recovered',
        input.sessionId,
        {
          commandId: input.command.commandId,
          correlationId: input.command.correlationId,
          rollbackReceiptId: rbId,
          ok: rbOut.ok,
        },
        input.actor,
      );
      return {
        attempted: true,
        succeeded: rbOut.ok,
        strategy: rbOut.ok ? 'rollback_restored' : 'manual_intervention_required',
        rollbackReceiptId: rbId,
        message: rbOut.ok
          ? `Compensating recovery restored beforeState via ${rbId}`
          : 'Compensating rollback failed; manual operator inspection required',
      };
    } catch (err) {
      return {
        attempted: true,
        succeeded: false,
        strategy: 'manual_intervention_required',
        message: `Recovery rollback threw error: ${(err as Error).message}`,
      };
    }
  }

  #buildReceipt(input: {
    readonly receiptId: string;
    readonly command: DawCommand;
    readonly adapterId: string;
    readonly assessment: DawCommandRiskAssessment;
    readonly approvalId: string | null;
    readonly leaseId: string | null;
    readonly projectIdentity: DawProjectIdentityCheck;
    readonly executedBy: string;
    readonly stages: readonly DawCommandLifecycleStage[];
    readonly beforeState: Readonly<Record<string, unknown>> | null;
    readonly afterState: Readonly<Record<string, unknown>> | null;
    readonly dryRunDiff: DawExecutionReceipt['dryRunDiff'];
    readonly verifiedByReadback: boolean;
    readonly postconditionVerified: boolean;
    readonly cancelled: boolean;
    readonly timedOut: boolean;
    readonly durationMs: number;
    readonly recovery: DawRecoveryOutcome;
    readonly status: DawExecutionReceipt['status'];
    readonly error?: { readonly code: DawErrorCode; readonly message: string } | undefined;
  }): DawExecutionReceipt {
    const now = new Date().toISOString();
    return {
      receiptId: input.receiptId,
      commandId: input.command.commandId,
      correlationId: input.command.correlationId,
      sessionId: input.command.sessionId,
      adapterId: input.adapterId,
      capabilityId: input.command.capabilityId,
      commandKind: input.command.kind,
      commandClass: input.assessment.commandClass,
      riskLevel: input.assessment.riskLevel,
      approvalRequirement: input.assessment.approvalRequirement,
      approvalId: input.approvalId,
      leaseId: input.leaseId,
      projectIdentity: input.projectIdentity,
      requestedBy: input.command.requestedBy,
      executedBy: input.executedBy,
      lifecycleStages: [...input.stages],
      beforeState: input.beforeState,
      afterState: input.afterState,
      dryRunDiff: input.dryRunDiff,
      verifiedByReadback: input.verifiedByReadback,
      postconditionVerified: input.postconditionVerified,
      rollbackSupported: input.assessment.rollbackSupported,
      rollbackStatus: input.assessment.rollbackSupported ? 'available' : 'unavailable',
      cancelled: input.cancelled,
      timedOut: input.timedOut,
      durationMs: input.durationMs,
      warnings: input.assessment.warnings,
      recovery: input.recovery,
      status: input.status,
      error: input.error,
      createdAt: input.command.createdAt,
      completedAt: now,
    };
  }

  #persistReceipt(
    receipt: DawExecutionReceipt,
    command: DawCommand,
    dbStatus: 'prepared' | 'executed' | 'failed' | 'rolled_back' | 'denied',
    errorDetail: string | null,
  ): void {
    this.#receipts.set(receipt.receiptId, receipt);
    if (this.#db?.isOpen && this.#db.getDawSession(receipt.sessionId)) {
      this.#db.appendDawCommand({
        id: receipt.receiptId,
        sessionId: receipt.sessionId,
        approvalId: receipt.approvalId,
        capabilityId: receipt.capabilityId,
        targetRef: command.targetRef,
        command: {
          commandId: receipt.commandId,
          correlationId: receipt.correlationId,
          idempotencyKey: command.idempotencyKey,
          kind: receipt.commandKind,
          capabilityId: receipt.capabilityId,
          commandClass: receipt.commandClass,
          status: receipt.status,
          rollbackSupported: receipt.rollbackSupported,
          postconditionVerified: receipt.postconditionVerified,
          warnings: receipt.warnings,
        },
        beforeState: receipt.beforeState ? { ...receipt.beforeState } : null,
        afterState: receipt.afterState ? { ...receipt.afterState } : null,
        status: dbStatus,
        errorDetail: dbStatus === 'failed' ? errorDetail || 'Command execution failed' : errorDetail,
      });
    }
  }

  #recordDenyEvent(
    command: DawCommand,
    code: DawErrorCode,
    message: string,
    receiptId?: string,
  ): void {
    this.#events.emit(
      'daw.command.denied',
      command.sessionId,
      {
        commandId: command.commandId,
        correlationId: command.correlationId,
        capabilityId: command.capabilityId,
        receiptId: receiptId ?? null,
        code,
        message,
      },
      command.requestedBy,
    );
  }

  #recordJournalDeny(
    command: DawCommand,
    code: DawErrorCode,
    message: string,
    approvalId?: string | undefined,
  ): void {
    this.#recordDenyEvent(command, code, message);
    if (this.#db?.isOpen && this.#db.getDawSession(command.sessionId)) {
      this.#db.appendDawCommand({
        sessionId: command.sessionId,
        approvalId: approvalId ?? null,
        capabilityId: command.capabilityId,
        targetRef: command.targetRef,
        command: { ...command },
        beforeState: null,
        afterState: null,
        status: 'denied',
        errorDetail: `${code}: ${message}`,
      });
    }
  }
}
