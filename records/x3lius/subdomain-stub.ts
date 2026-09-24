import type { ContextBundle } from '../../core/context-engine/context-engine.ts';
import type { AgentHandler } from '../../core/orchestrator/dispatch.ts';
import { loadMusicSystem } from './music-system.ts';

/**
 * Handler shared by the ten X3LIUS sub-domain stub agents (Phase 7). No creative logic: it
 * returns what the sub-domain currently knows — the Context Engine scoped to the sub-domain's
 * module (the agent's own name), so a rule the gate promoted into it is consumable here — and
 * says plainly that the sub-domain is a stub and which phase builds it.
 * @param ctx - run context; ctx.agent.name is the sub-domain module slug
 * @param input - `{ request }`
 * @returns `{ subdomain, status: 'stub', builtIn, request, generation, context }`
 */
export const subdomainStub: AgentHandler = async (ctx, input) => {
  const request = (input as { request?: unknown } | null)?.request;
  if (typeof request !== 'string' || request.trim() === '') throw new Error('request must be a non-empty string');
  const sub = loadMusicSystem().subdomains.find((s) => s.slug === ctx.agent.name);
  if (!sub) throw new Error(`${ctx.agent.name} is not an X3LIUS sub-domain in the manifest`);
  const bundle = (await ctx.useTool('retrieve_context', { query: request, scope: { modules: [sub.slug] } })) as ContextBundle;
  await ctx.useTool('log_message', { message: `${sub.slug}: ${bundle.items.length} scoped item(s); stub until ${sub.builtIn ? `Phase ${sub.builtIn}` : 'a phase builds it'}` });
  return {
    output: {
      subdomain: sub.slug,
      status: 'stub',
      builtIn: sub.builtIn,
      request,
      generation: bundle.generation,
      context: bundle.items.map(({ ref, slug, title, text, score, why, source }) => ({ ref, slug, title, text, score, why, source })),
    },
    tokensUsed: 0,
  };
};
