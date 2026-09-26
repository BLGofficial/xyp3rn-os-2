import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl } from '../../core/db/client.ts';
import { packageText, readPackageExport, SUNO_PACKAGE_EXPORT_FORMAT } from '../../records/x3lius/suno/package-export.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { insertPackage } from '../helpers/package-fixture.ts';

// AOS-03 deliverable: the Suno prompt package export (design §5). xyp-suno-package/v1 is what the
// owner takes to Suno by hand: the four Suno fields, every version they came from with its approval
// status, the workflow that built it, and whether it may be handed off. Also rendered as copy-paste
// blocks, one per Suno field. `pnpm studio export` prints either, read-only, as xyp_web.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('aos03_package_export', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

const read = (id: string) => db.sql.begin(async (tx) => {
  await tx`set local role xyp_web`;
  return readPackageExport(tx, id);
});
const studio = (...args: string[]) => {
  const url = new URL(databaseUrl());
  url.pathname = `/${db.name}`;
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'records', 'x3lius', 'studio', 'cli.ts'), ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, XYP_DATABASE_URL: url.toString() }, timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe('xyp-suno-package/v1', () => {
  it('a ready package: the Suno fields, each version with its status, the workflow; nothing blocks it', async () => {
    const p = await insertPackage(db.sql);
    const e = await read(p.packageId);
    expect(e).toEqual({
      format: SUNO_PACKAGE_EXPORT_FORMAT,
      package: { id: p.packageId, version: 1, createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
      sunoModel: 'v5', title: p.prompt.title, style: p.prompt.style, excludeStyles: p.prompt.excludeStyles, lyrics: p.prompt.lyrics, limits: [],
      sources: [
        { role: 'lyrics', artifactId: p.lyricsId, schemaId: 'x3lius.lyrics/v2', version: 1, status: 'approved' },
        { role: 'style-recipe', artifactId: p.recipeId, schemaId: 'x3lius.style-recipe/v1', version: 1, status: 'approved' },
        { role: 'meta-tag-set', artifactId: p.tagSetId, schemaId: 'x3lius.meta-tag-set/v1', version: 1, status: 'approved' },
      ],
      workflow: { runId: p.workflowRunId, name: 'build-suno-package', sha256: 'a'.repeat(64), status: 'success' },
      ready: true, blockers: [],
    });
  });

  it('a draft package says what blocks it; an artifact that is not a package is refused', async () => {
    const p = await insertPackage(db.sql, { approve: ['lyrics'], workflow: 'none' });
    const e = await read(p.packageId);
    expect(e.ready).toBe(false);
    expect(e.workflow).toBeNull();
    expect(e.sources.map((s) => s.status)).toEqual(['approved', 'draft', 'draft']);
    expect(e.blockers).toHaveLength(3);
    await expect(read(p.lyricsId)).rejects.toThrow(/is a x3lius\.lyrics\/v2, not a x3lius\.suno-package\/v1/);
    await expect(read('00000000-0000-4000-8000-000000000000')).rejects.toThrow(/no package 00000000/);
  });

  it('the copy-paste text: one block per Suno field, as the Suno form names them', async () => {
    const p = await insertPackage(db.sql);
    expect(packageText(await read(p.packageId))).toBe([
      'SONG TITLE', p.prompt.title, '',
      'STYLE OF MUSIC', p.prompt.style, '',
      'EXCLUDE STYLES', p.prompt.excludeStyles.join(', '), '',
      'LYRICS', p.prompt.lyrics, '',
    ].join('\n'));
  });
});

describe('pnpm studio export', () => {
  it('prints the package as JSON, or as text with --text; refuses an unknown id (1) and bad usage (2)', async () => {
    const p = await insertPackage(db.sql);
    const json = studio('export', p.packageId);
    expect(json.code, json.err).toBe(0);
    expect(JSON.parse(json.out)).toEqual(JSON.parse(JSON.stringify(await read(p.packageId))));
    const text = studio('export', p.packageId, '--text');
    expect(text.code, text.err).toBe(0);
    expect(text.out).toBe(packageText(await read(p.packageId)));
    expect(studio('export', '00000000-0000-4000-8000-000000000000').code).toBe(1);
    expect(studio('export').code).toBe(2);
    expect(studio('frobnicate').code).toBe(2);
  });
});
