import type { VoiceStatus } from './voice-status.ts';

/** The ring's state words are the web's; Jarvis's are the voice bus's. */
export type RingVoiceState = 'listening' | 'processing' | 'speaking';

/**
 * What Jarvis's voice status does to the ring. Idle and error return null: the ring then falls back to agent-run
 * activity (and to standby), so a voice error never freezes the ring in an awake state.
 */
export const ringStateOf = (status: VoiceStatus): RingVoiceState | null =>
  status === 'listening' ? 'listening' : status === 'thinking' ? 'processing' : status === 'speaking' ? 'speaking' : null;
