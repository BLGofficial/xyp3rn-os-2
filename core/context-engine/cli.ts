import { connect } from '../db/client.ts';
import { loadEmbedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { createContextEngine } from './context-engine.ts';

// Usage: node core/context-engine/cli.ts "<query>" [--json] [--vault]
// Prints the ranked bundle: score, table:slug, and why each item was included. --vault searches the
// vault corpus (AOS-01): the owner's lyrics, files and findings next to canonical knowledge.

const query = process.argv[2];
if (!query) {
  console.error('usage: cli.ts "<query>" [--json] [--vault]');
  process.exit(2);
}

const sql = connect(undefined, { max: 2 });
try {
  if (process.argv.includes('--vault')) {
    const v = await createContextEngine(sql, await loadEmbedder()).retrieve(query, { corpus: 'vault' });
    if (process.argv.includes('--json')) console.log(JSON.stringify(v, null, 2));
    else {
      console.log(`query: ${v.query}\ncorpus: vault  model: ${v.model}`);
      for (const [n, i] of v.items.entries()) {
        console.log(`\n#${n + 1}  ${i.similarity.toFixed(4)}  ${i.kind}  ${i.title}`);
        console.log(`    row:    ${i.id}${i.lineage ? `  lineage ${i.lineage.id} v${i.lineage.version} (${i.lineage.schemaId})` : ''}${i.mediaClass ? `  ${i.mediaClass}` : ''}`);
        console.log(`    songs:  ${i.songs.map((s) => s.title).join(', ') || 'none'}`);
      }
      console.log(`\ndiagnostics: ${JSON.stringify(v.diagnostics)}`);
    }
  } else {
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
  }
} finally {
  await sql.end();
}
