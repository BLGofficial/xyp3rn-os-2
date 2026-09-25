import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTraceSchemas, TRACE_SCHEMA_DIR } from './schemas.ts';

// Usage: node tech/trace/schemas-cli.ts — rewrites tech/trace/schemas/*.schema.json from the contract.

for (const [name, text] of Object.entries(renderTraceSchemas())) {
  writeFileSync(join(TRACE_SCHEMA_DIR, name), text);
  console.log(`wrote tech/trace/schemas/${name}`);
}
