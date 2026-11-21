import {
  verifyProjectIdentity,
  verifyStateFreshness,
  type DawCommandRiskAssessment,
} from './command-policy.ts';
import type {
  DawCommand,
  DawCommandLifecycleStage,
  DawDryRunResult,
  DawSession,
  DawStateDiffEntry,
  DawStateSnapshot,
} from './types.ts';

const approxEqual = (a: number, b: number, epsilon: number): boolean =>
  Math.abs(a - b) <= epsilon;

/**
 * Deterministic, side-effect-free Dry-Run Simulation & Postcondition Verification Engine.
 * Never dispatches live adapter writes; produces exact predicted state diffs and verifies
 * host readback snapshots match postconditions within numerical tolerances.
 */
export class DawDryRunEngine {
  simulate(input: {
    readonly command: DawCommand;
    readonly session: DawSession;
    readonly snapshot: DawStateSnapshot;
    readonly beforeState: Readonly<Record<string, unknown>>;
    readonly assessment: DawCommandRiskAssessment;
    readonly maxStateAgeMs: number;
    readonly stages?: readonly DawCommandLifecycleStage[];
  }): DawDryRunResult {
    const { command, session, snapshot, beforeState, assessment } = input;
    const freshnessCheck = verifyStateFreshness(session, command, input.maxStateAgeMs);
    const projectIdentity = verifyProjectIdentity(session, command);
    const predictedAfter: Record<string, unknown> = { ...beforeState };
    const diff: DawStateDiffEntry[] = [];
    const postconditionExpectations: string[] = [];

    const pushDiff = (field: string, before: unknown, after: unknown, unit?: string): void => {
      if (before !== after) {
        diff.push({ field, before, after, unit });
      }
      predictedAfter[field] = after;
    };

    if (command.kind === 'mixer.volume_pan_mute') {
      const ch =
        snapshot.mixerChannels.status === 'available'
          ? snapshot.mixerChannels.value.find((m) => m.id === command.targetRef)
          : undefined;
      const curVolDb = ch?.volumeDb ?? (typeof beforeState.volumeDb === 'number' ? beforeState.volumeDb : null);
      const curVolNorm =
        ch?.volumeNormalized ?? (typeof beforeState.volumeNormalized === 'number' ? beforeState.volumeNormalized : 0.8);
      const curPanNorm =
        ch?.panNormalized ?? (typeof beforeState.panNormalized === 'number' ? beforeState.panNormalized : 0);
      const curMuted = ch?.muted ?? (typeof beforeState.muted === 'boolean' ? beforeState.muted : false);
      const curSoloed = ch?.soloed ?? (typeof beforeState.soloed === 'boolean' ? beforeState.soloed : false);

      if (typeof command.params.volumeDb === 'number') {
        pushDiff('volumeDb', curVolDb, command.params.volumeDb, 'dB');
        postconditionExpectations.push(`mixer(${command.targetRef}).volumeDb == ${command.params.volumeDb}`);
      } else if (typeof command.params.deltaDb === 'number' && curVolDb !== null) {
        const nextDb = Number((curVolDb + command.params.deltaDb).toFixed(3));
        pushDiff('volumeDb', curVolDb, nextDb, 'dB');
        postconditionExpectations.push(`mixer(${command.targetRef}).volumeDb == ${nextDb}`);
      }

      if (typeof command.params.volumeNormalized === 'number') {
        pushDiff('volumeNormalized', curVolNorm, command.params.volumeNormalized, 'norm');
        postconditionExpectations.push(
          `mixer(${command.targetRef}).volumeNormalized ~= ${command.params.volumeNormalized}`,
        );
      }
      if (typeof command.params.panNormalized === 'number') {
        pushDiff('panNormalized', curPanNorm, command.params.panNormalized, 'pan');
        postconditionExpectations.push(`mixer(${command.targetRef}).panNormalized ~= ${command.params.panNormalized}`);
      }
      if (typeof command.params.muted === 'boolean') {
        pushDiff('muted', curMuted, command.params.muted);
        postconditionExpectations.push(`mixer(${command.targetRef}).muted == ${command.params.muted}`);
      }
      if (typeof command.params.soloed === 'boolean') {
        pushDiff('soloed', curSoloed, command.params.soloed);
        postconditionExpectations.push(`mixer(${command.targetRef}).soloed == ${command.params.soloed}`);
      }
    } else if (command.kind === 'transport.control') {
      const tr = snapshot.transport;
      if (typeof command.params.playing === 'boolean') {
        pushDiff('playing', tr.playing, command.params.playing);
        postconditionExpectations.push(`transport.playing == ${command.params.playing}`);
      }
      if (typeof command.params.paused === 'boolean') {
        pushDiff('paused', tr.paused, command.params.paused);
        postconditionExpectations.push(`transport.paused == ${command.params.paused}`);
      }
      if (typeof command.params.loopEnabled === 'boolean') {
        pushDiff('loopEnabled', tr.loopEnabled, command.params.loopEnabled);
        postconditionExpectations.push(`transport.loopEnabled == ${command.params.loopEnabled}`);
      }
      if (typeof command.params.bpm === 'number') {
        pushDiff('bpm', tr.tempo.bpm, command.params.bpm, 'BPM');
        postconditionExpectations.push(`transport.tempo.bpm ~= ${command.params.bpm}`);
      }
    } else if (command.kind === 'plugin.bypass' || command.kind === 'plugin.param_write') {
      const plug =
        snapshot.plugins.status === 'available'
          ? snapshot.plugins.value.find((p) => p.id === command.targetRef || p.containerId === command.targetRef)
          : undefined;
      if (typeof command.params.bypassed === 'boolean') {
        const curBypass = plug?.bypassed ?? Boolean(beforeState.bypassed);
        pushDiff('bypassed', curBypass, command.params.bypassed);
        postconditionExpectations.push(`plugin(${command.targetRef}).bypassed == ${command.params.bypassed}`);
      }
      if (command.kind === 'plugin.param_write' && typeof command.params.valueNormalized === 'number') {
        const idx = typeof command.params.paramIndex === 'number' ? command.params.paramIndex : 0;
        const curVal =
          plug?.parameters.status === 'available'
            ? (plug.parameters.value[idx]?.valueNormalized ?? null)
            : (typeof beforeState.valueNormalized === 'number' ? beforeState.valueNormalized : null);
        pushDiff('valueNormalized', curVal, command.params.valueNormalized, 'norm');
        postconditionExpectations.push(`plugin(${command.targetRef}).param[${idx}] ~= ${command.params.valueNormalized}`);
      }
    } else if (command.kind === 'mixer.routing_write') {
      pushDiff('routingEnabled', beforeState.enabled ?? null, command.params.enabled ?? true);
      postconditionExpectations.push(`routing(${command.targetRef}).updated`);
    } else if (command.kind === 'render.master' || command.kind === 'project.save') {
      postconditionExpectations.push(`${command.kind}(${command.targetRef}) completed without host error`);
    }

    return {
      ok: freshnessCheck.ok && projectIdentity.verified,
      commandId: command.commandId,
      correlationId: command.correlationId,
      sessionId: command.sessionId,
      capabilityId: command.capabilityId,
      commandKind: command.kind,
      commandClass: assessment.commandClass,
      riskLevel: assessment.riskLevel,
      approvalRequirement: assessment.approvalRequirement,
      rollbackSupported: assessment.rollbackSupported,
      rollbackStrategy: assessment.rollbackStrategy,
      wouldSucceed: freshnessCheck.ok && projectIdentity.verified,
      targetRef: command.targetRef,
      beforeState: { ...beforeState },
      predictedAfterState: predictedAfter,
      diff,
      postconditionExpectations,
      warnings: assessment.warnings,
      projectIdentity,
      stateFreshnessCheck: {
        freshness: freshnessCheck.freshness,
        observedAt: freshnessCheck.observedAt,
        ageMs: freshnessCheck.ageMs,
        maxAllowedAgeMs: freshnessCheck.maxAllowedAgeMs,
        fresh: freshnessCheck.ok,
      },
      lifecycleStages: input.stages ?? [
        'request',
        'capability_verification',
        'input_validation',
        'permission_check',
        'risk_classification',
        'dry_run',
      ],
    };
  }

