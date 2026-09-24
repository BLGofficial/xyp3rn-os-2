import { connect } from '../../core/db/client.ts';
import { loadEmbedder } from './embedder.ts';
import { embedPending } from './pipeline.ts';

// Usage: node knowledge/vector-retrieval/cli.ts — embeds every row whose input changed.

const sql = connect(undefined, { max: 2 });
try {
  console.log(JSON.stringify(await embedPending(sql, await loadEmbedder()), null, 2));
} finally {
  await sql.end();
}
