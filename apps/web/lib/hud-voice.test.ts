import { describe, expect, it } from 'vitest';
import { coreCue, TONE_HEX } from './hud-voice.ts';
import { motionFor, VOICE_STATUSES } from './voice-status.ts';

// The HUD globe's core, driven by the voice status (approach 1: a pure cue, the globe only draws it). A null voice must
// leave today's picture untouched, so the neutral/off cue is pinned to exactly what hud-globe.tsx draws now: the
// #F7C948 glow sprite at R * 0.9, no ring, no arc. Tone hexes: cyan, plum and amber are the existing status orb's
// (galaxy/viewer/index.html), error is the JARVIS signal-error token. Breathing numbers come from the reference
// galaxy (core 100 to 105.5 percent over 7 s, glow alpha .62 to .95 over 9 s).

describe('TONE_HEX', () => {
  it('keeps neutral at the glow the globe draws today, and takes the orb colours for the voice tones', () => {
    expect(TONE_HEX).toEqual({ neutral: '#F7C948', cyan: '#72d6f7', amber: '#d8ab55', plum: '#b258a5', error: '#ff5a4a' });
  });
});

describe('coreCue', () => {
  it('idle with Motion Off is exactly the current picture: neutral glow, scale 1, alpha 1, no ring, no arc', () => {
    expect(coreCue(motionFor('idle', 0, 'off'), 3.7)).toEqual({ tint: '#F7C948', glowScale: 1, glowAlpha: 1, rings: [], arc: null });
  });

  it('tints the glow by status, even with Motion Off (the status must stay readable)', () => {
    expect(coreCue(motionFor('listening', 0, 'off'), 0).tint).toBe(TONE_HEX.cyan);
    expect(coreCue(motionFor('thinking', 0, 'off'), 0).tint).toBe(TONE_HEX.amber);
    expect(coreCue(motionFor('speaking', 0, 'off'), 0).tint).toBe(TONE_HEX.plum);
    expect(coreCue(motionFor('error', 0, 'off'), 0).tint).toBe(TONE_HEX.error);
  });

  it('cinematic idle breathes: core 1 to 1.055 over 7 s, glow alpha .62 to .95 over 9 s, both periodic', () => {
    const idle = motionFor('idle', 0, 'cinematic');
    expect(coreCue(idle, 0).glowScale).toBeCloseTo(1, 12);
    expect(coreCue(idle, 3.5).glowScale).toBeCloseTo(1.055, 12);
    expect(coreCue(idle, 7).glowScale).toBeCloseTo(1, 12);
    expect(coreCue(idle, 0).glowAlpha).toBeCloseTo(0.62, 12);
    expect(coreCue(idle, 4.5).glowAlpha).toBeCloseTo(0.95, 12);
    expect(coreCue(idle, 9).glowAlpha).toBeCloseTo(0.62, 12);
    for (let t = 0; t < 20; t += 0.37) expect(coreCue(idle, t).glowScale).toBeGreaterThanOrEqual(1);
  });

  it('listening: one ripple ring per 1.2 s, growing 0.6 to 1.8 while it fades, wrapping exactly at the period', () => {
    const calm = motionFor('listening', 0, 'calm');
    expect(coreCue(calm, 0).rings).toEqual([{ r: 0.6, alpha: 1 }]);
    const mid = coreCue(calm, 0.6).rings[0]!;
    expect(mid.r).toBeCloseTo(1.2, 12);
    expect(mid.alpha).toBeCloseTo(0.5, 12);
    expect(coreCue(calm, 1.2).rings).toEqual(coreCue(calm, 0).rings);
  });

  it('listening: a louder mic grows the glow and never shrinks it', () => {
    const at = (level: number) => coreCue(motionFor('listening', level, 'calm'), 0).glowScale;
    expect(at(0)).toBe(1);
    expect(at(1)).toBeGreaterThan(at(0.5));
    expect(at(0.5)).toBeGreaterThan(at(0));
  });

  it('thinking: a half-circle arc on the rim, one turn per 0.8 s, starting at 12 o clock', () => {
    const calm = motionFor('thinking', 0, 'calm');
    expect(coreCue(calm, 0).arc).toEqual({ start: -Math.PI / 2, length: Math.PI });
    expect(coreCue(calm, 0.4).arc!.start).toBeCloseTo(Math.PI / 2, 12);
    expect(coreCue(calm, 0.8).arc!.start).toBeCloseTo(-Math.PI / 2, 12); // wraps, it never grows without bound
  });

  it('speaking: the glow beats between 1 and 1 + amplitude, peaking at 0.45 s; silent means no beat', () => {
    const loud = motionFor('speaking', 1, 'calm');
    expect(coreCue(loud, 0).glowScale).toBeCloseTo(1, 12);
    expect(coreCue(loud, 0.45).glowScale).toBeCloseTo(1.08, 12);
    expect(coreCue(loud, 0.9).glowScale).toBeCloseTo(1, 12);
    const silent = motionFor('speaking', 0, 'calm');
    for (let t = 0; t < 2; t += 0.1) expect(coreCue(silent, t).glowScale).toBe(1);
  });

  it('calm keeps status cues but has no breathing', () => {
    const idle = coreCue(motionFor('idle', 0, 'calm'), 3.5);
    expect(idle.glowScale).toBe(1);
    expect(idle.glowAlpha).toBe(1);
  });

  it('error draws no ring, no arc and no motion, whatever the time or level', () => {
    for (const t of [0, 0.3, 3.5, 100]) {
      expect(coreCue(motionFor('error', 1, 'cinematic'), t)).toEqual({ tint: TONE_HEX.error, glowScale: 1, glowAlpha: 1, rings: [], arc: null });
    }
  });

  it('is deterministic, and finite for every status at negative or huge times', () => {
    for (const s of VOICE_STATUSES) {
      const spec = motionFor(s, 0.5, 'cinematic');
      for (const t of [-5.3, 0, 1e6]) {
        const c = coreCue(spec, t);
        expect(c).toEqual(coreCue(spec, t));
        expect(Number.isFinite(c.glowScale) && Number.isFinite(c.glowAlpha)).toBe(true);
        for (const r of c.rings) expect(r.r >= 0.6 && r.r <= 1.8 && r.alpha >= 0 && r.alpha <= 1).toBe(true);
      }
    }
  });
});
