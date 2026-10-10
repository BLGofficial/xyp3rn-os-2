import { describe, expect, it } from 'vitest';
import { orbModeOf, orbStateOf } from './voice-orb-state.ts';

describe('orbStateOf', () => {
  const idle = { recording: false, busy: false, remote: 'idle' } as const;
  it('is idle with nothing going on', () => expect(orbStateOf(idle)).toBe('idle'));
  it('listens while the owner records or Jarvis listens', () => {
    expect(orbStateOf({ ...idle, recording: true })).toBe('listening');
    expect(orbStateOf({ ...idle, remote: 'listening' })).toBe('listening');
  });
  it('thinks while a command is in flight or Jarvis thinks', () => {
    expect(orbStateOf({ ...idle, busy: true })).toBe('thinking');
    expect(orbStateOf({ ...idle, remote: 'thinking' })).toBe('thinking');
  });
  it('speaking outranks everything else', () => expect(orbStateOf({ recording: true, busy: true, remote: 'speaking' })).toBe('speaking'));
});

describe('orbModeOf', () => {
  it('picks the look from the state', () => {
    expect(orbModeOf('speaking')).toBe('speaking');
    expect(orbModeOf('listening')).toBe('voice');
    expect(orbModeOf('thinking')).toBe('signal');
    expect(orbModeOf('idle')).toBe('signal');
  });
});
