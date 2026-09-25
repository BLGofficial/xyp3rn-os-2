import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { asCommitted, insertArtifact, insertRun, insertTake } from '../helpers/records-fixture.ts';
import { insertEvidence, insertResearchRun } from '../helpers/tech-fixture.ts';

// AOS-01 proof (part 1): songs, song links, Vault file columns, creative-version approvals and the
// Vault search index, on a throwaway migrated database. Fixture rows are inserted directly under
// the role that owns each write; no agent runs here. Every refusal asserts its exact SQLSTATE.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('aos01_vault_db', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

const as = <T>(role: string, fn: (tx: postgres.TransactionSql) => Promise<T>) => asCommitted(db.sql, role, fn);
const code = (c: string) => ({ code: c });
const run = () => insertRun(db.sql, 'records-songs', 'Execution');

type Rev = { title?: string; artist?: string; language?: string | null; genre?: string | null; status?: string };
/** A song with its first revision, in ONE transaction, as xyp_vault. */
const song = async (rev: Rev = {}): Promise<string> => {
  const runId = await run();
  return as('xyp_vault', async (tx) => {
    const [s] = await tx<{ id: string }[]>`insert into songs (agent_run_id) values (${runId}) returning id`;
    await revise(tx, s!.id, rev, runId);
    return s!.id;
  });
};
const revise = async (tx: postgres.TransactionSql, songId: string, rev: Rev, runId: string) =>
  tx`insert into song_revisions (song_id, title, artist, language, genre, status, agent_run_id)
     values (${songId}, ${rev.title ?? '[FIXTURE] Night City'}, ${rev.artist ?? 'X3LIUS'}, ${rev.language === undefined ? 'en' : rev.language},
             ${rev.genre ?? null}, ${rev.status ?? 'idea'}, ${runId})`;

type Target = { artifact_lineage_id?: string; source_id?: string; take_id?: string; track_id?: string; research_question_id?: string };
const link = async (songId: string, target: Target, role: string | null = null): Promise<string> => {
  const runId = await run();
  return as('xyp_vault', async (tx) => (await tx<{ id: string }[]>`
    insert into song_links (song_id, role, artifact_lineage_id, source_id, take_id, track_id, research_question_id, agent_run_id)
    values (${songId}, ${role}, ${target.artifact_lineage_id ?? null}, ${target.source_id ?? null}, ${target.take_id ?? null},
            ${target.track_id ?? null}, ${target.research_question_id ?? null}, ${runId})
    returning id`)[0]!.id);
};
const retract = async (linkId: string, reason = '[FIXTURE] wrong song') => {
  const runId = await run();
  return as('xyp_vault', (tx) => tx`insert into song_link_retractions (song_link_id, reason, agent_run_id) values (${linkId}, ${reason}, ${runId})`);
};

