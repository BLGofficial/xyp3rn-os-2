import { connect } from '../../core/db/client.ts';
import { loadEmbedder } from './embedder.ts';
import { embedPending, embedVault } from './pipeline.ts';

// Usage: node knowledge/vector-retrieval/cli.ts — embeds every row whose input changed: the knowledge
// index (canonical prompts, knowledge sources), then the vault corpus index (AOS-01) under `vault`.

const sql = connect(undefined, { max: 2 });
try {
  const embedder = await loadEmbedder();
  console.log(JSON.stringify({ ...(await embedPending(sql, embedder)), vault: await embedVault(sql, embedder) }, null, 2));
} finally {
  await sql.end();
}
