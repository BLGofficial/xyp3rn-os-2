import type { MotionSpec, VoiceTone } from './voice-status.ts';

/**
 * The HUD globe's core, driven by the voice status. Pure: it returns what to draw and the globe draws it, so the
 * canvas stays the only untested part. The neutral, Motion-Off cue is exactly the glow hud-globe.tsx drew before
 * voice existed, which is what keeps a null voice a no-op.
 */

/** Glow tint per tone. neutral is the globe's existing gold; cyan, amber and plum are the status orb's (galaxy/viewer); error is the JARVIS signal-error token. */
export const TONE_HEX: Readonly<Record<VoiceTone, string>> = { neutral: '#F7C948', cyan: '#72d6f7', amber: '#d8ab55', plum: '#b258a5', error: '#ff5a4a' };

/** One expanding ring: `r` scales the core radius, `alpha` fades it. */
export type CoreRing = { readonly r: number; readonly alpha: number };

/** What to draw at the core: glow tint, glow size and alpha multipliers, ripple rings, and an optional rim arc (radians). */
export type CoreCue = {
  readonly tint: string;
  readonly glowScale: number;
  readonly glowAlpha: number;
  readonly rings: readonly CoreRing[];
  readonly arc: { readonly start: number; readonly length: number } | null;
};

const TAU = Math.PI * 2;
/** Fractional part, always in [0, 1), so negative and huge times stay periodic. */
const frac = (x: number): number => x - Math.floor(x);
/** 0 to 1 and back over `periodSec`, starting at 0. */
const swell = (t: number, periodSec: number): number => 0.5 - 0.5 * Math.cos((TAU * t) / periodSec);

// Reference galaxy: core 100 to 105.5 percent, glow alpha .62 to .95 (galaxy-measurements.json, Remotion formulas).
const CORE_SWELL = 0.055;
const ALPHA_MIN = 0.62;
const ALPHA_SPAN = 0.33;
// Ring grows 0.6 to 1.8 while it fades: the status orb's ripple keyframes (galaxy/viewer/index.html).
const RING_FROM = 0.6;
const RING_SPAN = 1.2;
// The orb's spinner is two quarter borders: a half circle.
const ARC_LENGTH = Math.PI;

/**
 * The core's look at time `tSec` for a motion spec (see `motionFor`). Loops the spec turns off (null) contribute
 * nothing, so Calm, Off and error fall back to a still glow in the status tone.
 * @param spec - the motion spec for the current voice status, level and motion mode
 * @param tSec - seconds on any steady clock; only its phase matters
 * @returns the tint, glow multipliers, rings and arc to draw
 */
export function coreCue(spec: MotionSpec, tSec: number): CoreCue {
  const breath = spec.coreBreathSec === null ? 1 : 1 + CORE_SWELL * swell(tSec, spec.coreBreathSec);
  const beat = spec.beatSec === null ? 1 : 1 + spec.beatAmplitude * swell(tSec, spec.beatSec * 2); // the orb's beat alternates, so a full cycle is 2 x 0.45 s
  const phase = spec.rippleSec === null ? 0 : frac(tSec / spec.rippleSec);
  return {
    tint: TONE_HEX[spec.tone],
    glowScale: spec.glowScale * breath * beat,
    glowAlpha: spec.glowBreathSec === null ? 1 : ALPHA_MIN + ALPHA_SPAN * swell(tSec, spec.glowBreathSec),
    rings: spec.rippleSec === null ? [] : [{ r: RING_FROM + RING_SPAN * phase, alpha: 1 - phase }],
    arc: spec.arcSec === null ? null : { start: -Math.PI / 2 + TAU * frac(tSec / spec.arcSec), length: ARC_LENGTH },
  };
}
