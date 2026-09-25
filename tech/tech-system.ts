import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createManifestStub } from '../core/agents/manifest-stub.ts';
import type { AgentRegistry } from '../core/agent-registry/registry.ts';
import { parseScope, selectByScope, type Selection } from '../core/orchestrator/scope-select.ts';
import { parseModuleManifest, type ManifestModule, type ManifestSubdomain } from '../knowledge/ingestion/normalizers/module-manifest.ts';

/**
 * XYP3RN Tech (Phase 14): the TECH domain's four sub-components — Products, Audio Tools, AI Systems,
 * R&D — declared once in tech/tech.manifest.yaml. The gate admits it (modules + `subdomain_of`
 * edges), and the runtime routes by it. Each component has one agent named after its module.
 */

export const TECH_MANIFEST = join(import.meta.dirname, 'tech.manifest.yaml');

export type TechSystem = { readonly parent: ManifestModule; readonly components: readonly ManifestSubdomain[] };

/**
 * @returns the parent module and its components, in manifest order (same parser as ingestion)
 */
export const loadTechSystem = (): TechSystem => {
  const m = parseModuleManifest(readFileSync(TECH_MANIFEST, 'utf8'));
  return { parent: m.module, components: m.subdomains };
};

/** The stub handler for components no phase has built yet (Products, AI Systems). */
export const techStub = createManifestStub(() => ({ subdomains: loadTechSystem().components }), 'a TECH component');

/**
 * Picks the components a request is about, by each agent's `## Scope` keywords.
 * @param request - raw request routed to TECH
 * @param registry - Agent Registry holding one agent per component
 * @returns selected (score ≥ threshold) and not selected, with matched terms as evidence
 * @throws Error if a manifest component has no registered agent (misconfiguration, not "no match")
 */
export const selectComponents = (request: string, registry: Pick<AgentRegistry, 'get'>): Selection =>
  selectByScope(
    request,
    loadTechSystem().components.map((c) => {
      const agent = registry.get(c.slug);
      if (!agent) throw new Error(`TECH component ${c.slug} has no registered agent`);
      return parseScope(c.slug, agent.sections.Scope ?? '');
    }),
  );
