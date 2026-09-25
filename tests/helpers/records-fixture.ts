import type postgres from 'postgres';
import type { Sql } from '../../core/db/client.ts';

// Phase 13 fixtures: the Phase 9–11 output a catalog registration starts from, inserted directly
// under the role that owns each write. Every text field is marked [FIXTURE].

/** Runs fn as role in a transaction that commits. */
export const asCommitted = <T>(sql: Sql, role: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
  sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${role}`);
    return fn(tx);
  }) as Promise<T>;

/** A pending agent_runs row, for writes that need a run id. */
export const insertRun = async (sql: Sql, agent: string, cls: string): Promise<string> =>
  (await sql<{ id: string }[]>`insert into agent_runs (agent_name, class, domain, input) values (${agent}, ${cls}, 'RECORDS', '{}') returning id`)[0]!.id;

/** One creative artifact version, as xyp_creative. */
export const insertArtifact = async (sql: Sql, schemaId: string, body: Record<string, unknown>): Promise<string> => {
  const runId = await insertRun(sql, 'x3lius-suno', 'Creative');
  return asCommitted(sql, 'xyp_creative', async (tx) => (await tx<{ id: string }[]>`
    insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model)
    values (${schemaId}, 'x3lius-suno', ${runId}, '[FIXTURE] brief', ${tx.json(body as postgres.JSONValue)}, '[]', '{}', 'fixture')
    returning id`)[0]!.id);
};

export const FIXTURE_FORMULA_TITLE = '[FIXTURE] Night City';

let takeSeq = 0;
/**
 * A Phase 9 manual take: formula artifact (x3lius.suno-prompt/v1) → submission → take.
 * @returns the take, submission and formula ids
 */
export const insertTake = async (sql: Sql): Promise<{ takeId: string; submissionId: string; formulaArtifactId: string }> => {
  const formulaArtifactId = await insertArtifact(sql, 'x3lius.suno-prompt/v1', {
    title: FIXTURE_FORMULA_TITLE, style: '[FIXTURE] style', excludeStyles: [], lyrics: '[FIXTURE] lyrics', sunoModel: 'v5',
  });
  const runId = await insertRun(sql, 'suno-submitter', 'Execution');
  return asCommitted(sql, 'xyp_execution', async (tx) => {
    const [sub] = await tx<{ id: string }[]>`
      insert into suno_submissions (formula_artifact_id, agent_run_id, adapter, suno_model, prompt)
      values (${formulaArtifactId}, ${runId}, 'manual', 'v5',
              ${tx.json({ title: FIXTURE_FORMULA_TITLE, style: '[FIXTURE] style', excludeStyles: [], lyrics: '[FIXTURE] lyrics' })})
      returning id`;
    const [t] = await tx<{ id: string }[]>`
      insert into suno_takes (submission_id, agent_run_id, audio_url, title, duration_seconds)
      values (${sub!.id}, ${runId}, ${`https://cdn.example.org/fixture-${process.pid}-${++takeSeq}.mp3`}, '[FIXTURE] take', 180)
      returning id`;
    return { takeId: t!.id, submissionId: sub!.id, formulaArtifactId };
  });
};

/**
 * @param n - days from today (UTC)
 * @returns an ISO date (YYYY-MM-DD)
 */
export const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
