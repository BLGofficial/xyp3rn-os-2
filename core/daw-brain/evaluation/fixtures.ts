import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  buildBalancedPassFixtureWav,
  buildClippedFixtureWav,
  buildMudFixtureWav,
  encodeWavPcm16,
} from '../audio-brain/fixtures.ts';
import type { DawStateSnapshot } from '../types.ts';
import type { DawBaselineThresholds, DawEvaluationProvenance } from './types.ts';

/**
 * Default pre-registered baseline acceptance thresholds for DAW Brain (Phase 18).
 * Safety-critical gating categories require 1.0 (zero failed cases tolerated);
 * heuristic/analytical categories specify honest baseline accuracy floors.
 */
export const DEFAULT_DAW_BASELINE_THRESHOLDS: DawBaselineThresholds = {
  daw_detection_accuracy: {
    minAccuracy: 1.0,
    maxFailures: 0,
    rationale: 'Host presence/version/offline detection must never misreport offline hosts as reachable',
  },
  state_observation_accuracy: {
    minAccuracy: 0.95,
    maxFailures: 0,
    rationale: 'Tempo, mixer gain, transport, and explicit unsupported/available fields must match truth',
  },
  session_model_completeness: {
    minAccuracy: 1.0,
    maxFailures: 0,
    rationale: 'All 7 session states (observed/cached/stale/proposed/applied/saved/unknown) & drift must reconcile',
  },
  plugin_identification_accuracy: {
    minAccuracy: 0.95,
    maxFailures: 0,
    rationale: 'Loaded plugins, roles, and Producer Edition exclusions must classify without false compatibility',
  },
  parameter_interpretation_accuracy: {
    minAccuracy: 0.95,
    maxFailures: 0,
    rationale: 'Normalized ranges [0..1], readable/writable flags & opaque preset limits must be honored',
  },
  audio_analysis_accuracy: {
    minAccuracy: 0.95,
    maxFailures: 0,
    rationale: 'Analytical reference tones, clipping/mud/pass/phase-inversion checks must match DSP ground truth',
  },
  routing_interpretation_accuracy: {
    minAccuracy: 0.95,
    maxFailures: 0,
    rationale: 'Directed routing graph edges, master sinks, and orphaned/disconnected sources must map accurately',
  },
  agent_recommendation_quality: {
    minAccuracy: 0.9,
    maxFailures: 0,
    rationale: 'Agent routing, analyze-by-default isolation, evidence citations, and grounded advice',
  },
  command_validation_correctness: {
    minAccuracy: 1.0,
    maxFailures: 0,
    rationale: 'Zero tolerance: invalid, out-of-range, stale, mismatched, self-approved, or non-allowlisted commands MUST reject',
  },
  execution_reliability: {
    minAccuracy: 1.0,
    maxFailures: 0,
    rationale: 'Zero tolerance: approved low-risk runs must verify postconditions, deduplicate replays, and write receipts',
  },
  recovery_behavior: {
    minAccuracy: 1.0,
    maxFailures: 0,
    rationale: 'Zero tolerance: rollback, cancellation, timeout recovery, and offline restoration must behave safely',
  },
};

export const sha256Buffer = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/**
 * Generates an analytical 1000 Hz stereo sine wave peaking at exact -6.02 dBFS (`amp = 0.5`),
 * RMS ~ -9.03 dBFS, stereo correlation +1.0 for DSP ground-truth verification.
 */
export const buildAnalyticalToneWav = (durationSec = 2.0, sampleRateHz = 44_100): Buffer => {
  const n = Math.round(durationSec * sampleRateHz);
  const chL = new Float32Array(n);
  const chR = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const val = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sampleRateHz);
    chL[i] = val;
    chR[i] = val;
  }
  return encodeWavPcm16([chL, chR], sampleRateHz);
};

/**
 * Generates a pure phase-inverted (`L = -R`) stereo test fixture (`correlation === -1.0`)
 * for stereo phase diagnostic verification.
 */
export const buildPhaseInvertedFixtureWav = (durationSec = 1.5, sampleRateHz = 44_100): Buffer => {
  const n = Math.round(durationSec * sampleRateHz);
  const chL = new Float32Array(n);
  const chR = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = 0.35 * Math.sin((2 * Math.PI * 220 * i) / sampleRateHz);
    chL[i] = v;
    chR[i] = -v;
  }
  return encodeWavPcm16([chL, chR], sampleRateHz);
};

