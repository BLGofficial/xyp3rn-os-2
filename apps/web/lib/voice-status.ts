/**
 * JARVIS voice-status contract. One status value, emitted by the voice server, drives every face of the voice agent
 * (the Galaxy orb, the HUD globe). Pure: no DOM, no network, so both speech stacks can share it.
 */

/**
 * Motion mode. Mirrors `Motion` in app/hud/hud-shell.tsx; not imported from it because the root tsconfig compiles
 * apps/web/lib without `jsx`, and a .tsx import would fail `pnpm typecheck` (TS6142).
 */
export type MotionMode = 'cinematic' | 'calm' | 'off';

/** The five states the status orb and the map share. */
export const VOICE_STATUSES = ['idle', 'listening', 'thinking', 'speaking', 'error'] as const;
export type VoiceStatus = (typeof VOICE_STATUSES)[number];

/** One status event. `seq` is how a consumer drops a stale event; `level` is the mic or TTS level, 0..1. */
export type VoiceEvent = { readonly status: VoiceStatus; readonly level: number; readonly seq: number };

/** Colour family for the core glow. Names, not hexes: each face resolves them against its own theme. */
export type VoiceTone = 'neutral' | 'cyan' | 'amber' | 'plum' | 'error';

/** What a face should animate. `null` means that loop or cue is off. */
export type MotionSpec = {
  readonly animate: boolean;
  readonly tone: VoiceTone;
  readonly shellsRotate: boolean;
  readonly coreBreathSec: number | null;
  readonly glowBreathSec: number | null;
  readonly rippleSec: number | null;
  readonly arcSec: number | null;
  readonly beatSec: number | null;
  readonly glowScale: number;
  readonly beatAmplitude: number;
  readonly beadsPerAgentCall: number;
};

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

const isStatus = (v: unknown): v is VoiceStatus => typeof v === 'string' && (VOICE_STATUSES as readonly string[]).includes(v);

/**
 * Validate an untrusted status event (it crosses a process boundary). A missing level is 0 and a finite one is
 * clamped, so a slightly-off meter never drops the state change; everything else malformed returns null.
 */
export function parseVoiceStatus(raw: unknown): VoiceEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { status, level, seq } = raw as Record<string, unknown>;
  if (!isStatus(status)) return null;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;
  if (level === undefined) return { status, level: 0, seq };
  if (typeof level !== 'number' || !Number.isFinite(level)) return null;
  return { status, level: clamp01(level), seq };
}

// Timings: 1.2 / 0.8 / 0.45 s are the existing status orb's (galaxy/viewer/index.html); 7 / 9 s are the reference
// galaxy's core and glow breathing. The two scale constants are proposals, not measured.
const CORE_BREATH_SEC = 7;
const GLOW_BREATH_SEC = 9;
const RIPPLE_SEC = 1.2;
const ARC_SEC = 0.8;
const BEAT_SEC = 0.45;
const GLOW_GAIN = 0.5;
const BEAT_GAIN = 0.08;

const TONE: Readonly<Record<VoiceStatus, VoiceTone>> = { idle: 'neutral', listening: 'cyan', thinking: 'amber', speaking: 'plum', error: 'error' };

/**
 * Map a status to motion. Cinematic runs everything. Calm drops the ambient loops but keeps the status cues, so
 * listening, thinking and speaking stay tellable apart. Off is one static frame (prefers-reduced-motion) that still
 * shows the status tone. Error stops everything: a failed state must not look alive.
 */
export function motionFor(status: VoiceStatus, level: number, motion: MotionMode): MotionSpec {
  const l = clamp01(level);
  const tone = TONE[status];
  if (motion === 'off' || status === 'error') {
    return { animate: false, tone, shellsRotate: false, coreBreathSec: null, glowBreathSec: null, rippleSec: null, arcSec: null, beatSec: null, glowScale: 1, beatAmplitude: 0, beadsPerAgentCall: 0 };
  }
  const spec = {
    tone,
    shellsRotate: motion === 'cinematic',
    coreBreathSec: motion === 'cinematic' ? CORE_BREATH_SEC : null,
    glowBreathSec: motion === 'cinematic' ? GLOW_BREATH_SEC : null,
    rippleSec: status === 'listening' ? RIPPLE_SEC : null,
    arcSec: status === 'thinking' ? ARC_SEC : null,
    beatSec: status === 'speaking' ? BEAT_SEC : null,
    glowScale: status === 'listening' ? 1 + GLOW_GAIN * l : 1,
    beatAmplitude: status === 'speaking' ? BEAT_GAIN * l : 0,
    beadsPerAgentCall: status === 'thinking' ? 1 : 0,
  };
  const cue = spec.rippleSec !== null || spec.arcSec !== null || spec.beatSec !== null;
  return { ...spec, animate: spec.shellsRotate || cue };
}
