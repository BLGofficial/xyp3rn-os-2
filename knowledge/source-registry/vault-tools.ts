import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../core/db/client.ts';
import { defineTool, type Tool } from '../../core/tool-registry/registry.ts';
import { extractPdfPages, isPdf } from '../ingestion/extract-pdf.ts';
import { slugify } from '../ingestion/types.ts';
import { sha256Hex } from './acquire.ts';
import type { VaultStore } from './vault-store.ts';

/**
 * Creative Vault file tools (AOS-01). Writes run as xyp_vault (vault.write), reads as xyp_runtime
 * in read-only transactions (vault.read). The DB holds the rules (a Vault file never changes; a
 * knowledge source is promoted once); the tools check input shape and surface the DB's refusal.
 */

export const VAULT_ROLE = 'xyp_vault';
const READ_ROLE = 'xyp_runtime';
export const MEDIA_CLASSES = ['document', 'lyric_sheet', 'audio', 'image', 'other'] as const;
export type MediaClass = (typeof MEDIA_CLASSES)[number];
export const LANGUAGE = /^([a-z]{2}|mixed|und)$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Runs fn under a DB role in one transaction.
 * @param sql - pool allowed to SET ROLE
 * @param role - the xyp_* role
 * @param fn - the work
 * @param mode - e.g. 'read only'
 * @returns fn's result
 */
export const asRole = <T>(sql: Sql, role: string, fn: (tx: postgres.TransactionSql) => Promise<T>, mode = ''): Promise<T> =>
  sql.begin(mode, async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(role)}`);
    return fn(tx);
  }) as Promise<T>;

const obj = (tool: string, args: unknown): Record<string, unknown> => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${tool}: input must be an object`);
  return args as Record<string, unknown>;
};

/**
 * A tag's slug from its label. A label with no Latin letter or digit (e.g. Cyrillic) would slugify
 * to nothing, which tags_slug_check refuses: it gets a stable hash slug instead, its label intact.
 * @param label - the tag as the owner wrote it
 * @returns a slug matching tags_slug_check
 */
export const tagSlug = (label: string): string => slugify(label) || `t-${sha256Hex(new TextEncoder().encode(label)).slice(0, 12)}`;

type Extracted = { readonly text: string; readonly extractor: string } | null;

/** Text for search and parsing: PDF through unpdf, text/* as strict UTF-8; anything else has none. */
const extractText = async (bytes: Uint8Array, mimeType: string): Promise<Extracted> => {
  if (isPdf(bytes)) {
    const text = (await extractPdfPages(bytes)).join('\n\n').trim();
    return text === '' ? null : { text, extractor: 'unpdf' };
  }
  if (!mimeType.startsWith('text/')) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // A wrong decoding would store garbled lyrics as if they were the owner's words.
    throw new Error('register_vault_file: the file is not UTF-8 text; save it as UTF-8 and add it again');
  }
  text = text.replace(/^﻿/, '');
  return text.trim() === '' ? null : { text, extractor: 'utf8' };
};

/** What register_vault_file returns. */
export type RegisteredFile = {
  readonly sourceId: string;
  readonly sha256: string;
  readonly mediaClass: MediaClass;
  /** added: a new row; existing: already a Vault file; promoted: a knowledge source became one. */
  readonly status: 'added' | 'existing' | 'promoted';
  /** Characters of extracted text stored for this file, null when it has none. */
  readonly textChars: number | null;
};

/**
 * register_vault_file (vault.write): puts a file's bytes in the Vault store and registers it.
 * Re-reads and re-hashes the file, so what is stored is exactly what was hashed. The same bytes
 * return the existing row (content-addressed); bytes `pnpm ingest` already registered are promoted
 * to a Vault file, keeping their title. Documents and lyric sheets get their text extracted.
 * @param deps - pool (writes as xyp_vault) and the byte store
 * @returns the tool definition
 */
