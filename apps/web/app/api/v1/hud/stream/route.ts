import { hudSse, isLive } from '../../_lib';

// KnowledgeGraphExplorer's live feed: each HUD activity row as an AGENT_RUN_UPDATE (running or idle).
export const dynamic = 'force-dynamic';

export const GET = (req: Request): Promise<Response> =>
  hudSse(req, (e) => [{ event: 'AGENT_RUN_UPDATE', data: { status: isLive(e.status) ? 'running' : 'idle', title: e.title, kind: e.kind, at: e.at } }]);
