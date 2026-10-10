import { describe, expect, it } from 'vitest';
import { commandViaCore, isCoreCommand, type CoreRuntime } from './jarvis-core.ts';

// A scripted read-only transaction: the monday-review sweep reads inbox, splits, trace, queue in that order.
const rt = (): CoreRuntime => {
  const results: unknown[][] = [[{ n: 0, paths: [] }], [{ checked: 0, bad: [] }], [{ total: 0, unlinked: 0, latest: null }], []];
  let at = 0;
  const tx = Object.assign(async () => results[at++], { unsafe: async () => [] });
  return { deps: { sql: { begin: async (_m: string, fn: (t: typeof tx) => unknown) => fn(tx) } }, engine: async () => { throw new Error('not used'); } } as never;
};

describe('command bar to JarvisCore', () => {
  it('takes only the deterministic playbook command', () => {
    expect(isCoreCommand('run monday review')).toBe(true);
    expect(isCoreCommand('remember that I wrote lyrics yesterday')).toBe(false);
    expect(isCoreCommand('write lyrics for a dark synth track')).toBe(false);
  });

  it('answers the playbook in butler tone and leaves chat alone', async () => {
    const r = await commandViaCore('Run monday review', rt());
    expect(r).toMatchObject({ route: 'jarvis core', status: 'OK' });
    expect(r!.answer).toMatch(/^Done, sir\./);
    expect(await commandViaCore('what is on my calendar', rt())).toBeUndefined();
  });
});
