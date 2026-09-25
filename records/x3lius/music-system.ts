import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRegistry } from '../../core/agent-registry/registry.ts';
import { parseScope, selectByScope, type Selection } from '../../core/orchestrator/scope-select.ts';
import { parseModuleManifest, type ManifestModule, type ManifestSubdomain } from '../../knowledge/ingestion/normalizers/module-manifest.ts';
import { REPO_ROOT } from '../../core/repo.ts';

/**
 * X3LIUS Music System (Phase 7) — the RECORDS module that owns the ten X3LIUS sub-domains.
 * The manifest next to this file is the single source of what exists: the gate admits it into
 * canonical knowledge (modules + `subdomain_of` edges), and the runtime routes by it. Each
 * sub-domain has one stub agent named after its module; stubs return scoped context only.
 */

/** Operator-authored first-party manifest: `pnpm ingest --file <this> --origin first_party`. */
export const MUSIC_SYSTEM_MANIFEST = join(REPO_ROOT, 'records/x3lius/music-system.manifest.yaml');
/** The RECORDS entrypoint service name (core/orchestrator/orchestrate.ts ENTRYPOINTS). */
export const MUSIC_SYSTEM_SERVICE = 'x3lius-music-system';

export type MusicSystem = { readonly parent: ManifestModule; readonly subdomains: readonly ManifestSubdomain[] };

/**
 * Reads the manifest (same parser the ingestion normalizer uses, so the two can't drift).
 * @returns parent module and its sub-domains, in manifest order
 */
export const loadMusicSystem = (): MusicSystem => {
  const m = parseModuleManifest(readFileSync(MUSIC_SYSTEM_MANIFEST, 'utf8'));
  return { parent: m.module, subdomains: m.subdomains };
};

/**
 * Picks the sub-domains a request is about, by each stub agent's `## Scope` keywords.
 * @param request - raw request routed to RECORDS
 * @param registry - Agent Registry holding one stub per sub-domain
 * @returns selected (score ≥ threshold) and not selected, with matched terms as evidence
 * @throws Error if a manifest sub-domain has no registered agent (misconfiguration, not "no match")
 */
export const selectSubdomains = (request: string, registry: Pick<AgentRegistry, 'get'>): Selection =>
  selectByScope(
    request,
    loadMusicSystem().subdomains.map((s) => {
      const agent = registry.get(s.slug);
      if (!agent) throw new Error(`sub-domain ${s.slug} has no registered agent`);
      return parseScope(s.slug, agent.sections.Scope ?? '');
    }),
  );
