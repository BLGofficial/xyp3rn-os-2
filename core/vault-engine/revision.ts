import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type RevisionMetadata = {
  readonly sha256: string;
  readonly vaultPath: string;
  readonly previousSha256: string | null;
  readonly actor: string;
  readonly byteSize: number;
  readonly createdAt: string;
};

export const sha256Hex = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RETRYABLE_WIN_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * Writes `content` atomically to `targetAbsPath` via a sibling temporary file and atomic rename.
 * Includes bounded exponential backoff for Windows file-locking (`EBUSY`/`EPERM`) when Obsidian is open.
 */
export const writeFileAtomic = async (
  targetAbsPath: string,
  content: string | Uint8Array,
  maxRetries = 4,
): Promise<void> => {
  const dir = dirname(targetAbsPath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.tmp-${process.pid}-${randomUUID()}`);

  await writeFile(tempPath, content, typeof content === 'string' ? { encoding: 'utf8' } : undefined);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await rename(tempPath, targetAbsPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt < maxRetries && RETRYABLE_WIN_CODES.has(code)) {
        await sleep(35 * Math.pow(2, attempt));
        continue;
      }
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }
};

/**
 * Immutable content-addressed revision archive inside `<vaultRoot>/.vault-revisions/`.
 * Every write or promotion through VaultEngine archives the exact content snapshot by SHA-256.
 */
export class VaultRevisionStore {
  readonly #revisionsRoot: string;

  constructor(vaultRoot: string) {
    this.#revisionsRoot = join(resolve(vaultRoot), '.vault-revisions');
  }

  get revisionsRoot(): string {
    return this.#revisionsRoot;
  }

  #blobPath(sha256: string): string {
    return join(this.#revisionsRoot, sha256.slice(0, 2), `${sha256}.blob`);
  }

  #metaPath(sha256: string): string {
    return join(this.#revisionsRoot, sha256.slice(0, 2), `${sha256}.meta.json`);
  }

  async recordRevision(input: {
    readonly vaultPath: string;
    readonly content: string | Uint8Array;
    readonly previousSha256?: string | null | undefined;
    readonly actor: string;
  }): Promise<RevisionMetadata> {
    const sha256 = sha256Hex(input.content);
    const byteSize =
      typeof input.content === 'string' ? Buffer.byteLength(input.content, 'utf8') : input.content.byteLength;
    const meta: RevisionMetadata = {
      sha256,
      vaultPath: input.vaultPath,
      previousSha256: input.previousSha256 ?? null,
      actor: input.actor,
      byteSize,
      createdAt: new Date().toISOString(),
    };

    const blobPath = this.#blobPath(sha256);
    try {
      await stat(blobPath);
    } catch {
      await writeFileAtomic(blobPath, input.content);
      await writeFileAtomic(this.#metaPath(sha256), JSON.stringify(meta, null, 2));
    }

    return meta;
  }

  async readRevisionText(sha256: string): Promise<string | null> {
    if (!/^[a-f0-9]{64}$/i.test(sha256)) return null;
    try {
      return await readFile(this.#blobPath(sha256.toLowerCase()), 'utf8');
    } catch {
      return null;
    }
  }

  async readRevisionMeta(sha256: string): Promise<RevisionMetadata | null> {
    if (!/^[a-f0-9]{64}$/i.test(sha256)) return null;
    try {
      const raw = await readFile(this.#metaPath(sha256.toLowerCase()), 'utf8');
      return JSON.parse(raw) as RevisionMetadata;
    } catch {
      return null;
    }
  }
}
