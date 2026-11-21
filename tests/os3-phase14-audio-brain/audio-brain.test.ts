import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AudioBrain,
  buildBalancedPassFixtureWav,
  buildClippedFixtureWav,
  buildMudFixtureWav,
  decodeWavBuffer,
  encodeWavFloat32,
  encodeWavPcm16,
} from '../../core/daw-brain/index.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import { validateTraceAnalysis } from '../../tech/trace/analysis.ts';

describe('Phase 14 — XYP3RN Audio Brain (DSP, MIR & Evaluation Fixtures)', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];

  afterEach(() => {
    while (openDbs.length > 0) openDbs.pop()?.close();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const makeTempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xyp3rn-phase14-audio-'));
    tempDirs.push(dir);
    return dir;
  };

  it('1. decodes PCM16 & IEEE Float32 WAV non-destructively, preserves SHA-256, rejects corrupt headers & internal FL RAM taps', () => {
    const dir = makeTempDir();
    const brain = new AudioBrain();

    // IEEE Float32 encoding check
    const sr = 44_100;
    const chL = new Float32Array(sr);
    for (let i = 0; i < sr; i += 1) chL[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / sr);
    const f32Path = path.join(dir, 'mono_440_f32.wav');
    const f32Buf = encodeWavFloat32([chL], sr);
    const expectedHash = createHash('sha256').update(f32Buf).digest('hex');
    fs.writeFileSync(f32Path, f32Buf);

    const decoded = decodeWavBuffer(fs.readFileSync(f32Path));
    expect(decoded.encoding).toBe('ieee_float32');
    expect(decoded.channels).toBe(1);
    expect(decoded.sampleRateHz).toBe(44_100);

    const report = brain.analyzeAudioFile(f32Path, { stage: 'mix' });
    expect(report.acquisition.sha256BeforeRead).toBe(expectedHash);
    expect(report.acquisition.sha256AfterRead).toBe(expectedHash);
    expect(report.acquisition.readOnlyVerified).toBe(true);
    expect(report.limitations.some((l) => l.includes('Mono source audio'))).toBe(true);
    expect(validateTraceAnalysis(report.traceAnalysis)).toHaveLength(0);

    // Corrupt WAV fails cleanly
    const corruptPath = path.join(dir, 'corrupt.wav');
    fs.writeFileSync(corruptPath, Buffer.from('NOT_A_WAV_HEADER_OR_RIFF_STREAM_BYTES_1234567890'));
    expect(() => brain.analyzeAudioFile(corruptPath)).toThrow(/INVALID_AUDIO_FILE/);

    // Refuses direct FL Studio Producer Edition internal mixer audio tap cleanly
    expect(() => brain.refuseInternalDawBufferTap('FL Studio Master Insert RAM')).toThrow(/does not expose direct live internal mixer PCM buffers/i);
  });

  it('2. passes FXT-AUD-CLIP, FXT-AUD-MUD, FXT-AUD-PASS evaluation fixtures, stereo phase inversion & silence checks', () => {
    const dir = makeTempDir();
    const brain = new AudioBrain();

    const clipPath = path.join(dir, 'fxt-clip.wav');
    const mudPath = path.join(dir, 'fxt-mud.wav');
    const passPath = path.join(dir, 'fxt-pass.wav');
    const outOfPhasePath = path.join(dir, 'fxt-phase-invert.wav');
    const silentPath = path.join(dir, 'fxt-silent.wav');

    fs.writeFileSync(clipPath, buildClippedFixtureWav());
    fs.writeFileSync(mudPath, buildMudFixtureWav());
    fs.writeFileSync(passPath, buildBalancedPassFixtureWav());

    // Out-of-phase sub/full stereo (-1 correlation)
    const sr = 44_100;
    const n = sr * 2;
    const invL = new Float32Array(n);
    const invR = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const v = 0.25 * Math.sin((2 * Math.PI * 50 * i) / sr) + 0.15 * Math.sin((2 * Math.PI * 500 * i) / sr);
      invL[i] = v;
      invR[i] = -v;
    }
    fs.writeFileSync(outOfPhasePath, encodeWavPcm16([invL, invR], sr));
    fs.writeFileSync(silentPath, encodeWavPcm16([new Float32Array(n), new Float32Array(n)], sr));

    // FXT-AUD-CLIP
    const clipRep = brain.analyzeAudioFile(clipPath, { stage: 'master' });
    expect(clipRep.diagnostics.overallVerdict).toBe('CRITICAL');
    expect(clipRep.features.clipping.exceedsZeroDbfs).toBe(true);
    expect(clipRep.diagnostics.alerts.some((a) => a.code === 'TRUE_PEAK_EXCEEDED')).toBe(true);
    expect(clipRep.diagnostics.alerts.some((a) => a.code === 'HARD_SAMPLE_CLIPPING')).toBe(true);
    expect(clipRep.recommendations.some((r) => r.actionType === 'gain_trim')).toBe(true);

    // FXT-AUD-MUD
    const mudRep = brain.analyzeAudioFile(mudPath, { stage: 'mix' });
    expect(mudRep.diagnostics.alerts.some((a) => a.code === 'LOW_MID_MASKING_MUD')).toBe(true);
    expect(mudRep.recommendations.some((r) => r.actionType === 'eq_attenuation')).toBe(true);

    // FXT-AUD-PASS
    const passRep = brain.analyzeAudioFile(passPath, {
      stage: 'master',
      rubricBounds: {
        'loudness.true-peak-dbtp': { max: -1.0 },
        'dynamics.crest-factor-db': { min: 5.5 },
        'stereo.correlation': { min: 0.15 },
        'stereo.sub.width-pct': { max: 10 },
      },
    });
    expect(passRep.diagnostics.overallVerdict).toBe('PASS');
    expect(passRep.features.stereo.correlation).toBeGreaterThan(0.8);
    expect(passRep.features.stereo.subWidthPct).toBeLessThanOrEqual(10);
    expect(passRep.diagnostics.unsetMetrics.length).toBeGreaterThan(0);

    // Out-of-phase negative correlation
    const phaseRep = brain.analyzeAudioFile(outOfPhasePath, { stage: 'master' });
    expect(phaseRep.features.stereo.correlation).toBeLessThan(-0.9);
    expect(phaseRep.diagnostics.alerts.some((a) => a.code === 'NEGATIVE_STEREO_CORRELATION')).toBe(true);
    expect(phaseRep.diagnostics.alerts.some((a) => a.code === 'SUB_STEREO_WIDTH_PHASE')).toBe(true);

    // Effective silence
    const silRep = brain.analyzeAudioFile(silentPath, { stage: 'mix' });
    expect(silRep.features.silence.isEffectiveSilence).toBe(true);
    expect(silRep.diagnostics.alerts.some((a) => a.code === 'SILENT_OR_TRUNCATED_RENDER')).toBe(true);
  });

  it('3. performs probabilistic MIR (tempo, beat grid, onsets, chroma, key, HPR, sections, classification) with explicit probabilistic labels', () => {
    const dir = makeTempDir();
    const sr = 44_100;
    const durationSec = 4.0;
    const n = Math.round(sr * durationSec);
    const beatL = new Float32Array(n);
    const beatR = new Float32Array(n);

    // Synthesize clear 120 BPM drum pulses (every 0.5 s) + C Major sustained triad (C4=261.63, E4=329.63, G4=392.0)
    for (let i = 0; i < n; i += 1) {
      const t = i / sr;
      const pulsePhase = t % 0.5;
      const transient = pulsePhase < 0.04 ? Math.exp(-pulsePhase * 85) * Math.sin(2 * Math.PI * 180 * pulsePhase) * 0.6 : 0;
      const chord =
        0.1 * Math.sin(2 * Math.PI * 261.63 * t) +
        0.09 * Math.sin(2 * Math.PI * 329.63 * t) +
        0.09 * Math.sin(2 * Math.PI * 392.0 * t);
      beatL[i] = transient + chord;
      beatR[i] = transient + chord;
    }

    const wavPath = path.join(dir, '120bpm_cmaj.wav');
    fs.writeFileSync(wavPath, encodeWavPcm16([beatL, beatR], sr));

    const brain = new AudioBrain();
    const report = brain.analyzeAudioFile(wavPath, { stage: 'master' });
    expect(report.mir.status).toBe('available');
    if (report.mir.status === 'available') {
      const mir = report.mir.value;
      expect(mir.probabilistic).toBe(true);
      expect(mir.tempoEstimate.probabilistic).toBe(true);
      expect(mir.keyEstimate.probabilistic).toBe(true);
      expect(mir.onsetDetection.onsetCount).toBeGreaterThanOrEqual(6);
      // Autocorrelation hits ~120 BPM (or harmonic sub-multiple 60/120 BPM)
      expect(mir.tempoEstimate.bpm).not.toBeNull();
      const bpm = mir.tempoEstimate.bpm!;
      expect(Math.abs(bpm - 120) < 8 || Math.abs(bpm - 60) < 4).toBe(true);
      // C major chroma peaks strongly on C / E / G
      expect((mir.chroma.C ?? 0) + (mir.chroma.E ?? 0) + (mir.chroma.G ?? 0)).toBeGreaterThan(1.5);
      expect(mir.sections.length).toBeGreaterThanOrEqual(2);
      expect(mir.sourceClassification.confidence).toBeGreaterThan(0.2);
    }
  });

  it('4. supports verified streams, external trace.analysis/v1 ingestion (honestly skipping MIR), SQLite persistence & performance benchmark', () => {
    const db = openRuntimeDb(':memory:');
    openDbs.push(db);
    const brain = new AudioBrain();

    // Benchmark 3s 44.1kHz stereo PCM analysis latency
    const balBuf = buildBalancedPassFixtureWav(3.0, 44_100);
    const dec = decodeWavBuffer(balBuf);

    const t0 = performance.now();
    const streamRep = brain.analyzeVerifiedStream(
      {
        streamId: 'stream-master-01',
        label: 'Verified Stream Render',
        sampleRateHz: dec.sampleRateHz,
        channelData: dec.channelData,
      },
      { stage: 'master', db, sessionId: null },
    );
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(2_500);
    expect(streamRep.acquisition.sourceKind).toBe('verified_daw_stream');

    // External TRACE analysis must validate & honestly mark MIR unavailable (not fabricate tempo/key!)
    const traceRep = brain.analyzeExternalTrace(streamRep.traceAnalysis, {
      stage: 'master',
      label: 'TRACE-VST3-Bounce',
      db,
    });
    expect(traceRep.acquisition.sourceKind).toBe('exported_analysis');
    expect(traceRep.mir.status).toBe('unavailable');
    expect(traceRep.limitations.some((l) => l.includes('MIR'))).toBe(true);

    const stored = db.listDawAudioAnalyses({ limit: 10 });
    expect(stored).toHaveLength(2);
    expect(stored[0]?.sourceKind === 'trace_vst' || stored[1]?.sourceKind === 'trace_vst').toBe(true);

    const md = brain.formatMarkdownReport(streamRep);
    expect(md).toContain('# Audio Brain Analysis Report');
    expect(md).toContain('LUFS');
  });
});