  verifyPostcondition(input: {
    readonly command: DawCommand;
    readonly observedSnapshot: DawStateSnapshot | null;
    readonly reportedAfterState: Readonly<Record<string, unknown>> | null;
    readonly predictedAfterState: Readonly<Record<string, unknown>> | null;
  }): {
    readonly verified: boolean;
    readonly mismatches: readonly string[];
    readonly observedAfterState: Readonly<Record<string, unknown>> | null;
  } {
    const { command, observedSnapshot, reportedAfterState, predictedAfterState } = input;
    if (!observedSnapshot) {
      return {
        verified: false,
        mismatches: ['Post-execution live readback observation failed or returned null snapshot'],
        observedAfterState: reportedAfterState,
      };
    }

    const mismatches: string[] = [];
    const expected = predictedAfterState ?? {};
    let observedAfter: Record<string, unknown> = { ...(reportedAfterState ?? {}) };

    if (command.kind === 'mixer.volume_pan_mute') {
      const ch =
        observedSnapshot.mixerChannels.status === 'available'
          ? observedSnapshot.mixerChannels.value.find((m) => m.id === command.targetRef)
          : undefined;
      if (!ch) {
        mismatches.push(`Target mixer channel "${command.targetRef}" missing in post-execution readback`);
      } else {
        observedAfter = {
          targetRef: ch.id,
          volumeDb: ch.volumeDb,
          volumeNormalized: ch.volumeNormalized,
          panNormalized: ch.panNormalized,
          muted: ch.muted,
          soloed: ch.soloed,
        };
        const checkedDb = command.params.volumeDb !== undefined || command.params.deltaDb !== undefined;
        const checkedNorm = command.params.volumeNormalized !== undefined && !checkedDb;
        if (
          checkedDb &&
          typeof expected.volumeDb === 'number' &&
          ch.volumeDb !== null &&
          !approxEqual(ch.volumeDb, expected.volumeDb, 0.08)
        ) {
          mismatches.push(`Expected volumeDb=${expected.volumeDb}, read back ${ch.volumeDb}`);
        }
        if (
          checkedNorm &&
          typeof expected.volumeNormalized === 'number' &&
          !approxEqual(ch.volumeNormalized, expected.volumeNormalized, 0.02)
        ) {
          mismatches.push(`Expected volumeNormalized=${expected.volumeNormalized}, read back ${ch.volumeNormalized}`);
        }
        if (typeof expected.panNormalized === 'number' && !approxEqual(ch.panNormalized, expected.panNormalized, 0.02)) {
          mismatches.push(`Expected panNormalized=${expected.panNormalized}, read back ${ch.panNormalized}`);
        }
        if (typeof expected.muted === 'boolean' && ch.muted !== expected.muted) {
          mismatches.push(`Expected muted=${expected.muted}, read back ${ch.muted}`);
        }
        if (typeof expected.soloed === 'boolean' && ch.soloed !== expected.soloed) {
          mismatches.push(`Expected soloed=${expected.soloed}, read back ${ch.soloed}`);
        }
      }
    } else if (command.kind === 'transport.control') {
      const tr = observedSnapshot.transport;
      observedAfter = {
        playing: tr.playing,
        paused: tr.paused,
        loopEnabled: tr.loopEnabled,
        bpm: tr.tempo.bpm,
      };
      if (typeof expected.playing === 'boolean' && tr.playing !== expected.playing) {
        mismatches.push(`Expected transport.playing=${expected.playing}, read back ${tr.playing}`);
      }
      if (typeof expected.loopEnabled === 'boolean' && tr.loopEnabled !== expected.loopEnabled) {
        mismatches.push(`Expected transport.loopEnabled=${expected.loopEnabled}, read back ${tr.loopEnabled}`);
      }
      if (typeof expected.bpm === 'number' && !approxEqual(tr.tempo.bpm, expected.bpm, 0.1)) {
        mismatches.push(`Expected bpm=${expected.bpm}, read back ${tr.tempo.bpm}`);
      }
    } else if (command.kind === 'plugin.bypass' || command.kind === 'plugin.param_write') {
      const plug =
        observedSnapshot.plugins.status === 'available'
          ? observedSnapshot.plugins.value.find((p) => p.id === command.targetRef || p.containerId === command.targetRef)
          : undefined;
      if (!plug) {
        mismatches.push(`Plugin target "${command.targetRef}" missing in post-execution readback`);
      } else {
        const idx = typeof command.params.paramIndex === 'number' ? command.params.paramIndex : 0;
        const param = plug.parameters.status === 'available' ? plug.parameters.value[idx] : undefined;
        observedAfter = {
          pluginId: plug.id,
          bypassed: plug.bypassed,
          paramIndex: idx,
          valueNormalized: param?.valueNormalized ?? null,
        };
        if (typeof expected.bypassed === 'boolean' && plug.bypassed !== expected.bypassed) {
          mismatches.push(`Expected bypassed=${expected.bypassed}, read back ${plug.bypassed}`);
        }
        if (
          command.kind === 'plugin.param_write' &&
          typeof expected.valueNormalized === 'number' &&
          param &&
          !approxEqual(param.valueNormalized, expected.valueNormalized, 0.025)
        ) {
          mismatches.push(`Expected param[${idx}]=${expected.valueNormalized}, read back ${param.valueNormalized}`);
        }
      }
    }

    return {
      verified: mismatches.length === 0,
      mismatches,
      observedAfterState: observedAfter,
    };
  }
}
