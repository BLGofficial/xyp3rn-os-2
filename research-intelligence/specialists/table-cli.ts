import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { parseScope } from '../orchestrator/select.ts';
import { renderSpecialistTable } from './table.ts';

// Usage: node research-intelligence/specialists/table-cli.ts — regenerates docs/research/SPECIALISTS.md.

const root = join(import.meta.dirname, '..', '..');
const registry = createAgentRegistry({ dir: join(root, 'agents') });
const scopes = registry
  .list()
  .filter((a) => a.class === 'Research')
  .map((a) => parseScope(a.name, a.sections.Scope ?? ''));
const out = join(root, 'docs', 'research', 'SPECIALISTS.md');
writeFileSync(out, renderSpecialistTable(scopes));
console.log(`wrote ${out} (${scopes.length} specialists)`);