export const createRegisterVaultFileTool = (deps: { readonly sql: Sql; readonly vault: VaultStore }): Tool =>
  defineTool({
    name: 'register_vault_file',
    capability: 'vault.write',
    description: "Store a file's bytes in the Creative Vault and register it (idempotent by sha256), with its text and tags.",
    handler: async (ctx, args) => {
      const a = obj('register_vault_file', args);
      const errors = [
        ...(typeof a.path === 'string' && a.path !== '' ? [] : ['path must be a file path']),
        ...(typeof a.sha256 === 'string' && SHA256.test(a.sha256) ? [] : ['sha256 must be 64 lowercase hex characters']),
        ...((MEDIA_CLASSES as readonly unknown[]).includes(a.mediaClass) ? [] : [`mediaClass must be one of ${MEDIA_CLASSES.join(', ')}`]),
        ...(typeof a.title === 'string' && a.title.trim() !== '' ? [] : ['title must be a non-empty string']),
        ...(a.language === undefined || a.language === null || (typeof a.language === 'string' && LANGUAGE.test(a.language)) ? [] : ['language must be an ISO 639-1 code, "mixed" or "und"']),
        ...(a.tags === undefined || (Array.isArray(a.tags) && a.tags.every((t) => typeof t === 'string' && t.trim() !== '')) ? [] : ['tags must be non-empty strings']),
        ...(a.mimeType === undefined || typeof a.mimeType === 'string' ? [] : ['mimeType must be a string']),
      ];
      if (errors.length > 0) throw new Error(`register_vault_file rejected: ${errors.join('; ')}`);
      const path = a.path as string;
      const expected = a.sha256 as string;
      const mediaClass = a.mediaClass as MediaClass;
      const tags = [...new Set(((a.tags ?? []) as string[]).map((t) => t.trim()))];

      const bytes = new Uint8Array(await readFile(path));
      const actual = sha256Hex(bytes);
      if (actual !== expected) {
        throw new Error(`register_vault_file: ${basename(path)} hashes to ${actual}, which does not match ${expected} (the file changed after it was hashed)`);
      }
      const mimeType = isPdf(bytes) ? 'application/pdf' : ((a.mimeType as string | undefined) ?? 'application/octet-stream');
      const extracted = mediaClass === 'document' || mediaClass === 'lyric_sheet' ? await extractText(bytes, mimeType) : null;
      if (mediaClass === 'lyric_sheet' && extracted === null) throw new Error('register_vault_file: a lyric sheet must be UTF-8 text or a PDF with text');
      // Bytes before the row: a row never points at missing bytes. Bytes whose row then fails to
      // commit are harmless (content-addressed; a retry reuses them).
      await deps.vault.put(bytes);

      const result = await asRole(deps.sql, VAULT_ROLE, async (tx) => {
        // Two adds of the same bytes: one registers, the other then sees the row.
        await tx`select pg_advisory_xact_lock(hashtextextended(${`xyp:vault-file:${actual}`}, 0))`;
        const [row] = await tx<{ id: string; storage: string | null; media_class: MediaClass | null }[]>`
          select id, storage, media_class from sources where checksum_sha256 = ${actual}`;
        let sourceId: string;
        let status: RegisteredFile['status'];
        let stored: MediaClass = mediaClass;
        if (!row) {
          const [ins] = await tx<{ id: string }[]>`
            insert into sources (kind, uri, title, checksum_sha256, mime_type, byte_size, metadata, storage, media_class, language, agent_run_id)
            values ('file', ${`vault://${actual}`}, ${(a.title as string).trim()}, ${actual}, ${mimeType}, ${bytes.length},
                    ${tx.json({ filename: basename(path) })}, 'local-vault', ${mediaClass}, ${(a.language as string | null | undefined) ?? null}, ${ctx.runId})
            returning id`;
          sourceId = ins!.id;
          status = 'added';
        } else if (row.storage === null) {
          await tx`
            update sources set storage = 'local-vault', media_class = ${mediaClass}, language = ${(a.language as string | null | undefined) ?? null},
                   agent_run_id = ${ctx.runId}
            where id = ${row.id}`;
          sourceId = row.id;
          status = 'promoted';
        } else {
          sourceId = row.id;
          status = 'existing';
          stored = row.media_class!;
          if (stored !== mediaClass) ctx.log('warn', `register_vault_file: already in the Vault as ${stored}; kept (asked for ${mediaClass})`);
        }
        if (status !== 'existing' && extracted) {
          await tx`insert into source_texts (source_id, text, extractor, agent_run_id) values (${sourceId}, ${extracted.text}, ${extracted.extractor}, ${ctx.runId})`;
        }
        for (const label of tags) {
          const slug = tagSlug(label);
          await tx`insert into tags (slug, label) values (${slug}, ${label}) on conflict (slug) do nothing`;
          await tx`
            insert into source_tags (source_id, tag_id, agent_run_id)
            select ${sourceId}, id, ${ctx.runId} from tags where slug = ${slug}
            on conflict (source_id, tag_id) do nothing`;
        }
        const [t] = await tx<{ n: number }[]>`select length(text)::int as n from source_texts where source_id = ${sourceId}`;
        return { sourceId, sha256: actual, mediaClass: stored, status, textChars: t?.n ?? null } satisfies RegisteredFile;
      });
      ctx.log('info', `register_vault_file → ${result.status} ${result.mediaClass} ${result.sourceId}`);
      return result;
    },
  });

/** What read_vault_file returns: the file as the Vault knows it, text included; never the bytes. */
export type VaultFile = {
  readonly id: string;
  readonly title: string;
  readonly mediaClass: MediaClass;
  readonly language: string | null;
  readonly sha256: string;
  readonly mimeType: string | null;
  readonly byteSize: number | null;
  readonly text: string | null;
  readonly extractor: string | null;
  readonly tags: readonly string[];
  /** Songs with a live link to this file (AOS-02: a Vault recording's track takes its song's title). */
  readonly songs: readonly { readonly id: string; readonly title: string }[];
};

/**
 * read_vault_file (vault.read): one Vault file's metadata, tags and extracted text.
 * @param deps - pool; reads as xyp_runtime, read only
 * @returns the tool definition
 */
export const createReadVaultFileTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'read_vault_file',
    capability: 'vault.read',
    description: "Read one Creative Vault file's metadata, tags and extracted text by source id.",
    handler: async (_ctx, args) => {
      const a = obj('read_vault_file', args);
      if (typeof a.sourceId !== 'string' || !UUID.test(a.sourceId)) throw new Error('read_vault_file: sourceId must be a uuid');
      const sourceId = a.sourceId;
      const [row] = await asRole(deps.sql, READ_ROLE, (tx) => tx<{
        id: string; title: string; media_class: MediaClass | null; language: string | null; checksum_sha256: string;
        mime_type: string | null; byte_size: string | null; text: string | null; extractor: string | null; tags: string[];
        songs: { id: string; title: string }[];
      }[]>`
        select s.id, s.title, s.media_class, s.language, s.checksum_sha256, s.mime_type, s.byte_size::text, t.text, t.extractor,
               array(select g.label from source_tags st join tags g on g.id = st.tag_id where st.source_id = s.id order by g.label) as tags,
               coalesce((select jsonb_agg(jsonb_build_object('id', cs.id, 'title', cs.title) order by cs.title, cs.id)
                         from current_song_links l join current_songs cs on cs.id = l.song_id where l.source_id = s.id), '[]'::jsonb) as songs
        from sources s left join source_texts t on t.source_id = s.id
        where s.id = ${sourceId}`, 'read only');
      if (!row) throw new Error(`read_vault_file: no source ${sourceId}`);
      if (row.media_class === null) throw new Error(`read_vault_file: source ${sourceId} is a knowledge source, not a Vault file`);
      return {
        id: row.id, title: row.title, mediaClass: row.media_class, language: row.language, sha256: row.checksum_sha256,
        mimeType: row.mime_type, byteSize: row.byte_size === null ? null : Number(row.byte_size), text: row.text, extractor: row.extractor, tags: row.tags,
        songs: row.songs,
      } satisfies VaultFile;
    },
  });
