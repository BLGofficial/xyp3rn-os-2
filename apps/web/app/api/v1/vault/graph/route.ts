import { runtime } from '../../../../../lib/server';
import { draftGraph, listDrafts } from '../../../../../server/vault-drafts';
import { knowledgeGraph, read } from '../../_lib';

export const dynamic = 'force-dynamic';

// The /vault explorer's graph: the knowledge graph the dashboard uses, plus the Obsidian drafts the watcher staged.
export const GET = (): Promise<Response> => read('the vault graph', async () => {
  const [base, drafts] = await Promise.all([knowledgeGraph(), runtime().then((rt) => listDrafts(rt.sql).then(draftGraph))]);
  return { nodes: [...base.nodes, ...drafts.nodes], links: [...base.links, ...drafts.links], asOf: base.asOf };
});
