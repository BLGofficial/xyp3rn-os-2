import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILD_GUIDE_PDF, seedFkProof } from '../../supabase/seed/fk-proof.ts';
import type { Queryable } from '../../core/db/client.ts';
import { createTestDb, REPO_ROOT, withRollback, type TestDb } from '../helpers/db.ts';

// Phase 1 proof: one real row per table, sourced from the uploaded build guide, proves the
// FK chain holds end to end. Rolled back by design (user decision): Phase 2's ingestion of
// the same PDF must be a first-time write, not a checksum no-op against a seed row.

const TABLES = [
  'sources',
  'modules',
  'canonical_prompts',
  'prompt_variants',
  'tags',
  'prompt_tags',
  'relations',
  'ingestion_runs',
  'quality_reports',
];

const counts = async (sql: Queryable) => {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const [r] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from public.${t}`);
    out[t] = r!.n;
  }
  return out;
};

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('phase01_seed', { migrated: true });
});
afterAll(async () => {
  await db?.drop();
});

describe('fk-proof seed', () => {
  it('writes exactly one row per table inside the transaction, then leaves nothing behind', async () => {
    const inside = await withRollback(db.sql, async (tx) => {
      await seedFkProof(tx, REPO_ROOT);
      return counts(tx);
    });
    expect(inside).toEqual(Object.fromEntries(TABLES.map((t) => [t, 1])));
    expect(await counts(db.sql)).toEqual(Object.fromEntries(TABLES.map((t) => [t, 0])));
  });

  it('registers the real build-guide PDF: checksum and size match the file on disk', async () => {
    const bytes = readFileSync(join(REPO_ROOT, BUILD_GUIDE_PDF));
    const sha = createHash('sha256').update(bytes).digest('hex');
    const row = await withRollback(db.sql, async (tx) => {
      const ids = await seedFkProof(tx, REPO_ROOT);
      const [s] = await tx<{ uri: string; checksum_sha256: string; byte_size: string }[]>`
        select uri, checksum_sha256, byte_size from sources where id = ${ids.sourceId}`;
      return s!;
    });
    expect(row).toEqual({ uri: BUILD_GUIDE_PDF, checksum_sha256: sha, byte_size: String(bytes.length) });
  });
});