export type ControlledEvalAudioSet = {
  readonly toneWav: { readonly buf: Buffer; readonly provenance: DawEvaluationProvenance };
  readonly clippedWav: { readonly buf: Buffer; readonly provenance: DawEvaluationProvenance };
  readonly mudWav: { readonly buf: Buffer; readonly provenance: DawEvaluationProvenance };
  readonly passWav: { readonly buf: Buffer; readonly provenance: DawEvaluationProvenance };
  readonly invertedWav: { readonly buf: Buffer; readonly provenance: DawEvaluationProvenance };
};

export const buildControlledEvalAudioSet = (): ControlledEvalAudioSet => {
  const now = new Date().toISOString();
  const mk = (id: string, buf: Buffer, notes: string): { readonly buf: Buffer; readonly provenance: DawEvaluationProvenance } => ({
    buf,
    provenance: {
      datasetId: id,
      sourceKind: 'reference_audio_wav',
      sha256: sha256Buffer(buf),
      manuallyVerifiedBy: 'phase-18-dsp-reference',
      verifiedAt: now,
      notes,
    },
  });

  return {
    toneWav: mk(
      'ref-audio-1khz-minus6db',
      buildAnalyticalToneWav(),
      '1000 Hz stereo sine amp=0.5 -> analytical sample peak -6.02 dBFS, RMS -9.03 dBFS, correlation +1.0',
    ),
    clippedWav: mk('fxt-aud-clip', buildClippedFixtureWav(), 'Hard-clipped +1.35 drive sine -> TRUE_PEAK_EXCEEDED CRITICAL'),
    mudWav: mk('fxt-aud-mud', buildMudFixtureWav(), '300 Hz low-mid hump -> LOW_MID_MUD masking detection'),
    passWav: mk('fxt-aud-pass', buildBalancedPassFixtureWav(), 'Balanced reference sweep passing master rubric'),
    invertedWav: mk(
      'ref-audio-phase-inverted',
      buildPhaseInvertedFixtureWav(),
      'L=-R polarity inversion -> stereoCorrelation -1.0 PHASE_CANCELLATION critical alert',
    ),
  };
};

/**
 * Controlled orphan routing snapshot fixture for testing missing/disconnected signal-flow diagnostics.
 */
