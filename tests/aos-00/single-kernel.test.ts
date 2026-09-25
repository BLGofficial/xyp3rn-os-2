import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/db.ts';

// AOS-00 gate (docs/artist-os/AOS-00-baseline.md §7): the Artist OS extends the existing kernel and
// never grows a parallel one. Each kernel entry point is defined in exactly one source file, there
// is one migrations directory, and agent files live only in agents/. A later phase that adds a
// second registry, engine, runner, gate or bootstrap fails here and must extend the owner instead.

const SKIP = new Set(['node_modules', '.git', '.local-db', '.local-models', 'docs']);
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    if (SKIP.has(f)) return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const files = walk(REPO_ROOT);
const rel = (p: string) => relative(REPO_ROOT, p);
const sources = files.filter((p) => /\.(ts|tsx|mts|js|mjs)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p) && !rel(p).startsWith('tests/'));

/** Kernel entry point → the one file that owns it. */
const OWNERS: Readonly<Record<string, string>> = {
  createAgentRegistry: 'core/agent-registry/registry.ts',
  createToolRegistry: 'core/tool-registry/registry.ts',
  CAPABILITIES: 'core/tool-registry/capabilities.ts',
  compileWorkflow: 'core/workflow-engine/engine.ts',
  runWorkflow: 'core/workflow-engine/engine.ts',
  dispatch: 'core/orchestrator/dispatch.ts',
  createLlmRunner: 'core/llm/runner.ts',
  createLlmClient: 'core/llm/providers.ts',
  ingestSource: 'knowledge/ingestion/ingest.ts',
  runGate: 'knowledge/promotion-gate/gate.ts',
  admitFirstParty: 'knowledge/promotion-gate/gate.ts',
  createContextEngine: 'core/context-engine/context-engine.ts',
  migrateUp: 'core/db/migrate.ts',
  DOMAINS: 'core/contracts/taxonomy.ts',
  AGENT_CLASSES: 'core/contracts/taxonomy.ts',
};

describe('AOS-00 gate: one kernel, extended, never duplicated', () => {
  it.each(Object.entries(OWNERS))('%s is defined once, in its owner', (name, owner) => {
    const def = new RegExp(`export\\s+(?:const|let|function|async\\s+function|class)\\s+${name}\\b`);
    const definers = sources.filter((p) => def.test(readFileSync(p, 'utf8'))).map(rel);
    expect(definers).toEqual([owner]);
  });

  it('has one migrations directory (supabase/migrations) and one rollbacks directory', () => {
    const dirs = [...new Set(files.filter((p) => p.endsWith('.sql')).map((p) => rel(p).split('/').slice(0, -1).join('/')))].sort();
    expect(dirs.filter((d) => /(^|\/)migrations$/.test(d))).toEqual(['supabase/migrations']);
    expect(dirs.filter((d) => /(^|\/)rollbacks$/.test(d))).toEqual(['supabase/rollbacks']);
  });

  it('keeps every agent definition in agents/ (one registry directory; registry test fixtures aside)', () => {
    expect(files.filter((p) => p.endsWith('.agent.md')).map(rel).filter((p) => !p.startsWith('agents/') && !p.includes('/fixtures/'))).toEqual([]);
  });
});
