import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, withRollback, type TestDb } from '../helpers/db.ts';
import { decideFixture, insertPackage, insertSubmission, type FixturePackage } from '../helpers/package-fixture.ts';
import { asCommitted, insertRun } from '../helpers/records-fixture.ts';

// AOS-03 proof (part 1): the Suno prompt package's writer guard, takes from Vault audio, the
// submission gate (S4: approved versions, built in a workflow, the package's own prompt), the
// owner's take ratings and the trace views, on a throwaway migrated database. Fixture rows are
// inserted directly; no agent runs here. Every refusal asserts its exact SQLSTATE.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('aos03_studio_db', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

const as = <T>(role: string, fn: (tx: postgres.TransactionSql) => Promise<T>) => asCommitted(db.sql, role, fn);
const code = (c: string) => ({ code: c });

/** A Vault file of the given media class, as xyp_vault. */
const vaultFile = async (mediaClass: string): Promise<string> => {
  const runId = await insertRun(db.sql, 'vault-curator', 'Execution');
  const sha = createHash('sha256').update(randomUUID()).digest('hex');
  return as('xyp_vault', async (tx) => (await tx<{ id: string }[]>`
    insert into sources (kind, uri, title, checksum_sha256, storage, media_class, agent_run_id)
    values ('file', ${`vault://${sha}`}, ${`[FIXTURE] ${mediaClass}`}, ${sha}, 'local-vault', ${mediaClass}, ${runId}) returning id`)[0]!.id);
};

/** A take of a submission, as xyp_execution: a Vault file or a URL. */
const take = async (submissionId: string, t: { source_id?: string; audio_url?: string }): Promise<string> => {
  const runId = await insertRun(db.sql, 'suno-submitter', 'Execution');
  return as('xyp_execution', async (tx) => (await tx<{ id: string }[]>`
    insert into suno_takes (submission_id, agent_run_id, source_id, audio_url)
    values (${submissionId}, ${runId}, ${t.source_id ?? null}, ${t.audio_url ?? null}) returning id`)[0]!.id);
};

const rate = async (takeId: string, rating: number, keep: string | null = null, change: string | null = null): Promise<string> => {
  const runId = await insertRun(db.sql, 'suno-submitter', 'Execution');
  return as('xyp_execution', async (tx) => (await tx<{ id: string }[]>`
    insert into take_ratings (take_id, rating, keep, change, agent_run_id) values (${takeId}, ${rating}, ${keep}, ${change}, ${runId}) returning id`)[0]!.id);
};

/** A submission of p as xyp_execution (the role suno-submitter writes as), with an optional prompt/model override. */
const submitAs = async (p: FixturePackage, over: { prompt?: Record<string, unknown>; model?: string } = {}): Promise<string> => {
  const runId = await insertRun(db.sql, 'suno-submitter', 'Execution');
  return as('xyp_execution', async (tx) => (await tx<{ id: string }[]>`
    insert into suno_submissions (formula_artifact_id, agent_run_id, adapter, suno_model, prompt)
    values (${p.packageId}, ${runId}, 'manual', ${over.model ?? p.sunoModel}, ${tx.json((over.prompt ?? p.prompt) as postgres.JSONValue)}) returning id`)[0]!.id);
};

const ready = async (artifactId: string, role = 'xyp_execution'): Promise<string[]> =>
  as(role, async (tx) => (await tx<{ r: string[] }[]>`select xyp_suno_package_ready(${artifactId}) as r`)[0]!.r);

describe('the package writer guard', () => {
  it('only x3lius-suno-package writes a x3lius.suno-package/v1 (23514); other schemas are untouched', async () => {
    const runId = await insertRun(db.sql, 'x3lius-suno', 'Creative');
    const write = (agent: string, schemaId: string) => as('xyp_creative', (tx) => tx`
      insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model)
      values (${schemaId}, ${agent}, ${runId}, '[FIXTURE] b', '{}', '[]', '{}', 'm')`);
    await expect(write('x3lius-suno', 'x3lius.suno-package/v1')).rejects.toMatchObject(code('23514'));
    await expect(write('x3lius-revision', 'x3lius.suno-package/v1')).rejects.toMatchObject(code('23514'));
    await expect(write('x3lius-suno-package', 'x3lius.suno-package/v1')).resolves.toBeDefined();
    await expect(write('x3lius-suno', 'x3lius.suno-prompt/v1')).resolves.toBeDefined();
    await expect(write('x3lius-revision', 'x3lius.style-recipe/v1')).resolves.toBeDefined();
  });

  it('a package is never revised: a new version is refused (23514)', async () => {
    const p = await insertPackage(db.sql);
    const runId = await insertRun(db.sql, 'x3lius-suno-package', 'Creative');
    await expect(as('xyp_creative', (tx) => tx`
      insert into creative_artifacts (schema_id, agent_name, agent_run_id, parent_id, brief, body, context_refs, knowledge, model)
      values ('x3lius.suno-package/v1', 'x3lius-suno-package', ${runId}, ${p.packageId}, '[FIXTURE] b', '{}', '[]', '{}', 'none')`)).rejects.toMatchObject(code('23514'));
  });
});

describe('takes from Vault audio (S3)', () => {
  it('a take is a Vault audio file or a URL, exactly one (23514)', async () => {
    const s = await insertSubmission(db.sql, await insertPackage(db.sql));
    const audio = await vaultFile('audio');
    await expect(take(s, { source_id: audio })).resolves.toBeDefined();
    await expect(take(s, { audio_url: 'https://cdn1.suno.ai/fixture-take.mp3' })).resolves.toBeDefined();
    await expect(take(s, { source_id: await vaultFile('audio'), audio_url: 'https://cdn1.suno.ai/fixture-both.mp3' })).rejects.toMatchObject(code('23514'));
    await expect(take(s, {})).rejects.toMatchObject(code('23514'));
  });

  it('the file must be Vault audio (23514), once per submission (23505)', async () => {
    const s = await insertSubmission(db.sql, await insertPackage(db.sql));
    await expect(take(s, { source_id: await vaultFile('image') })).rejects.toMatchObject(code('23514'));
    const knowledge = (await db.sql<{ id: string }[]>`
      insert into sources (kind, uri, title, checksum_sha256) values ('file', '/docs/k.md', '[FIXTURE] knowledge', ${createHash('sha256').update(randomUUID()).digest('hex')}) returning id`)[0]!.id;
    await expect(take(s, { source_id: knowledge })).rejects.toMatchObject(code('23514'));
    const audio = await vaultFile('audio');
    await take(s, { source_id: audio });
    await expect(take(s, { source_id: audio })).rejects.toMatchObject(code('23505'));
    // The same file can be a take of another attempt.
    await expect(take(await insertSubmission(db.sql, await insertPackage(db.sql)), { source_id: audio })).resolves.toBeDefined();
  });

  it('a take stays append-only (55000)', async () => {
    const t = await take(await insertSubmission(db.sql, await insertPackage(db.sql)), { source_id: await vaultFile('audio') });
    await expect(db.sql`update suno_takes set title = 'x' where id = ${t}`).rejects.toMatchObject(code('55000'));
    await expect(db.sql`delete from suno_takes where id = ${t}`).rejects.toMatchObject(code('55000'));
  });
});

describe('the submission gate (S4)', () => {
  it('an approved package built in a successful workflow run is submitted, as xyp_execution', async () => {
    const p = await insertPackage(db.sql);
    expect(await ready(p.packageId)).toEqual([]);
    await expect(submitAs(p)).resolves.toBeDefined();
    // The same package can be generated again: each submission is one attempt.
    await expect(submitAs(p)).resolves.toBeDefined();
  });

  it('a Phase 9 formula is no longer submitted (55000)', async () => {
    const runId = await insertRun(db.sql, 'x3lius-suno', 'Creative');
    const formula = await as('xyp_creative', async (tx) => (await tx<{ id: string }[]>`
      insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model)
      values ('x3lius.suno-prompt/v1', 'x3lius-suno', ${runId}, '[FIXTURE] b', '{}', '[]', '{}', 'm') returning id`)[0]!.id);
    expect(await ready(formula)).toEqual([expect.stringMatching(/is a x3lius\.suno-prompt\/v1, not a x3lius\.suno-package\/v1/)]);
    const e = await submitAs({ packageId: formula, sunoModel: 'v5', prompt: { title: 't', style: 's', excludeStyles: [], lyrics: 'l' } } as unknown as FixturePackage).catch((x: postgres.PostgresError) => x);
    expect(e).toMatchObject(code('55000'));
    expect((e as Error).message).toMatch(/x3lius\.suno-package\/v1/);
  });

  it('refuses while any source version is a draft or rejected, naming each (55000)', async () => {
    const p = await insertPackage(db.sql, { approve: ['recipe'] });
    const reasons = await ready(p.packageId);
    expect(reasons).toHaveLength(2);
    expect(reasons.join('\n')).toMatch(new RegExp(`lyrics ${p.lyricsId} v1 is draft`));
    expect(reasons.join('\n')).toMatch(new RegExp(`meta-tag-set ${p.tagSetId} v1 is draft`));
    await expect(submitAs(p)).rejects.toMatchObject(code('55000'));

    await decideFixture(db.sql, p.lyricsId);
    await decideFixture(db.sql, p.tagSetId, 'reject');
    expect(await ready(p.packageId)).toEqual([expect.stringMatching(new RegExp(`meta-tag-set ${p.tagSetId} v1 is rejected`))]);
    await expect(submitAs(p)).rejects.toMatchObject(code('55000'));
  });

  it('an approved later version does not approve the one the package names', async () => {
    const p = await insertPackage(db.sql, { approve: ['lyrics', 'tags'] });
    const runId = await insertRun(db.sql, 'x3lius-studio-editor', 'Creative');
    const v2 = (await db.sql<{ id: string }[]>`
      insert into creative_artifacts (schema_id, agent_name, agent_run_id, parent_id, brief, body, context_refs, knowledge, model)
      values ('x3lius.style-recipe/v1', 'x3lius-studio-editor', ${runId}, ${p.recipeId}, '[FIXTURE] b', '{}', '[]', '{}', 'none') returning id`)[0]!.id;
    await decideFixture(db.sql, v2);
    expect(await ready(p.packageId)).toEqual([expect.stringMatching(new RegExp(`style-recipe ${p.recipeId} v1 is draft`))]);
  });

  it('refuses a package not built in a workflow run, or built in one that failed (55000)', async () => {
    const outside = await insertPackage(db.sql, { workflow: 'none' });
    expect(await ready(outside.packageId)).toEqual([expect.stringMatching(/was not built in a workflow run/)]);
    await expect(submitAs(outside)).rejects.toMatchObject(code('55000'));
    const failed = await insertPackage(db.sql, { workflow: 'error' });
    expect(await ready(failed.packageId)).toEqual([expect.stringMatching(/built by workflow run .* \(build-suno-package\), which ended error/)]);
    await expect(submitAs(failed)).rejects.toMatchObject(code('55000'));
  });

  it('refuses a package whose sources do not match their artifacts (55000)', async () => {
    const p = await insertPackage(db.sql);
    const [run] = await db.sql<{ id: string }[]>`
      insert into agent_runs (agent_name, class, domain, input, workflow_run_id, step_id)
      values ('x3lius-suno-package', 'Creative', 'RECORDS', '{}', ${p.workflowRunId}, 'package') returning id`;
    const runId = run!.id;
    const bad = (await db.sql<{ id: string }[]>`
      insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model)
      values ('x3lius.suno-package/v1', 'x3lius-suno-package', ${runId}, '[FIXTURE] b',
              ${db.sql.json({ sunoModel: 'v5', ...p.prompt, excludeStyles: [...p.prompt.excludeStyles], limits: [], rulesApplied: [], ungroundedChoices: [], sources: [
                { role: 'lyrics', artifactId: p.lyricsId, schemaId: 'x3lius.lyrics/v2', version: 2 },
                { role: 'style-recipe', artifactId: p.lyricsId, schemaId: 'x3lius.style-recipe/v1', version: 1 },
              ] })}, '[]', '{}', 'none') returning id`)[0]!.id;
    const reasons = (await ready(bad)).join('\n');
    expect(reasons).toMatch(new RegExp(`lyrics ${p.lyricsId} is v1, not v2`));
    expect(reasons).toMatch(new RegExp(`style-recipe ${p.lyricsId} is a x3lius\\.lyrics/v2, not a x3lius\\.style-recipe/v1`));
    expect(reasons).toMatch(/no meta-tag-set source/);
  });

  it('the recorded prompt and model are the package’s own (23514)', async () => {
    const p = await insertPackage(db.sql);
    await expect(submitAs(p, { prompt: { ...p.prompt, lyrics: '[Verse 1]\n[FIXTURE] something else' } })).rejects.toMatchObject(code('23514'));
    await expect(submitAs(p, { prompt: { ...p.prompt, style: '[FIXTURE] another style' } })).rejects.toMatchObject(code('23514'));
    await expect(submitAs(p, { model: 'v4.5' })).rejects.toMatchObject(code('23514'));
  });

  it('the Phase 9 checks still hold on a ready package (23514)', async () => {
    const p = await insertPackage(db.sql);
    await expect(insertSubmission(db.sql, p, 'manual', 'task-1')).rejects.toMatchObject(code('23514'));
    await expect(insertSubmission(db.sql, p, 'sunoapi', null)).rejects.toMatchObject(code('23514'));
    await expect(insertSubmission(db.sql, p, 'sunoapi', 'task-1')).resolves.toBeDefined();
  });

  it('readiness is callable by xyp_execution and xyp_web only (42501)', async () => {
    const p = await insertPackage(db.sql);
    expect(await ready(p.packageId, 'xyp_web')).toEqual([]);
    for (const role of ['xyp_runtime', 'xyp_creative', 'anon', 'authenticated']) {
      await expect(ready(p.packageId, role)).rejects.toMatchObject(code('42501'));
    }
  });
});

describe('take ratings (the owner’s feedback)', () => {
  it('a rating is 1–5 with optional non-blank notes (23514); the latest is current', async () => {
    const t = await take(await insertSubmission(db.sql, await insertPackage(db.sql)), { source_id: await vaultFile('audio') });
    for (const bad of [0, 6]) await expect(rate(t, bad)).rejects.toMatchObject(code('23514'));
    await expect(rate(t, 3, ' ')).rejects.toMatchObject(code('23514'));
    await expect(rate(t, 3, null, '')).rejects.toMatchObject(code('23514'));
    await rate(t, 2, null, '[FIXTURE] the hook comes in late');
    await rate(t, 4, '[FIXTURE] the vocal chain', '[FIXTURE] shorter intro');
    const [cur] = await db.sql<{ rating: number; keep: string; change: string }[]>`select rating, keep, change from current_take_ratings where take_id = ${t}`;
    expect(cur).toEqual({ rating: 4, keep: '[FIXTURE] the vocal chain', change: '[FIXTURE] shorter intro' });
    expect((await db.sql`select 1 from take_ratings where take_id = ${t}`).length).toBe(2);
  });

  it('ratings are append-only (55000)', async () => {
    const t = await take(await insertSubmission(db.sql, await insertPackage(db.sql)), { source_id: await vaultFile('audio') });
    const r = await rate(t, 5);
    await expect(db.sql`update take_ratings set rating = 1 where id = ${r}`).rejects.toMatchObject(code('55000'));
    await expect(db.sql`delete from take_ratings where id = ${r}`).rejects.toMatchObject(code('55000'));
  });
});

describe('the trace views (the gate’s data)', () => {
  it('generation_attempts names the exact lyric, recipe and tag set versions, the workflow and the song', async () => {
    const p = await insertPackage(db.sql);
    const songRun = await insertRun(db.sql, 'records-songs', 'Execution');
    const songId = await as('xyp_vault', async (tx) => {
      const [s] = await tx<{ id: string }[]>`insert into songs (agent_run_id) values (${songRun}) returning id`;
      await tx`insert into song_revisions (song_id, title, artist, agent_run_id) values (${s!.id}, '[FIXTURE] Night City', 'X3LIUS', ${songRun})`;
      await tx`insert into song_links (song_id, role, artifact_lineage_id, agent_run_id) values (${s!.id}, 'suno-package', ${p.packageId}, ${songRun})`;
      return s!.id;
    });
    const s = await insertSubmission(db.sql, p);
    await take(s, { source_id: await vaultFile('audio') });
    await take(s, { audio_url: 'https://cdn1.suno.ai/fixture-trace.mp3' });
    const [a] = await as('xyp_web', (tx) => tx`select * from generation_attempts where submission_id = ${s}`);
    expect(a).toMatchObject({
      package_id: p.packageId, package_version: 1, song_id: songId, title: p.prompt.title, suno_model: 'v5', adapter: 'manual',
      lyrics_id: p.lyricsId, lyrics_version: 1, style_recipe_id: p.recipeId, style_recipe_version: 1,
      meta_tag_set_id: p.tagSetId, meta_tag_set_version: 1,
      workflow_run_id: p.workflowRunId, workflow_name: 'build-suno-package', workflow_sha256: 'a'.repeat(64),
      take_count: 2, is_traced: true,
    });
  });

  it('a submission from before AOS-03 is listed, not traced', async () => {
    await withRollback(db.sql, async (tx) => {
      await tx`alter table suno_submissions disable trigger trg_suno_submissions_gate`;
      const runId = (await tx<{ id: string }[]>`insert into agent_runs (agent_name, class, domain, input) values ('x3lius-suno', 'Creative', 'RECORDS', '{}') returning id`)[0]!.id;
      const [f] = await tx<{ id: string }[]>`
        insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model)
        values ('x3lius.suno-prompt/v1', 'x3lius-suno', ${runId}, '[FIXTURE] b', ${tx.json({ title: '[FIXTURE] old', sunoModel: 'v5', sources: [] })}, '[]', '{}', 'm') returning id`;
      const [s] = await tx<{ id: string }[]>`
        insert into suno_submissions (formula_artifact_id, agent_run_id, adapter, suno_model, prompt)
        values (${f!.id}, ${runId}, 'manual', 'v5', ${tx.json({ title: '[FIXTURE] old', style: 's', excludeStyles: [], lyrics: 'l' })}) returning id`;
      const [a] = await tx`select * from generation_attempts where submission_id = ${s!.id}`;
      expect(a).toMatchObject({ package_id: f!.id, lyrics_id: null, style_recipe_id: null, meta_tag_set_id: null, is_traced: false });
    });
  });

  it('generation_takes names the audio (Vault file and sha256, or the URL) and the current rating', async () => {
    const s = await insertSubmission(db.sql, await insertPackage(db.sql));
    const audio = await vaultFile('audio');
    const t = await take(s, { source_id: audio });
    await rate(t, 5, '[FIXTURE] everything');
    const [sha] = await db.sql<{ checksum_sha256: string }[]>`select checksum_sha256 from sources where id = ${audio}`;
    const [row] = await as('xyp_web', (tx) => tx`select * from generation_takes where take_id = ${t}`);
    expect(row).toMatchObject({ submission_id: s, source_id: audio, audio_sha256: sha!.checksum_sha256, audio_url: null, rating: 5, keep: '[FIXTURE] everything' });
  });
});

describe('grants: least privilege', () => {
  it('xyp_execution writes and reads ratings; xyp_web and service_role read the trace; others get nothing (42501)', async () => {
    const t = await take(await insertSubmission(db.sql, await insertPackage(db.sql)), { source_id: await vaultFile('audio') });
    const runId = await insertRun(db.sql, 'suno-submitter', 'Execution');
    for (const role of ['xyp_web', 'service_role', 'xyp_vault', 'xyp_catalog', 'xyp_creative']) {
      await expect(as(role, (tx) => tx`insert into take_ratings (take_id, rating, agent_run_id) values (${t}, 3, ${runId})`)).rejects.toMatchObject(code('42501'));
    }
    for (const role of ['xyp_web', 'service_role']) {
      for (const rel of ['take_ratings', 'current_take_ratings', 'generation_attempts', 'generation_takes']) {
        await expect(as(role, (tx) => tx.unsafe(`select count(*) from ${rel}`))).resolves.toBeDefined();
      }
    }
    await expect(as('xyp_execution', (tx) => tx`select count(*) from current_take_ratings`)).resolves.toBeDefined();
    for (const role of ['anon', 'authenticated', 'xyp_runtime']) {
      await expect(as(role, (tx) => tx`select count(*) from take_ratings`)).rejects.toMatchObject(code('42501'));
    }
  });
});
