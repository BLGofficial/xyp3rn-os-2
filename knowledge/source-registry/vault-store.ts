import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from './acquire.ts';

/**
 * The Creative Vault's byte store (AOS-01, D4). Content-addressed: a file's name is its sha256,
 * the same key as `sources.checksum_sha256`, so the row and the bytes can't disagree about which
 * file they mean. Nothing is ever overwritten or deleted; a changed file is different bytes.
 */
export type VaultStore = {
  readonly put: (bytes: Uint8Array) => Promise<{ readonly sha256: string; readonly size: number }>;
  /** @throws on an unknown hash, and on bytes that no longer hash to their name (corruption) */
  readonly get: (sha256: string) => Promise<Uint8Array>;
  readonly has: (sha256: string) => Promise<boolean>;
};

const SHA256 = /^[0-9a-f]{64}$/;

const checked = (sha256: string): string => {
  // The hash becomes a path: anything but 64 hex characters could walk out of the store.
  if (!SHA256.test(sha256)) throw new Error(`vault: not a sha256: ${JSON.stringify(sha256)}`);
  return sha256;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
};

/**
 * Local adapter: `dir/<first 2 hex>/<sha256>`. A write goes to a temp file in the same directory
 * and is renamed into place, so a reader never sees a half-written file; two concurrent puts of the
 * same bytes both rename identical content, which is harmless. Nothing touches the disk until the
 * first put.
 * @param dir - store root (XYP_VAULT_DIR, default `.vault/` at the repo root)
 * @returns the store
 */
export const createLocalVaultStore = (dir: string): VaultStore => {
  const pathOf = (sha256: string) => join(dir, sha256.slice(0, 2), sha256);
  return {
    put: async (bytes) => {
      const sha256 = sha256Hex(bytes);
      const target = pathOf(sha256);
      if (!(await exists(target))) {
        await mkdir(join(dir, sha256.slice(0, 2)), { recursive: true });
        const tmp = `${target}.${randomUUID()}.tmp`;
        try {
          await writeFile(tmp, bytes, { flag: 'wx' });
          await rename(tmp, target);
        } finally {
          await rm(tmp, { force: true });
        }
      }
      return { sha256, size: bytes.length };
    },
    get: async (sha256) => {
      const target = pathOf(checked(sha256));
      if (!(await exists(target))) throw new Error(`vault: ${sha256} is not in the vault`);
      const bytes = new Uint8Array(await readFile(target));
      const actual = sha256Hex(bytes);
      if (actual !== sha256) throw new Error(`vault: ${sha256} is corrupt: its bytes hash to ${actual}`);
      return bytes;
    },
    has: async (sha256) => SHA256.test(sha256) && exists(pathOf(sha256)),
  };
};

/**
 * Where the local store lives: XYP_VAULT_DIR, else `.vault/` at the repo root (gitignored). Resolved
 * from this file, not the working directory, so the CLI and apps/web (cwd apps/web) share one store.
 * @param env - environment (default process.env)
 * @returns an absolute directory
 */
export const defaultVaultDir = (env: Readonly<Record<string, string | undefined>> = process.env): string =>
  env.XYP_VAULT_DIR || join(import.meta.dirname, '..', '..', '.vault');
