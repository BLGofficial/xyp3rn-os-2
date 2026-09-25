import { describe, expect, it } from 'vitest';
import { local } from './paths.ts';

// A form's return path must stay on this origin: the server actions redirect to it.
describe('local', () => {
  it('keeps same-origin paths and refuses anything a browser would send elsewhere', () => {
    expect(local('/songs/1?tab=x', '/')).toBe('/songs/1?tab=x');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '',
    // The URL parser drops tabs and newlines, so these become //evil.example in the browser.
    '/\t/evil.example', '/\n/evil.example', '/\r\n/evil.example', '\t//evil.example']) expect(local(bad, '/tasks')).toBe('/tasks');
  });
});
