import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from '../../core/db/client.ts';
import { insertRun } from './records-fixture.ts';

// AOS-04 fixtures: an ingested source quoted by a canonical row, and a song. Written as the admin
// connection in one committed transaction each, because both carry deferred checks: a canonical row
// needs its knowledge_versions row (the Promotion Gate's history rule), a song its first revision.

/**
 * An ingested source and the bootstrap canonical row that quotes it (module + prompt + their history).
 * @param sql - admin pool
 * @param o.slug - canonical slug (unique per test DB)
 * @param o.body - the canonical body a quote is verified against
 * @param o.withSource - false for a canonical row with no source (not citable)
 * @returns the source (null when withSource is false) and canonical_prompts ids
 */
export const insertCanonical = async (
  sql: Sql,
  o: { readonly slug: string; readonly body: string; readonly withSource?: boolean },
): Promise<{ sourceId: string | null; canonicalPromptId: string; checksum: string | null }> =>
  sql.begin(async (tx) => {
    let sourceId: string | null = null;
    let checksum: string | null = null;
    if (o.withSource !== false) {
      checksum = createHash('sha256').update(randomUUID()).digest('hex');
      [{ id: sourceId }] = await tx<{ id: string }[]>`
        insert into sources (kind, uri, title, checksum_sha256) values ('file', ${`file:///fixture/${o.slug}.md`}, ${`[FIXTURE] ${o.slug}.md`}, ${checksum})
        returning id`;
    }
    const [m] = await tx<{ id: string }[]>`
      insert into modules (slug, title, domain, source_id, promoted_via) values (${`${o.slug}-module`}, '[FIXTURE] module', 'RECORDS', ${sourceId}, 'bootstrap')
      returning id`;
    await tx`insert into knowledge_versions (canonical_table, canonical_id, version, promoted_via, snapshot)
             values ('modules', ${m!.id}, 1, 'bootstrap', ${tx.json({ fixture: true })})`;
    const [cp] = await tx<{ id: string }[]>`
      insert into canonical_prompts (module_id, slug, title, body, source_id, promoted_via)
      values (${m!.id}, ${o.slug}, ${`[FIXTURE] ${o.slug}`}, ${o.body}, ${sourceId}, 'bootstrap')
      returning id`;
    await tx`insert into knowledge_versions (canonical_table, canonical_id, version, promoted_via, snapshot)
             values ('canonical_prompts', ${cp!.id}, 1, 'bootstrap', ${tx.json({ fixture: true })})`;
    return { sourceId, canonicalPromptId: cp!.id, checksum };
  });

/**
 * A song with its first revision (the deferred songs rule), as the admin connection.
 * @returns the song id and the agent run that wrote it
 */
export const insertSong = async (sql: Sql, title = '[FIXTURE] Night City'): Promise<{ songId: string; runId: string }> => {
  const runId = await insertRun(sql, 'records-songs', 'Execution');
  const songId = await sql.begin(async (tx) => {
    const [s] = await tx<{ id: string }[]>`insert into songs (agent_run_id) values (${runId}) returning id`;
    await tx`insert into song_revisions (song_id, title, artist, agent_run_id) values (${s!.id}, ${title}, 'X3LIUS', ${runId})`;
    return s!.id;
  });
  return { songId, runId };
};
