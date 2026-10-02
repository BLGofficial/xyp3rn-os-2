import { notFound } from 'next/navigation';
import { askOps, runtime } from '../../../lib/server';
import { cancelAskAction } from '../../ask-actions';
import { RunRefresh } from '../../research/run-refresh';
import { ErrorBanner, Status } from '../../ui';

export const dynamic = 'force-dynamic';

const TIER: Record<string, string> = {
  skill: 'Skill (Claude Code)', deep: 'Deep task (Claude Code)', lookup: 'Stored data', hold: 'On hold', clarify: 'Needs clarification',
  'run-service': 'Domain run', 'run-workflow': 'Workflow run',
};

// One Ask request (JARVIS Prompt 04 gap: the assistant surface). The reply is built only from the real result;
// runs point to their own pages. Jobs live in the server process: after a restart this page is a 404, never a
// false "done".
export default async function Ask({ params: pendingParams, searchParams: pendingSearchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await pendingParams;
  const searchParams = await pendingSearchParams;
  const v = (await askOps()).getAsk((await runtime()).owner, params.id);
  if (!v) notFound();
  const running = v.state === 'running';
  const refs = v.refs;
  return (
    <section aria-labelledby="ask-h" className="flex flex-col gap-4">
      {running && <RunRefresh seconds={3} />}
      <h1 id="ask-h">Ask</h1>
      <ErrorBanner error={searchParams.error} />
      <dl className="meta grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt>Tier</dt><dd>{TIER[v.action] ?? v.action}{v.route.domain ? ` · ${v.route.domain}` : ''}</dd>
        <dt>Status</dt><dd><Status status={v.status} /></dd>
      </dl>
      <p className="card" aria-live="polite">{v.reply}</p>
      {refs && (refs.researchRunId || refs.workflowRunId) && (
        <p className="meta">
          {refs.researchRunId && <a href={`/research/runs/${refs.researchRunId}`} className="mr-3">Research run</a>}
          {refs.workflowRunId && <a href="/workflows">Workflow run {refs.workflowRunId.slice(0, 8)}</a>}
        </p>
      )}
      {running && (v.action === 'skill' || v.action === 'deep') && (
        <form action={cancelAskAction}><input type="hidden" name="requestId" value={v.requestId} /><button type="submit">Cancel</button></form>
      )}
      <p><a href="/">Back to Command</a></p>
    </section>
  );
}
