import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAgentFile, type AgentDefinition } from './parse-agent-file.ts';
import { registeredComponents, type Component } from './components.ts';

export type ValidationFailure = { readonly path: string; readonly errors: readonly string[] };

export type RegistrySnapshot = {
  readonly agents: readonly AgentDefinition[];
  readonly failures: readonly ValidationFailure[];
  /** `_`-prefixed templates: listed so skipping is visible, never silent. */
  readonly skipped: readonly string[];
};

/**
 * Scans a directory for *.agent.md and parses each one. Reads files; decides nothing else.
 * @param dir - the agents directory ({{AGENTS_DIR}})
 * @returns valid agents (by name), every failure (by path), and skipped templates
 */
export const loadAgents = (dir: string): RegistrySnapshot => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.agent.md')).sort();
  const agents: AgentDefinition[] = [];
  const failures: ValidationFailure[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const path = join(dir, f);
    if (f.startsWith('_')) {
      skipped.push(path);
      continue;
    }
    const r = parseAgentFile(path, readFileSync(path, 'utf8'));
    if (r.ok) agents.push(r.agent);
    else failures.push({ path: r.path, errors: r.errors });
  }
  return { agents: agents.sort((a, b) => a.name.localeCompare(b.name)), failures, skipped };
};

export type AgentRegistry = {
  readonly components: () => readonly Component[];
  readonly list: () => readonly AgentDefinition[];
  readonly get: (name: string) => AgentDefinition | undefined;
  /** Re-reads the directory and returns every failure. Does not replace the cache. */
  readonly validateAll: () => readonly ValidationFailure[];
  /** Re-reads the directory, replaces the cache, and logs every rejection. */
  readonly refresh: () => RegistrySnapshot;
  /** The cached snapshot as of the last refresh (agents, failures, skipped templates). */
  readonly snapshot: () => RegistrySnapshot;
};

/**
 * Agent Registry with an in-memory cache. Refresh trigger: manual `refresh()` only (also run
 * once at creation). No file watcher — a watch would make the registry change mid-dispatch.
 * @param options - agents directory and the sink for loud rejections (default stderr)
 * @returns list/get/validateAll/refresh over the cached snapshot
 */
export const createAgentRegistry = (options: {
  readonly dir: string;
  readonly log?: (line: string) => void;
}): AgentRegistry => {
  const { dir, log = (line: string) => console.error(line) } = options;
  let snapshot: RegistrySnapshot;

  const refresh = (): RegistrySnapshot => {
    snapshot = loadAgents(dir);
    for (const f of snapshot.failures) log(`[agent-registry] REJECTED ${f.path}: ${f.errors.join('; ')}`);
    return snapshot;
  };
  refresh();

  return {
    components: () => registeredComponents(join(dir, '..')),
    list: () => snapshot.agents,
    get: (name) => snapshot.agents.find((a) => a.name === name),
    validateAll: () => loadAgents(dir).failures,
    refresh,
    snapshot: () => snapshot,
  };
};
