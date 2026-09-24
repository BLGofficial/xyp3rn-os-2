import { join } from 'node:path';
import { connect } from '../../core/db/client.ts';
import { seedFkProof } from './fk-proof.ts';

// Runs the FK-proof seed against XYP_DATABASE_URL, prints the joined chain, then rolls back.
// Usage: node supabase/seed/run-fk-proof.ts

const ROLLBACK = Symbol('rollback');
const sql = connect(undefined, { max: 1 });

try {
  await sql.begin(async (tx) => {
    const ids = await seedFkProof(tx, join(import.meta.dirname, '..', '..'));
    const chain = await tx`
      select s.uri as source, left(s.checksum_sha256, 12) as checksum, ir.status as run_status,
             m.slug as module, m.domain, cp.slug as canonical_prompt, cp.promoted_via,
             pv.label as variant, t.slug as tag,
             r.subject_type || ' -' || r.predicate || '-> ' || r.object_type as relation,
             qr.rubric_version, qr.overall
      from canonical_prompts cp
      join modules m on m.id = cp.module_id
      join sources s on s.id = cp.source_id
      join ingestion_runs ir on ir.source_id = s.id
      join prompt_variants pv on pv.canonical_prompt_id = cp.id
      join prompt_tags pt on pt.canonical_prompt_id = cp.id
      join tags t on t.id = pt.tag_id
      join relations r on r.subject_id = cp.id::text and r.object_id = s.id::text
      join quality_reports qr on qr.source_id = s.id and qr.ingestion_run_id = ir.id
      where cp.id = ${ids.canonicalPromptId}`;
    console.log(JSON.stringify(chain[0], null, 2));
    throw ROLLBACK;
  });
} catch (e) {
  if (e !== ROLLBACK) throw e;
  const [c] = await sql<{ n: number }[]>`select count(*)::int as n from sources`;
  console.log(`rolled back — sources rows after: ${c!.n}`);
} finally {
  await sql.end();
}