/** A Vault file row (bytes stored elsewhere), as xyp_vault. */
const vaultFile = async (over: { mediaClass?: string | null; storage?: string | null; language?: string | null } = {}): Promise<string> => {
  const runId = await insertRun(db.sql, 'vault-curator', 'Execution');
  const sha = createHash('sha256').update(randomUUID()).digest('hex');
  return as('xyp_vault', async (tx) => (await tx<{ id: string }[]>`
    insert into sources (kind, uri, title, checksum_sha256, mime_type, byte_size, storage, media_class, language, agent_run_id)
    values ('file', ${`vault://${sha}`}, '[FIXTURE] lyric sheet', ${sha}, 'text/plain', 42,
            ${over.storage === undefined ? 'local-vault' : over.storage}, ${over.mediaClass === undefined ? 'lyric_sheet' : over.mediaClass},
            ${over.language === undefined ? 'en' : over.language}, ${runId})
    returning id`)[0]!.id);
};

/** A child version of a lineage, as xyp_creative. */
const childOf = async (parentId: string): Promise<string> => {
  const runId = await insertRun(db.sql, 'x3lius-lyric-editor', 'Creative');
  return as('xyp_creative', async (tx) => (await tx<{ id: string }[]>`
    insert into creative_artifacts (schema_id, agent_name, agent_run_id, parent_id, brief, body, context_refs, knowledge, model)
    select schema_id, 'x3lius-lyric-editor', ${runId}, id, brief, body, '[]', '{}', 'none' from creative_artifacts where id = ${parentId}
    returning id`)[0]!.id);
};
const lyrics = () => insertArtifact(db.sql, 'x3lius.lyrics/v2', { fixture: true });

describe('songs: a stable identity with append-only, derived revisions', () => {
  it('a song and its first revision commit together; revisions number themselves 1, 2, …; the current view shows the latest', async () => {
    const id = await song({ title: '[FIXTURE] Working title' });
    const runId = await run();
    await as('xyp_vault', (tx) => revise(tx, id, { title: '[FIXTURE] Final title', status: 'writing' }, runId));
    expect(await db.sql`select revision, title from song_revisions where song_id = ${id} order by revision`).toEqual([
      { revision: 1, title: '[FIXTURE] Working title' }, { revision: 2, title: '[FIXTURE] Final title' },
    ]);
    const [cur] = await db.sql<{ title: string; status: string; revision: number }[]>`select title, status::text, revision from current_songs where id = ${id}`;
    expect(cur).toEqual({ title: '[FIXTURE] Final title', status: 'writing', revision: 2 });
  });

  it('a song with no revision is refused at commit (23514)', async () => {
    const runId = await run();
    await expect(as('xyp_vault', (tx) => tx`insert into songs (agent_run_id) values (${runId})`)).rejects.toMatchObject(code('23514'));
  });

  it('refuses a blank title or artist, an unknown language or status (23514 / 22P02)', async () => {
    await expect(song({ title: '  ' })).rejects.toMatchObject(code('23514'));
    await expect(song({ artist: '' })).rejects.toMatchObject(code('23514'));
    await expect(song({ language: 'english' })).rejects.toMatchObject(code('23514'));
    await expect(song({ status: 'mastering' })).rejects.toMatchObject(code('22P02'));
    await expect(song({ language: 'mixed' })).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('songs and revisions are immutable for every role, the owner included (55000)', async () => {
    const id = await song();
    await expect(db.sql`update song_revisions set title = 'x' where song_id = ${id}`).rejects.toMatchObject(code('55000'));
    await expect(db.sql`delete from song_revisions where song_id = ${id}`).rejects.toMatchObject(code('55000'));
    await expect(db.sql`delete from songs where id = ${id}`).rejects.toMatchObject(code('55000'));
  });
});

describe('song_links: one typed target per link, history kept', () => {
  it('links each kind of target: a lineage root, a Vault file, a take, a research question', async () => {
    const s = await song();
    const root = await lyrics();
    const { takeId } = await insertTake(db.sql);
    const researchRun = await insertResearchRun(db.sql);
    const [q] = await db.sql<{ question_id: string }[]>`select question_id from research_runs where id = ${researchRun}`;
    await link(s, { artifact_lineage_id: root }, 'lyrics');
    await link(s, { source_id: await vaultFile() }, 'reference');
    await link(s, { take_id: takeId });
    await link(s, { research_question_id: q!.question_id });
    const kinds = await db.sql<{ kind: string }[]>`select kind from current_song_links where song_id = ${s} order by kind`;
    expect(kinds.map((k) => k.kind)).toEqual(['artifact_lineage', 'research_question', 'source', 'take']);
  });

  it('refuses no target or two targets (23514), and a lineage that is not a root (23514)', async () => {
    const s = await song();
    const root = await lyrics();
    await expect(link(s, {})).rejects.toMatchObject(code('23514'));
    await expect(link(s, { artifact_lineage_id: root, source_id: await vaultFile() })).rejects.toMatchObject(code('23514'));
    await expect(link(s, { artifact_lineage_id: await childOf(root) })).rejects.toMatchObject(code('23514'));
  });

  it('one live link per song and target (23505); a retraction frees it, and history is kept', async () => {
    const s = await song();
    const root = await lyrics();
    const first = await link(s, { artifact_lineage_id: root });
    await expect(link(s, { artifact_lineage_id: root })).rejects.toMatchObject(code('23505'));
    await retract(first);
    expect(await db.sql`select 1 from current_song_links where song_id = ${s}`).toHaveLength(0);
    await link(s, { artifact_lineage_id: root });
    expect(await db.sql`select 1 from song_links where song_id = ${s}`).toHaveLength(2);
    await expect(retract(first)).rejects.toMatchObject(code('23505'));
    await expect(retract(await link(s, { source_id: await vaultFile() }), ' ')).rejects.toMatchObject(code('23514'));
  });

  it('links and retractions are append-only (55000)', async () => {
    const l = await link(await song(), { source_id: await vaultFile() });
    await retract(l);
    await expect(db.sql`update song_links set role = 'x' where id = ${l}`).rejects.toMatchObject(code('55000'));
    await expect(db.sql`delete from song_link_retractions where song_link_id = ${l}`).rejects.toMatchObject(code('55000'));
  });
});

describe('Vault files: sources, extended (no parallel item table)', () => {
  it('a Vault file has storage, a media class and its agent run; a knowledge source has none of them (23514 otherwise)', async () => {
    await vaultFile();
    await expect(vaultFile({ mediaClass: null })).rejects.toMatchObject(code('23514'));
    await expect(vaultFile({ storage: null })).rejects.toMatchObject(code('23514'));
    await expect(vaultFile({ mediaClass: 'video' })).rejects.toMatchObject(code('23514'));
    await expect(vaultFile({ language: 'klingon' })).rejects.toMatchObject(code('23514'));
  });

  it('extracted text and tags attach once and never change (55000)', async () => {
    const f = await vaultFile();
    const runId = await insertRun(db.sql, 'vault-curator', 'Execution');
    await as('xyp_vault', async (tx) => {
      await tx`insert into source_texts (source_id, text, extractor, agent_run_id) values (${f}, '[FIXTURE] [Verse 1] night city', 'text/plain', ${runId})`;
      const [t] = await tx<{ id: string }[]>`insert into tags (slug, label) values ('aos01-fixture-tag', 'fixture') on conflict (slug) do update set slug = excluded.slug returning id`;
      await tx`insert into source_tags (source_id, tag_id, agent_run_id) values (${f}, ${t!.id}, ${runId})`;
    });
    await expect(db.sql`update source_texts set text = 'x' where source_id = ${f}`).rejects.toMatchObject(code('55000'));
    await expect(db.sql`delete from source_tags where source_id = ${f}`).rejects.toMatchObject(code('55000'));
  });
});

describe('approvals of creative versions: a human decision, recorded once; the approved pointer never moves by itself', () => {
  const decide = (role: string, artifactId: string, decision: string, reason = '[FIXTURE] reviewed') =>
    as(role, async (tx) => (await tx<{ id: string }[]>`select xyp_decide_artifact(${artifactId}, ${decision}, 'owner', ${reason}) as id`)[0]!.id);
  const state = (lineage: string) => db.sql<{ version: number; status: string; approved_version: number | null }[]>`
    select version, status, approved_version from artifact_approvals where lineage_id = ${lineage} order by version`;

  it('draft → approved; a new version is a draft and the approved version stays; approving it moves the pointer; a rejection does not', async () => {
    const v1 = await lyrics();
    expect(await state(v1)).toEqual([{ version: 1, status: 'draft', approved_version: null }]);
    await decide('service_role', v1, 'approve');
    const v2 = await childOf(v1);
    expect(await state(v1)).toEqual([{ version: 1, status: 'approved', approved_version: 1 }, { version: 2, status: 'draft', approved_version: 1 }]);
    await decide('service_role', v2, 'approve');
    const v3 = await childOf(v2);
    await decide('service_role', v3, 'reject');
    expect(await state(v1)).toEqual([
      { version: 1, status: 'approved', approved_version: 2 },
      { version: 2, status: 'approved', approved_version: 2 },
      { version: 3, status: 'rejected', approved_version: 2 },
    ]);
    const [q] = await db.sql<{ item_type: string; status: string; decided_by: string }[]>`
      select item_type::text, status::text, decided_by from approval_queue where item_id = ${v3}`;
    expect(q).toEqual({ item_type: 'artifact_version', status: 'rejected', decided_by: 'owner' });
  });

  it('one decision per version (23505); needs an existing artifact, a decision and a reason', async () => {
    const v1 = await lyrics();
    await decide('service_role', v1, 'approve');
    await expect(decide('service_role', v1, 'reject')).rejects.toMatchObject(code('23505'));
    await expect(decide('service_role', '00000000-0000-4000-8000-000000000000', 'approve')).rejects.toMatchObject(code('23503'));
    await expect(decide('service_role', await lyrics(), 'maybe')).rejects.toMatchObject(code('22023'));
    await expect(decide('service_role', await lyrics(), 'approve', ' ')).rejects.toMatchObject(code('22023'));
  });

  it('only service_role (the owner) decides: no agent role can (42501)', async () => {
    const v1 = await lyrics();
    for (const role of ['xyp_vault', 'xyp_web', 'xyp_creative', 'xyp_runtime', 'anon', 'authenticated']) {
      await expect(decide(role, v1, 'approve')).rejects.toMatchObject(code('42501'));
    }
  });
});

describe('vault_embeddings and xyp_match_vault', () => {
  const vec = (hot: number) => `[${Array.from({ length: 384 }, (_, i) => (i === hot ? 1 : 0)).join(',')}]`;
  const embed = (kind: string, id: string, hot: number) => as('xyp_embedder', (tx) =>
    tx`insert into vault_embeddings (entity_kind, entity_id, embedding, model, input_sha256)
       values (${kind}, ${id}, ${vec(hot)}::extensions.vector, 'fixture-model', ${createHash('sha256').update(`${kind}${id}`).digest('hex')})`);

  it('indexes artifacts, Vault files and research findings; the entity must exist (23503); ranks by similarity', async () => {
    const a = await lyrics();
    const f = await vaultFile();
    await embed('artifact', a, 0);
    await embed('source', f, 1);
    await expect(embed('artifact', '00000000-0000-4000-8000-000000000000', 2)).rejects.toMatchObject(code('23503'));
    await expect(embed('song', a, 2)).rejects.toMatchObject(code('23514'));
    for (const role of ['xyp_runtime', 'xyp_web']) {
      const hits = await as(role, (tx) => tx<{ entity_kind: string; entity_id: string; similarity: number }[]>`
        select entity_kind, entity_id, similarity from xyp_match_vault(${vec(1)}::extensions.vector, 5, 'fixture-model')`);
      expect(hits[0]).toMatchObject({ entity_kind: 'source', entity_id: f });
      expect(hits[0]!.similarity).toBeCloseTo(1, 5);
    }
    await expect(as('anon', (tx) => tx`select * from xyp_match_vault(${vec(1)}::extensions.vector, 5, 'fixture-model')`)).rejects.toMatchObject(code('42501'));
  });

  it('research findings are indexable too', async () => {
    const researchRun = await insertResearchRun(db.sql);
    const evidence = await insertEvidence(db.sql, researchRun, 'a finding to embed');
    const [finding] = await as('xyp_research', async (tx) => tx<{ id: string }[]>`
      insert into research_findings (research_run_id, claim, model_tag, confidence, confidence_inputs, claim_topic, claim_value)
      values (${researchRun}, '[FIXTURE] finding', 'model-agnostic', 0.3, '{"basis":"fixture"}', 'x3lius.fixture-finding', '"x"') returning id`);
    expect(evidence).toMatch(/^[0-9a-f-]{36}$/);
    await embed('research_finding', finding!.id, 3);
  });
});

describe('grants: least privilege per new role', () => {
  it('xyp_web reads the Vault and writes nothing (42501)', async () => {
    const s = await song();
    for (const rel of ['current_songs', 'current_song_links', 'artifact_approvals', 'source_texts', 'vault_embeddings', 'sources', 'creative_artifacts']) {
      await expect(as('xyp_web', (tx) => tx.unsafe(`select 1 from ${rel} limit 1`))).resolves.toBeDefined();
    }
    const runId = await run();
    await expect(as('xyp_web', (tx) => revise(tx, s, {}, runId))).rejects.toMatchObject(code('42501'));
    await expect(as('xyp_web', (tx) => tx`insert into songs (agent_run_id) values (${runId})`)).rejects.toMatchObject(code('42501'));
  });

  it('xyp_vault writes songs, links and files; never artifacts, canonical knowledge or approvals (42501)', async () => {
    await expect(as('xyp_vault', (tx) => tx`insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model)
      values ('x3lius.lyrics/v2', 'x', gen_random_uuid(), 'x', '{}', '[]', '{}', 'none')`)).rejects.toMatchObject(code('42501'));
    await expect(as('xyp_vault', (tx) => tx`select 1 from canonical_prompts limit 1`)).rejects.toMatchObject(code('42501'));
    await expect(as('xyp_vault', (tx) => tx`select 1 from approval_queue limit 1`)).rejects.toMatchObject(code('42501'));
  });

  it('anon and authenticated get nothing', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const rel of ['songs', 'song_revisions', 'song_links', 'source_texts', 'vault_embeddings', 'current_songs']) {
        await expect(as(role, (tx) => tx.unsafe(`select 1 from ${rel}`))).rejects.toMatchObject(code('42501'));
      }
    }
  });
});
