import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../core/db/client.ts';
import { admitFirstParty, CANONICAL_WRITE_LOCK_KEY, FIRST_PARTY_ADMISSION_ERROR } from '../promotion-gate/gate.ts';
import { acquireSource, describeInput, type AcquiredSource, type SourceInput } from '../source-registry/acquire.ts';
import { extractPdfPages } from './extract-pdf.ts';
import { selectNormalizer } from './normalizers/index.ts';

/**
 * Source Registry role: registers sources and logs ingestion runs. Since 6D it holds no canonical
 * grant — canonical rows are written by the Promotion Gate's first-party admission (xyp_promotion).
 */
export const INGEST_ROLE = 'xyp_ingest_bootstrap';

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
 * Source Registry + normalization in one pipeline: register the source, admit the normalized
 * document through the Promotion Gate (first-party only), score it — atomically. Same checksum
 * = no-op (knowledge tables untouched, the run itself is still logged as 'noop').
 * Third-party material is refused before anything is fetched: it enters as research evidence.
 *
 * Run lifecycle: the run row is committed as 'running' first (so a crash is visible), then
 * closed as success/noop inside the data transaction, or as error in its own transaction.
 * A process killed mid-run leaves 'running' behind — no reaper exists yet (flagged).
 *
 * @param sql - pool connected with rights to SET ROLE xyp_ingest_bootstrap and xyp_promotion
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
    if (input.origin !== 'first_party') throw new Error(FIRST_PARTY_ADMISSION_ERROR);
    const src = await acquireSource(input);
    const pages = await toPages(src);
    const normalizer = selectNormalizer(pages);
    if (!normalizer) throw new Error(`no normalizer registered for ${src.mimeType} source ${src.uri}`);
    const doc = normalizer.normalize(pages);

    return await asIngestRole(sql, async (tx) => {
      // One lock for every canonical writer: two runs of *different* bytes (or a gate run) could
      // otherwise race on (slug, version) when both compute latest+1. The unique checksum alone
      // only stops a duplicate source.
      await tx`select pg_advisory_xact_lock(hashtextextended(${CANONICAL_WRITE_LOCK_KEY}, 0))`;
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

      const admitted = await admitFirstParty(tx, {
        doc, sourceId, ingestionRunId: runId, kind: src.kind, origin: src.origin, normalizer: normalizer.id, asOf,
      });
      await tx.unsafe(`set local role ${quoteIdent(INGEST_ROLE)}`);
      const stats = {
        normalizer: normalizer.id, pages: pages.length, checksum: src.checksum, ...(renormalized ? { renormalized } : {}),
        ...admitted.stats, promotion_run_id: admitted.promotionRunId,
      };
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
