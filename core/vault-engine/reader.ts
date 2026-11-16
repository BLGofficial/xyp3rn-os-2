import { readFile, stat } from 'node:fs/promises';
import type { ExtractedWikilink, ObsidianFrontmatter } from '../../knowledge/obsidian/types.ts';
import type { IndexEntryRecord, SqliteRuntimeDb } from '../sqlite/client.ts';
import type { VaultAuditLogger } from './audit.ts';
import { VaultNotFoundError } from './errors.ts';
import { parseFrontmatterDocument } from './frontmatter.ts';
import { resolveVaultPath, type VaultSector } from './path-resolver.ts';
import type { VaultEngineConfig } from './vault-config.ts';

export type VaultNoteDocument = {
  readonly vaultPath: string;
  readonly sector: VaultSector | 'ROOT_KB';
  readonly isCanonical: boolean;
  readonly rawContent: string;
  readonly body: string;
  readonly frontmatter: ObsidianFrontmatter;
  readonly wikilinks: readonly ExtractedWikilink[];
  readonly sha256: string;
  readonly byteSize: number;
  readonly mtimeMs: number;
  readonly frontmatterError: string | null;
};

export type VaultNoteMetadata = {
  readonly vaultPath: string;
  readonly entityId: string | null;
  readonly schema: string | null;
  readonly title: string;
  readonly domain: string;
  readonly sector: VaultSector | 'ROOT_KB';
  readonly docType: string | null;
  readonly status: string | null;
  readonly tags: readonly string[];
  readonly wikilinks: readonly ExtractedWikilink[];
  readonly sha256: string;
  readonly byteSize: number;
  readonly mtimeMs: number;
  readonly isCanonical: boolean;
  readonly frontmatterError: string | null;
};

export type ListVaultOptions = {
  readonly sector?: string | undefined;
  readonly domain?: string | undefined;
  readonly docType?: string | undefined;
  readonly status?: string | undefined;
  readonly tag?: string | undefined;
  readonly prefix?: string | undefined;
  readonly limit?: number | undefined;
};

export const readVaultNote = async (
  config: VaultEngineConfig,
  relPath: string,
  options?: {
    readonly audit?: VaultAuditLogger | undefined;
    readonly actor?: string | undefined;
  },
): Promise<VaultNoteDocument> => {
  const resolved = await resolveVaultPath(config, relPath, { requireSectorPrefix: false });
  const st = await stat(resolved.absPath).catch(() => null);
  if (!st || !st.isFile()) {
    options?.audit?.record({
      actor: options.actor ?? 'system',
      operation: 'read',
      filePath: resolved.normalizedPath,
      reason: 'Note not found on disk',
      result: 'error',
    });
    throw new VaultNotFoundError('NOTE_NOT_FOUND', `Vault note not found: "${resolved.normalizedPath}"`, {
      vaultPath: resolved.normalizedPath,
    });
  }

  const rawContent = await readFile(resolved.absPath, 'utf8');
  const parsed = parseFrontmatterDocument(rawContent, { strict: false, vaultPath: resolved.normalizedPath });
  const entityId =
    typeof parsed.rawFrontmatter.id === 'string'
      ? parsed.rawFrontmatter.id
      : typeof parsed.rawFrontmatter.id === 'number'
        ? String(parsed.rawFrontmatter.id)
        : null;

  options?.audit?.record({
    actor: options.actor ?? 'system',
    operation: 'read',
    entityId,
    filePath: resolved.normalizedPath,
    newChecksum: parsed.sha256,
    reason: 'Read vault note',
    result: 'success',
  });

  return {
    vaultPath: resolved.normalizedPath,
    sector: resolved.sector,
    isCanonical: resolved.isCanonical,
    rawContent,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
    wikilinks: parsed.wikilinks,
    sha256: parsed.sha256,
    byteSize: st.size,
    mtimeMs: Math.trunc(st.mtimeMs),
    frontmatterError: parsed.frontmatterError,
  };
};

export const readVaultMetadata = async (
  config: VaultEngineConfig,
  relPath: string,
  options?: {
    readonly audit?: VaultAuditLogger | undefined;
    readonly actor?: string | undefined;
  },
): Promise<VaultNoteMetadata> => {
  const doc = await readVaultNote(config, relPath);
  const fm = doc.frontmatter as Record<string, unknown>;
  const entityId =
    typeof fm.id === 'string' ? fm.id.trim() : typeof fm.id === 'number' ? String(fm.id) : null;
  const schema = typeof fm.schema === 'string' ? fm.schema.trim() : null;
  const title =
    typeof fm.title === 'string' && fm.title.trim()
      ? fm.title.trim()
      : doc.vaultPath.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? doc.vaultPath;
  const domain = typeof fm.domain === 'string' && fm.domain.trim() ? fm.domain.trim() : doc.sector;
  const docType = typeof fm.type === 'string' ? fm.type : null;
  const status = typeof fm.status === 'string' ? fm.status : null;

  options?.audit?.record({
    actor: options.actor ?? 'system',
    operation: 'readMetadata',
    entityId,
    filePath: doc.vaultPath,
    newChecksum: doc.sha256,
    reason: 'Read vault metadata',
    result: 'success',
  });

  return {
    vaultPath: doc.vaultPath,
    entityId,
    schema,
    title,
    domain,
    sector: doc.sector,
    docType,
    status,
    tags: doc.frontmatter.tags,
    wikilinks: doc.wikilinks,
    sha256: doc.sha256,
    byteSize: doc.byteSize,
    mtimeMs: doc.mtimeMs,
    isCanonical: doc.isCanonical,
    frontmatterError: doc.frontmatterError,
  };
};

export const listVaultEntries = (
  db: SqliteRuntimeDb,
  options: ListVaultOptions = {},
): readonly IndexEntryRecord[] => {
  const rawLimit = options.limit ?? 500;
  const candidates = db.listIndexEntries(options.sector, Math.max(rawLimit * 5, 2_000));
  const results: IndexEntryRecord[] = [];

  for (const entry of candidates) {
    if (options.domain && entry.domain !== options.domain) continue;
    if (options.docType && entry.docType !== options.docType) continue;
    if (options.status && entry.status !== options.status) continue;
    if (options.tag && !entry.tags.includes(options.tag)) continue;
    if (options.prefix && !entry.vaultPath.startsWith(options.prefix)) continue;

    results.push(entry);
    if (results.length >= rawLimit) break;
  }

  return results;
};
