import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_CLASSES } from '../../core/contracts/taxonomy.ts';
import { CAPABILITIES, CLASS_CAPABILITIES } from '../../core/tool-registry/capabilities.ts';

// The capability matrix exists twice by necessity: prose contract (docs/AGENT_CLASSES.md) and
// enforced code (capabilities.ts). This test makes drift between them a build failure.

const doc = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'AGENT_CLASSES.md'), 'utf8');

const parseMatrix = () => {
  const lines = doc.split('\n');
  const header = lines.findIndex((l) => l.startsWith('| Capability |'));
  const cols = lines[header]!.split('|').map((c) => c.trim()).filter(Boolean).slice(2);
  const rows = new Map<string, string[]>();
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
    const cap = cells[0]!.replaceAll('`', '');
    rows.set(cap, cols.filter((_, i) => cells[i + 2] === 'Y'));
  }
  return { cols, rows };
};

describe('docs/AGENT_CLASSES.md ⇄ core/tool-registry/capabilities.ts', () => {
  it('lists the eight classes as columns, in taxonomy order', () => {
    expect(parseMatrix().cols).toEqual([...AGENT_CLASSES]);
  });

  it('has exactly the same capabilities', () => {
    expect([...parseMatrix().rows.keys()].sort()).toEqual([...CAPABILITIES].sort());
  });

  it.each([...CAPABILITIES])('grants %s to exactly the same classes', (cap) => {
    expect(parseMatrix().rows.get(cap)).toEqual(AGENT_CLASSES.filter((c) => CLASS_CAPABILITIES[cap].includes(c)));
  });
});
