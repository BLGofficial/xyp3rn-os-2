import { hudSse, isLive, laneOf } from '../../../_lib';

// ContextDispatchPipeline's feed: a run that starts lights its lane's agent step; a run that ends completes the lane.
export const dynamic = 'force-dynamic';

const LAST_STEP = 3;

export const GET = (req: Request): Promise<Response> =>
  hudSse(req, (e) => [isLive(e.status)
    ? { event: 'WORKFLOW_STEP_START', data: { pipelineId: laneOf(e), stepIndex: 2, title: e.title } }
    : { event: 'WORKFLOW_STEP_COMPLETE', data: { pipelineId: laneOf(e), stepIndex: LAST_STEP, title: e.title, status: e.status } }]);
