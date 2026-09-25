import type { ContextBundle } from '../context-engine/context-engine.ts';
import type { AgentHandler } from '../orchestrator/dispatch.ts';
import type { ManifestSubdomain } from '../../knowledge/ingestion/normalizers/module-manifest.ts';

/**
 * The stub handler for a manifest's sub-components (Phase 7 for X3LIUS, Phase 14 for TECH). No
 * domain logic: it returns what the component currently knows — the Context Engine scoped to the
 * component's module (the agent's own name) — and says plainly that it is a stub and which phase
 * builds it.
 * @param load - reads the manifest's sub-components (the same parser ingestion uses)
 * @param what - how an error names the manifest, e.g. `an X3LIUS sub-domain`
 * @returns the handler: `{ request }` → `{ subdomain, status: 'stub', builtIn, request, generation, context }`
 */
export const createManifestStub = (load: () => { readonly subdomains: readonly ManifestSubdomain[] }, what: string): AgentHandler =>
  async (ctx, input) => {
    const request = (input as { request?: unknown } | null)?.request;
    if (typeof request !== 'string' || request.trim() === '') throw new Error('request must be a non-empty string');
    const sub = load().subdomains.find((s) => s.slug === ctx.agent.name);
    if (!sub) throw new Error(`${ctx.agent.name} is not ${what} in the manifest`);
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
