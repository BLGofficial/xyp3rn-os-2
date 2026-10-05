import { describe, expect, it } from 'vitest';
import { motionFor, parseVoiceStatus, VOICE_STATUSES } from './voice-status.ts';

// JARVIS voice-status contract (approach C): one status value, emitted by galaxy/server.py, drives every face of
// the voice agent. This is the seam between the two speech stacks, so it is pure and has no DOM or network.
// Timings 1.2 s / 0.8 s / 0.45 s are the existing status orb's (galaxy/viewer/index.html); 7 s / 9 s are the
// reference galaxy's core and glow breathing (galaxy-measurements.json). Level scaling is a proposal, not measured.

describe('VOICE_STATUSES', () => {
  it('is exactly the five states the orb and the map share', () => {
    expect([...VOICE_STATUSES]).toEqual(['idle', 'listening', 'thinking', 'speaking', 'error']);
  });
});

describe('parseVoiceStatus', () => {
  it('accepts a well-formed event', () => {
    expect(parseVoiceStatus({ status: 'listening', level: 0.4, seq: 7 })).toEqual({ status: 'listening', level: 0.4, seq: 7 });
  });

  it('defaults a missing level to 0, so a bare status event is valid', () => {
    expect(parseVoiceStatus({ status: 'idle', seq: 1 })).toEqual({ status: 'idle', level: 0, seq: 1 });
  });

  it('clamps a finite level into 0..1 rather than dropping the event', () => {
    expect(parseVoiceStatus({ status: 'speaking', level: 3, seq: 2 })?.level).toBe(1);
    expect(parseVoiceStatus({ status: 'speaking', level: -1, seq: 2 })?.level).toBe(0);
  });

  it('refuses anything that is not a known status, a finite level and a non-negative integer seq', () => {
    expect(parseVoiceStatus({ status: 'dancing', level: 0, seq: 1 })).toBeNull();
    expect(parseVoiceStatus({ status: 'idle', level: Number.NaN, seq: 1 })).toBeNull();
    expect(parseVoiceStatus({ status: 'idle', level: 0, seq: -1 })).toBeNull();
    expect(parseVoiceStatus({ status: 'idle', level: 0, seq: 1.5 })).toBeNull();
    expect(parseVoiceStatus({ status: 'idle', level: 0 })).toBeNull(); // seq is how a consumer drops stale events
    expect(parseVoiceStatus(null)).toBeNull();
    expect(parseVoiceStatus('listening')).toBeNull();
  });
});

describe('motionFor', () => {
  it('idle (cinematic): shells turn, core breathes 7 s, glow breathes 9 s, no status cue', () => {
    const m = motionFor('idle', 0, 'cinematic');
    expect(m).toMatchObject({ animate: true, shellsRotate: true, coreBreathSec: 7, glowBreathSec: 9, tone: 'neutral' });
    expect(m.rippleSec).toBeNull();
    expect(m.arcSec).toBeNull();
    expect(m.beatSec).toBeNull();
  });

  it('listening: cyan, ripples every 1.2 s, glow radius never shrinks as the mic level rises', () => {
    const quiet = motionFor('listening', 0, 'cinematic');
    const loud = motionFor('listening', 1, 'cinematic');
    expect(quiet).toMatchObject({ tone: 'cyan', rippleSec: 1.2 });
    expect(loud.glowScale).toBeGreaterThan(quiet.glowScale);
    expect(motionFor('listening', 0.5, 'cinematic').glowScale).toBeGreaterThanOrEqual(quiet.glowScale);
  });

  it('thinking: amber, a 0.8 s arc on the core rim, and one bead per running agent call', () => {
    expect(motionFor('thinking', 0, 'cinematic')).toMatchObject({ tone: 'amber', arcSec: 0.8, beadsPerAgentCall: 1 });
  });

  it('speaking: plum, beats at 0.45 s, amplitude follows the TTS level and is zero when silent', () => {
    const silent = motionFor('speaking', 0, 'cinematic');
    const loud = motionFor('speaking', 1, 'cinematic');
    expect(loud).toMatchObject({ tone: 'plum', beatSec: 0.45 });
    expect(silent.beatAmplitude).toBe(0);
    expect(loud.beatAmplitude).toBeGreaterThan(0);
  });

  it('error: error tone, every loop and cue stopped (a failed state must not look alive)', () => {
    const m = motionFor('error', 1, 'cinematic');
    expect(m.tone).toBe('error');
    expect(m.shellsRotate).toBe(false);
    expect(m.coreBreathSec).toBeNull();
    expect(m.glowBreathSec).toBeNull();
    expect(m.rippleSec).toBeNull();
    expect(m.arcSec).toBeNull();
    expect(m.beatSec).toBeNull();
  });

  it('off: one static frame for every status (prefers-reduced-motion), but the status tone still shows', () => {
    for (const s of VOICE_STATUSES) {
      const m = motionFor(s, 1, 'off');
      expect(m.animate).toBe(false);
      expect(m.shellsRotate).toBe(false);
      expect(m.coreBreathSec).toBeNull();
      expect(m.glowBreathSec).toBeNull();
      expect(m.rippleSec).toBeNull();
      expect(m.arcSec).toBeNull();
      expect(m.beatSec).toBeNull();
    }
    expect(motionFor('listening', 0, 'off').tone).toBe('cyan');
  });

  // ASSUMPTION to confirm: Calm drops the ambient loops (shells, breathing) and keeps the status cues,
  // because the owner must still be able to tell listening from thinking from speaking.
  it('calm: no ambient loops, status cues kept', () => {
    const idle = motionFor('idle', 0, 'calm');
    expect(idle.shellsRotate).toBe(false);
    expect(idle.coreBreathSec).toBeNull();
    expect(motionFor('listening', 0.5, 'calm').rippleSec).toBe(1.2);
    expect(motionFor('thinking', 0, 'calm').arcSec).toBe(0.8);
    expect(motionFor('speaking', 0.5, 'calm').beatSec).toBe(0.45);
  });

  it('is deterministic and clamps an out-of-range level the same way parse does', () => {
    expect(motionFor('speaking', 0.37, 'cinematic')).toEqual(motionFor('speaking', 0.37, 'cinematic'));
    expect(motionFor('speaking', 9, 'cinematic')).toEqual(motionFor('speaking', 1, 'cinematic'));
    expect(motionFor('speaking', -9, 'cinematic')).toEqual(motionFor('speaking', 0, 'cinematic'));
  });
});
