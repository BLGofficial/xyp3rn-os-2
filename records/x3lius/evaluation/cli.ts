import { connect } from '../../../core/db/client.ts';
import { createRuntimeDeps } from '../../../core/runtime/deps.ts';
import { evaluate } from './loop.ts';

// Usage: pnpm evaluate <artifactId>
// Runs the Phase 12 loop on the latest version of an artifact: Critic → Revision → Critic … until it
// converges, has no rules to check, or is queued for a human (decide with pnpm gate queue / decide).

const [artifactId] = process.argv.slice(2);
if (!artifactId) {
  console.error('usage: evaluate <artifactId>');
  process.exit(2);
}
const sql = connect(undefined, { max: 2 });
try {
  const r = await evaluate(createRuntimeDeps(sql), artifactId);
  r.critiqueIds.forEach((id, i) => console.log(`pass ${i + 1}: artifact ${r.artifactIds[i] ?? r.artifactIds.at(-1)} → critique ${id}: ${r.counts[i]} violation(s)`));
  console.log(`outcome: ${r.outcome}${r.escalationId ? ` — queued for a human as approval ${r.escalationId} (pnpm gate queue / pnpm gate decide)` : ''}${r.error ? ` — ${r.error}` : ''}`);
  console.log(JSON.stringify(r, null, 2));
  if (r.outcome === 'error') process.exitCode = 1;
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
