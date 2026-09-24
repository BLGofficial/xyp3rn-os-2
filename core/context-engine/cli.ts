import { connect } from '../db/client.ts';
import { loadEmbedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { createContextEngine } from './context-engine.ts';

// Usage: node core/context-engine/cli.ts "<query>" [--json]
// Prints the ranked bundle: score, table:slug, and why each item was included.

const query = process.argv[2];
if (!query) {
  console.error('usage: cli.ts "<query>" [--json]');
  process.exit(2);
}

const sql = connect(undefined, { max: 2 });
try {
  const bundle = await createContextEngine(sql, await loadEmbedder()).retrieve(query);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(bundle, null, 2));
  } else {
    console.log(`query: ${bundle.query}\nmodel: ${bundle.model}  cache: ${bundle.cache}  generation: ${bundle.generation}`);
    for (const [n, i] of bundle.items.entries()) {
      console.log(`\n#${n + 1}  ${i.score.toFixed(4)}  ${i.ref.table}:${i.slug ?? i.ref.id}  [${i.domain ?? '-'}]`);
      console.log(`    row:    ${i.ref.table}.id = ${i.ref.id}`);
      console.log(`    source: ${i.source ? `${i.source.uri} (${i.source.id})` : 'none'}`);
      console.log(`    why:    ${i.why}`);
    }
    console.log(`\ndiagnostics: ${JSON.stringify(bundle.diagnostics)}`);
  }
} finally {
  await sql.end();
}
