import type { VoiceStatus } from './voice-status.ts';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * The orb's state from the command bar's own signals: the owner recording or a command in flight (local), and what
 * Jarvis reports on his voice stream (remote). Speaking wins, then thinking, then listening.
 */
export const orbStateOf = (s: { readonly recording: boolean; readonly busy: boolean; readonly remote: VoiceStatus }): OrbState =>
  s.remote === 'speaking' ? 'speaking'
    : s.busy || s.remote === 'thinking' ? 'thinking'
    : s.recording || s.remote === 'listening' ? 'listening'
    : 'idle';

/** Which look fits a state: bars while Jarvis speaks, the core while the owner is heard, ripples otherwise. */
export const orbModeOf = (state: OrbState): 'voice' | 'signal' | 'speaking' =>
  state === 'speaking' ? 'speaking' : state === 'listening' ? 'voice' : 'signal';
