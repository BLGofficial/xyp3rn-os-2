import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createLocalVaultStore } from './vault-store.ts';

// AOS-01 (D4): the Creative Vault's byte store. Content-addressed by sha256, written atomically,
// verified on every read.

const dir = mkdtempSync(join(tmpdir(), 'aos01-vault-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('local VaultStore', () => {
  const store = createLocalVaultStore(dir);
  const bytes = new TextEncoder().encode('[Verse 1]\nnight city\n');

  it('stores bytes under their sha256 and reads them back', async () => {
    const put = await store.put(bytes);
    expect(put).toEqual({ sha256: sha(bytes), size: bytes.length });
    expect(await store.has(put.sha256)).toBe(true);
    expect(Buffer.from(await store.get(put.sha256)).equals(Buffer.from(bytes))).toBe(true);
    expect(readdirSync(join(dir, put.sha256.slice(0, 2)))).toEqual([put.sha256]);
  });

  it('a second put of the same bytes is a no-op; nothing temporary is left behind', async () => {
    const a = await store.put(bytes);
    const b = await store.put(bytes);
    expect(b).toEqual(a);
    const all = readdirSync(dir, { recursive: true }).map(String);
    expect(all.filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('refuses to read bytes that no longer match their name (corruption), and an unknown or malformed hash', async () => {
    const put = await store.put(new TextEncoder().encode('original'));
    writeFileSync(join(dir, put.sha256.slice(0, 2), put.sha256), 'tampered');
    await expect(store.get(put.sha256)).rejects.toThrow(/corrupt/);
    await expect(store.get(sha(new TextEncoder().encode('never stored')))).rejects.toThrow(/not in the vault/);
    await expect(store.get('../etc/passwd')).rejects.toThrow(/sha256/);
    expect(await store.has('nope')).toBe(false);
  });
});
