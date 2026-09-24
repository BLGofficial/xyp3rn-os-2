import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { AGENT_CLASSES, DOMAINS, DOMAIN_META } from '../../core/contracts/taxonomy.ts';

// Phase 0 proof: the docs, the scaffold and the taxonomy constant must agree.
// Later phases import the constant, so drift between it and the docs is a contract break.

const ROOT = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const headings = (md: string) => md.split('\n').filter((l) => /^#{1,6} /.test(l));

describe('taxonomy constant', () => {
  it('declares exactly six unique domains and eight unique agent classes', () => {
    expect(new Set(DOMAINS).size).toBe(6);
    expect(new Set(AGENT_CLASSES).size).toBe(8);
  });

  it('gives every domain a unique directory and a unique hex color', () => {
    const dirs = DOMAINS.map((d) => DOMAIN_META[d].dir);
    const colors = DOMAINS.map((d) => DOMAIN_META[d].color.toLowerCase());
    expect(new Set(dirs).size).toBe(6);
    expect(new Set(colors).size).toBe(6);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('repo scaffold', () => {
  it.each(DOMAINS.map((d) => [d, DOMAIN_META[d].dir] as const))(
    '%s has top-level directory %s/',
    (_domain, dir) => {
      expect(existsSync(join(ROOT, dir)) && statSync(join(ROOT, dir)).isDirectory()).toBe(true);
    },
  );

  it.each(['docs', 'agents', 'supabase'])('infra directory %s/ exists', (dir) => {
    expect(existsSync(join(ROOT, dir))).toBe(true);
  });
});

describe('docs/ARCHITECTURE.md', () => {
  it.each([...DOMAINS])('has a section heading naming domain %s', (domain) => {
    const hs = headings(read('docs/ARCHITECTURE.md'));
    expect(hs.some((h) => new RegExp(`\\b${domain}\\b`).test(h))).toBe(true);
  });

  it.each([...DOMAINS])('repo map row for %s matches taxonomy dir + color', (domain) => {
    const { dir, color } = DOMAIN_META[domain];
    const row = read('docs/ARCHITECTURE.md')
      .split('\n')
      .find((l) => l.startsWith(`| \`${domain}\` |`));
    expect(row, `no repo map row for ${domain}`).toBeDefined();
    expect(row).toContain(`\`${dir}/\``);
    expect(row).toContain(`\`${color}\``);
  });

  it('states the single-canonical-writer invariant', () => {
    expect(read('docs/ARCHITECTURE.md')).toMatch(/Knowledge Promotion Gate/);
  });
});

describe('docs/AGENT_CLASSES.md', () => {
  const md = () => read('docs/AGENT_CLASSES.md');
  // Split on level-2 headings so each class section is checked in isolation.
  const section = (cls: string) => {
    const parts = md().split(/^## /m);
    return parts.find((p) => p.startsWith(`${cls}\n`) || p.startsWith(`${cls} `)) ?? '';
  };

  it.each([...AGENT_CLASSES])('class %s has name, question, inputs, outputs, forbidden', (cls) => {
    const s = section(cls);
    expect(s, `missing "## ${cls}" section`).not.toBe('');
    for (const field of ['Question', 'Allowed inputs', 'Allowed outputs', 'Forbidden to mutate']) {
      expect(s, `${cls} missing "${field}"`).toContain(`**${field}**`);
    }
  });
});

describe('agents/_template.agent.md', () => {
  const raw = () => read('agents/_template.agent.md');

  it('has YAML frontmatter with exactly name, class, domain, tools, model', () => {
    const m = raw().match(/^---\n([\s\S]*?)\n---\n/);
    expect(m, 'no frontmatter block').not.toBeNull();
    const fm = parseYaml(m![1]!) as Record<string, unknown>;
    expect(Object.keys(fm).sort()).toEqual(['class', 'domain', 'model', 'name', 'tools']);
    expect(AGENT_CLASSES).toContain(fm.class);
    expect(DOMAINS).toContain(fm.domain);
    expect(Array.isArray(fm.tools)).toBe(true);
  });

  it.each(['## Role', '## Contract', '## Refuses'])('body has section %s', (h) => {
    expect(raw().split('\n')).toContain(h);
  });
});

describe('docs/NAMING.md', () => {
  it.each([
    'Tables',
    'Columns',
    'Agent files',
    'Agent classes',
    'Domains',
    'Tools',
    'Capabilities',
    'DB roles',
    'Migrations',
    'TypeScript modules',
    'Tests',
    'Handoffs',
  ])('has a "%s" category with a worked example', (cat) => {
    const md = read('docs/NAMING.md');
    const parts = md.split(/^### /m);
    const s = parts.find((p) => p.startsWith(`${cat}\n`)) ?? '';
    expect(s, `missing "### ${cat}"`).not.toBe('');
    expect(s, `"${cat}" has no worked example`).toMatch(/Example:/);
  });
});
