import { hudLoaders, runtime } from '../../lib/server';
import { first } from '../ui';
import { parseLens } from '../../lib/hud-theme';
import './hud.css';
import { HudShell } from './hud-shell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'XYP3RN Agentic OS · Mercury HUD' };

// The Mercury HUD (F52): a full-screen command deck over the app shell. The first render carries the data
// (components, status, identity); the client refreshes status and handles the globe. A failed read is shown as
// the error state, never as an empty graph.
export default async function Hud({ searchParams: pendingSearchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await pendingSearchParams;
  const [rt, hl] = [await runtime(), await hudLoaders()];
  const settle = async <T,>(p: Promise<T>): Promise<[T | null, string | null]> => {
    try { return [await p, null]; } catch (e) { console.error('hud load failed:', e); return [null, 'the server could not read the graph']; }
  };
  const [[components, componentsError], [status], identity] = await Promise.all([
    settle(hl.hudComponents(rt.sql)),
    settle(hl.hudStatus(rt.sql, process.env, rt.deps.registry)),
    hl.hudIdentity(),
  ]);
  return (
    <HudShell identity={identity} owner={process.env.XYP_OWNER || 'owner'} components={components} componentsError={componentsError}
      status={status} lens={parseLens(first(searchParams.lens))} />
  );
}
