import { join } from 'node:path';
import { createAgentRegistry } from './registry.ts';

// Usage: node core/agent-registry/cli.ts [dir]   (default: agents/)
// Prints every valid agent, every rejection (path + reason) and every skipped template.
// Exits 1 if anything was rejected.

const dir = process.argv[2] ?? join(import.meta.dirname, '..', '..', 'agents');
const registry = createAgentRegistry({ dir });
const snap = registry.snapshot();

for (const a of snap.agents) console.log(`OK        ${a.name}  class=${a.class} domain=${a.domain} tools=[${a.tools.join(', ')}] model=${a.model}`);
for (const s of snap.skipped) console.log(`SKIPPED   ${s} (template)`);
const failures = registry.validateAll();
console.log(`\nvalidateAll(): ${failures.length} failure(s)`);
for (const f of failures) console.log(`  ${f.path}\n    - ${f.errors.join('\n    - ')}`);
if (failures.length > 0) process.exitCode = 1;
