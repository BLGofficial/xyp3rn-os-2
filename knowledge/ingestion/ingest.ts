import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../core/db/client.ts';
import { acquireSource, describeInput, type AcquiredSource, type SourceInput } from '../source-registry/acquire.ts';
import { extractPdfPages } from './extract-pdf.ts';
import { selectNormalizer } from './normalizers/index.ts';
import { writeNormalized } from './write-normalized.ts';

/** DB role every ingestion write runs as (Phase 2 migration). Revoked from canonical in 6D. */
export const INGEST_ROLE = 'xyp_ingest_bootstrap';

/**
 * Serializes ingestion transactions. The unique checksum alone stops a duplicate source, but
 * two runs of *different* bytes could still race on (slug, version) when both compute
 * latest+1 — one global transaction-scoped lock closes both races. Ingestion is rare; the
 * lost parallelism is irrelevant.
 */
export const INGEST_LOCK_KEY = 'xyp:ingest:bootstrap';

export type IngestResult = {
  readonly runId: string;
  readonly status: 'success' | 'noop' | 'error';
  readonly sourceId: string | null;
  readonly stats: Readonly<Record<string, unknown>>;
  readonly error?: string;
};

const asIngestRole = <T>(sql: Sql, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(INGEST_ROLE)}`);
    return fn(tx);
  }) as Promise<T>;

const toPages = async (src: AcquiredSource): Promise<string[]> => {
  if (src.mimeType === 'application/pdf') return extractPdfPages(src.bytes);
  if (src.mimeType.startsWith('text/')) return [new TextDecoder().decode(src.bytes)];
  throw new Error(`unsupported mime type ${src.mimeType} for ${src.uri}`);
};

/**
 * Source Registry + normalization in one pipeline: register the source, normalize it into
 * canonical tables, score it — atomically. Same checksum = no-op (knowledge tables untouched,
 * the run itself is still logged as 'noop').
 *
 * Run lifecycle: the run row is committed as 'running' first (so a crash is visible), then
 * closed as success/noop inside the data transaction, or as error in its own transaction.
 * A process killed mid-run leaves 'running' behind — no reaper exists yet (flagged).
 *
 * @param sql - pool connected with rights to SET ROLE xyp_ingest_bootstrap
 * @param input - file path, URL, or manual text, with its origin
 * @param options - `asOf` pins the freshness clock (reproducible reports)
 * @returns the run outcome; errors are returned (and logged), not thrown
 */
export const ingestSource = async (
  sql: Sql,
  input: SourceInput,
  options: { readonly asOf?: Date } = {},
): Promise<IngestResult> => {
  const asOf = options.asOf ?? new Date();
  const [run] = await asIngestRole(sql, (tx) =>
    tx<{ id: string }[]>`insert into ingestion_runs (requested_uri) values (${describeInput(input)}) returning id`,
  );
  const runId = run!.id;

  try {
    const src = await acquireSource(input);
    const pages = await toPages(src);
    const normalizer = selectNormalizer(pages);
    if (!normalizer) throw new Error(`no normalizer registered for ${src.mimeType} source ${src.uri}`);
    const doc = normalizer.normalize(pages);

    return await asIngestRole(sql, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${INGEST_LOCK_KEY}, 0))`;
      const inserted = await tx<{ id: string }[]>`
        insert into sources (kind, uri, title, checksum_sha256, mime_type, byte_size, metadata)
        values (${src.kind}, ${src.uri}, ${doc.title || src.fallbackTitle}, ${src.checksum}, ${src.mimeType},
                ${src.bytes.length},
                ${tx.json({ origin: src.origin, normalizer: normalizer.id, pages: pages.length, ...doc.metadata } as postgres.JSONValue)})
        on conflict (checksum_sha256) do nothing
        returning id`;

      // No-op = same bytes AND already normalized by this normalizer version. A normalizer
      // upgrade re-normalizes into the existing source (versioned writes, nothing overwritten).
      let sourceId: string;
      let renormalized = false;
      if (inserted.length === 0) {
        const [existing] = await tx<{ id: string }[]>`select id from sources where checksum_sha256 = ${src.checksum}`;
        const done = await tx`
          select 1 from ingestion_runs
          where source_id = ${existing!.id} and status = 'success' and stats->>'normalizer' = ${normalizer.id} limit 1`;
        if (done.length > 0) {
          const stats = { reason: 'checksum already normalized by this normalizer', checksum: src.checksum, normalizer: normalizer.id };
          await tx`
            update ingestion_runs
            set status = 'noop', source_id = ${existing!.id}, checksum_sha256 = ${src.checksum},
                stats = ${tx.json(stats)}, completed_at = clock_timestamp()
            where id = ${runId}`;
          return { runId, status: 'noop', sourceId: existing!.id, stats } as const;
        }
        sourceId = existing!.id;
        renormalized = true;
      } else {
        sourceId = inserted[0]!.id;
      }

      const written = await writeNormalized(tx, doc, { sourceId, runId, kind: src.kind, origin: src.origin, asOf });
      const stats = { normalizer: normalizer.id, pages: pages.length, checksum: src.checksum, ...(renormalized ? { renormalized } : {}), ...written };
      await tx`
        update ingestion_runs
        set status = 'success', source_id = ${sourceId}, checksum_sha256 = ${src.checksum},
            stats = ${tx.json(stats as postgres.JSONValue)}, completed_at = clock_timestamp()
        where id = ${runId}`;
      return { runId, status: 'success', sourceId, stats } as const;
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await asIngestRole(sql, (tx) => tx`
      update ingestion_runs set status = 'error', error_detail = ${message}, completed_at = clock_timestamp()
      where id = ${runId}`);
    return { runId, status: 'error', sourceId: null, stats: {}, error: message };
  }
};
