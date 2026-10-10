import { describe, expect, it } from 'vitest';
import { ringStateOf } from './ring-voice.ts';
import { VOICE_STATUSES } from './voice-status.ts';

describe('ringStateOf', () => {
  it('maps the awake voice states to the ring and lets idle and error fall back', () => {
    expect(ringStateOf('listening')).toBe('listening');
    expect(ringStateOf('thinking')).toBe('processing');
    expect(ringStateOf('speaking')).toBe('speaking');
    expect(ringStateOf('idle')).toBeNull();
    expect(ringStateOf('error')).toBeNull();
  });

  it('covers every status the voice bus can emit', () => {
    for (const s of VOICE_STATUSES) expect(() => ringStateOf(s)).not.toThrow();
  });
});