export const buildControlledOrphanSnapshot = (sessionId: string): DawStateSnapshot => {
  const now = new Date().toISOString();
  const prov = {
    observedAt: now,
    dawId: 'ctrl-fixture-orphan',
    adapterId: 'synthetic-eval',
    hostVersion: '1.0.0',
    sourceEvidence: 'phase18:controlled_orphan_routing_fixture',
    freshness: 'observed' as const,
  };
  return {
    snapshotId: 'snap-eval-orphan',
    sessionId,
    freshness: 'observed',
    provenance: prov,
    transport: {
      playing: false,
      paused: false,
      recording: false,
      loopEnabled: false,
      songPositionBeats: 0,
      songPositionSeconds: 0,
      tempo: { bpm: 138, freshness: 'observed' },
      timeSignature: { numerator: 4, denominator: 4 },
      provenance: prov,
    },
    tracks: {
      status: 'available',
      value: [
        { id: 't0', index: 0, name: 'Master Track', kind: 'master', color: null, muted: false, soloed: false, armed: false, mixerChannelId: 'mixer:insert:0' },
        { id: 't1', index: 1, name: 'Lead Vocal', kind: 'audio', color: null, muted: false, soloed: false, armed: false, mixerChannelId: 'mixer:insert:1' },
        { id: 't2', index: 2, name: 'OrphanFX', kind: 'bus', color: null, muted: false, soloed: false, armed: false, mixerChannelId: 'mixer:insert:2' },
      ],
    },
    channels: {
      status: 'available',
      value: [
        { id: 'ch0', index: 0, name: 'Vocal Take', kind: 'audio_clip', targetMixerChannelId: 'mixer:insert:1', muted: false, soloed: false, volumeNormalized: 0.8, panNormalized: 0 },
      ],
    },
    mixerChannels: {
      status: 'available',
      value: [
        { id: 'mixer:insert:0', index: 0, name: 'Master', isMaster: true, volumeNormalized: 0.8, volumeDb: 0, panNormalized: 0, muted: false, soloed: false, stereoSeparation: null, peakDb: -1, pluginSlots: [] },
        {
          id: 'mixer:insert:1',
          index: 1,
          name: 'Lead Vocal',
          isMaster: false,
          volumeNormalized: 0.8,
          volumeDb: 0,
          panNormalized: 0,
          muted: false,
          soloed: false,
          stereoSeparation: null,
          peakDb: -8,
          pluginSlots: [
            {
              id: 'p-harmor',
              slotIndex: 0,
              containerId: 'mixer:insert:1',
              name: 'Harmor',
              vendor: 'Image-Line',
              format: 'NATIVE',
              bypassed: false,
              mixLevel: 1,
              editionCompatible: 'excluded_by_edition',
              parameterCount: 1,
              parameters: {
                status: 'available',
                value: [
                  { index: 0, id: 'p0', name: 'Filter Freq', valueNormalized: 0.5, displayValue: '50%', defaultNormalized: 0.5, unit: '%', readable: true, writable: false },
                ],
              },
            },
            {
              id: 'p-proq',
              slotIndex: 1,
              containerId: 'mixer:insert:1',
              name: 'FabFilter Pro-Q 3',
              vendor: 'FabFilter',
              format: 'VST3',
              bypassed: false,
              mixLevel: 1,
              editionCompatible: 'verified',
              parameterCount: 1,
              parameters: {
                status: 'available',
                value: [
                  { index: 0, id: 'p0', name: 'Band 1 Freq', valueNormalized: 0.25, displayValue: '120 Hz', defaultNormalized: 0.25, unit: 'Hz', readable: true, writable: true },
                ],
              },
            },
          ],
        },
        { id: 'mixer:insert:2', index: 2, name: 'OrphanFX', isMaster: false, volumeNormalized: 0.8, volumeDb: 0, panNormalized: 0, muted: false, soloed: false, stereoSeparation: null, peakDb: null, pluginSlots: [] },
        { id: 'mixer:insert:3', index: 3, name: 'IsolatedUnusedFX', isMaster: false, volumeNormalized: 0.8, volumeDb: 0, panNormalized: 0, muted: false, soloed: false, stereoSeparation: null, peakDb: null, pluginSlots: [] },
      ],
    },
    buses: { status: 'available', value: [{ id: 'b0', mixerChannelId: 'mixer:insert:0', name: 'Master', role: 'master', sourceIds: ['mixer:insert:1'], destinationId: null }] },
    routing: {
      status: 'available',
      value: [
        { id: 'r-1-0', sourceId: 'mixer:insert:1', targetId: 'mixer:insert:0', sendNormalized: 1, sendDb: 0, enabled: true, preFader: false, sidechain: false },
      ],
    },
    plugins: {
      status: 'available',
      value: [
        {
          id: 'p-harmor',
          slotIndex: 0,
          containerId: 'mixer:insert:1',
          name: 'Harmor',
          vendor: 'Image-Line',
          format: 'NATIVE',
          bypassed: false,
          mixLevel: 1,
          editionCompatible: 'excluded_by_edition',
          parameterCount: 1,
          parameters: {
            status: 'available',
            value: [
              { index: 0, id: 'p0', name: 'Filter Freq', valueNormalized: 0.5, displayValue: '50%', defaultNormalized: 0.5, unit: '%', readable: true, writable: false },
            ],
          },
        },
        {
          id: 'p-proq',
          slotIndex: 1,
          containerId: 'mixer:insert:1',
          name: 'FabFilter Pro-Q 3',
          vendor: 'FabFilter',
          format: 'VST3',
          bypassed: false,
          mixLevel: 1,
          editionCompatible: 'verified',
          parameterCount: 1,
          parameters: {
            status: 'available',
            value: [
              { index: 0, id: 'p0', name: 'Band 1 Freq', valueNormalized: 0.25, displayValue: '120 Hz', defaultNormalized: 0.25, unit: 'Hz', readable: true, writable: true },
            ],
          },
        },
      ],
    },
    automationLanes: { status: 'unsupported', reason: 'Controlled fixture omits automation splines' },
    audioClips: { status: 'available', value: [] },
    midiClips: { status: 'available', value: [] },
    markers: { status: 'unavailable', reason: 'Controlled fixture omits markers' },
    regions: { status: 'unavailable', reason: 'Controlled fixture omits regions' },
    stateDigest: 'eval-orphan-digest',
  };
};

export const verifyReadOnlyFileProvenance = (
  filePath: string,
  datasetId: string,
  inspectFn: (p: string) => unknown,
  notes: string,
): { readonly ok: boolean; readonly shaBefore: string; readonly shaAfter: string; readonly parsed: unknown; readonly provenance: DawEvaluationProvenance } => {
  const rawBefore = fs.readFileSync(filePath);
  const shaBefore = sha256Buffer(rawBefore);
  const parsed = inspectFn(filePath);
  const rawAfter = fs.readFileSync(filePath);
  const shaAfter = sha256Buffer(rawAfter);
  return {
    ok: shaBefore === shaAfter,
    shaBefore,
    shaAfter,
    parsed,
    provenance: {
      datasetId,
      sourceKind: 'user_approved_project',
      sourcePath: filePath,
      sha256: shaBefore,
      manuallyVerifiedBy: 'sha256-integrity-verifier',
      verifiedAt: new Date().toISOString(),
      notes,
    },
  };
};
