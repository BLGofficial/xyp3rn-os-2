import type postgres from 'postgres';
import type { Sql } from '../../core/db/client.ts';

/** Seeds, as the test superuser, the Phase 8-11 rows a track can point at. */
export const seedCreative = async (sql: Sql) => {
  const [run] = await sql<{ id: string }[]>`
    insert into agent_runs (agent_name, class, domain, input) values ('records-fixture', 'Execution', 'RECORDS', '{}') returning id`;
  const art = async (schemaId: string, body: postgres.JSONValue) => (await sql<{ id: string }[]>`
    insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model)
    values (${schemaId}, 'records-fixture', ${run!.id}, '[FIXTURE]', ${sql.json(body)}, '[]', '{}', 'none') returning id`)[0]!.id;
  const lyricsId = await art('x3lius.lyrics/v2', { sections: [] });
  const promptId = await art('x3lius.suno-prompt/v1', { title: '[FIXTURE]' });
  const mixReportId = await art('x3lius.mix-report/v1', { checks: [] });
  const [sub] = await sql<{ id: string }[]>`
    insert into suno_submissions (formula_artifact_id, agent_run_id, adapter, suno_model, prompt)
    values (${promptId}, ${run!.id}, 'manual', 'v5', ${sql.json({ title: 't', style: 's', excludeStyles: [], lyrics: 'l' })}) returning id`;
  const [take] = await sql<{ id: string }[]>`
    insert into suno_takes (submission_id, agent_run_id, audio_url, duration_seconds)
    values (${sub!.id}, ${run!.id}, ${`https://cdn.example.test/${crypto.randomUUID()}.mp3`}, 187) returning id`;
  return { runId: run!.id, lyricsId, promptId, mixReportId, takeId: take!.id };
};

export const SHA = 'a'.repeat(64);

/**
 * A draft release with `tracks` studio-master tracks and, when `splits` is given, those splits on
 * every track (committed, so the always-100 trigger runs).
 */
export const seedRelease = async (
  sql: Sql,
  opts: { tracks?: number; splits?: { payee: string; role: string; percentage: number }[]; releaseDate?: string } = {},
) => {
  const [r] = await sql<{ id: string }[]>`
    insert into releases (title, kind, release_date) values ('[FIXTURE] release', 'single', ${opts.releaseDate ?? null}) returning id`;
  const trackIds: string[] = [];
  for (let i = 1; i <= (opts.tracks ?? 1); i++) {
    const [t] = await sql<{ id: string }[]>`
      insert into tracks (release_id, position, title, master_uri, master_sha256)
      values (${r!.id}, ${i}, ${`[FIXTURE] track ${i}`}, ${`file:///masters/${i}.wav`}, ${SHA}) returning id`;
    trackIds.push(t!.id);
  }
  if (opts.splits) {
    await sql.begin(async (tx) => {
      for (const t of trackIds) for (const s of opts.splits!) {
        await tx`insert into rights_splits (track_id, payee, role, percentage) values (${t}, ${s.payee}, ${s.role}::split_role, ${s.percentage})`;
      }
    });
  }
  return { releaseId: r!.id, trackIds };
};
