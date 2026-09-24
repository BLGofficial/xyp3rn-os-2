import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgentFile } from './parse-agent-file.ts';
import { createAgentRegistry, loadAgents } from './registry.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const AGENTS_DIR = join(import.meta.dirname, '..', '..', 'agents');
const VALID = join(FIXTURES, 'registry-fixture-valid.agent.md');
const BROKEN = join(FIXTURES, 'registry-fixture-missing-class.agent.md');

/** Variant of the valid fixture with one line of frontmatter/body replaced. */
const variant = (from: string, to: string) => readFileSync(VALID, 'utf8').replace(from, to);

describe('parseAgentFile (pure: path + contents in, result out)', () => {
  it('accepts the valid fixture and extracts frontmatter + body sections', () => {
    const r = parseAgentFile(VALID, readFileSync(VALID, 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agent).toMatchObject({
      name: 'registry-fixture-valid',
      class: 'Knowledge',
      domain: 'KNOWLEDGE',
      tools: ['log_message'],
      model: 'none',
      path: VALID,
    });
    expect(r.agent.role).toMatch(/^Test fixture for the Phase 4B Agent Registry parser/);
    expect(r.agent.contract).toMatch(/\*\*Inputs:\*\* none/);
    expect(r.agent.refuses).toMatch(/Being dispatched/);
  });

  it('rejects the broken fixture: missing class, with a clear reason', () => {
    const r = parseAgentFile(BROKEN, readFileSync(BROKEN, 'utf8'));
    expect(r).toEqual({ ok: false, path: BROKEN, errors: ['missing required field: class'] });
  });

  it.each([
    ['unknown class', 'class: Knowledge', 'class: Wizard', /unknown class: Wizard/],
    ['unknown domain', 'domain: KNOWLEDGE', 'domain: MARKETING', /unknown domain: MARKETING/],
    ['unknown key', 'model: none', 'model: none\nsubdomain: suno', /unknown field: subdomain/],
    ['name != filename', 'name: registry-fixture-valid', 'name: someone-else', /name "someone-else" must equal filename stem "registry-fixture-valid"/],
    ['tools not a list', 'tools: [log_message]', 'tools: log_message', /tools must be a list/],
    ['tool not snake_case', 'tools: [log_message]', 'tools: [Log-Message]', /tool name must be snake_case: Log-Message/],
    ['empty model', 'model: none', "model: ''", /model must be a non-empty string/],
    ['missing section', '## Refuses', '## Refusals', /missing body section: ## Refuses/],
  ])('rejects %s', (_label, from, to, reason) => {
    const r = parseAgentFile(VALID, variant(from, to));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(reason);
  });

  it('reports every problem in a file, not just the first', () => {
    const r = parseAgentFile(VALID, variant('class: Knowledge', 'class: Wizard').replace('domain: KNOWLEDGE', 'domain: MARKETING'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(['unknown class: Wizard', 'unknown domain: MARKETING']);
  });

  it('rejects a file with no frontmatter at all', () => {
    expect(parseAgentFile('/x/no-front.agent.md', '# Just a heading\n')).toEqual({
      ok: false,
      path: '/x/no-front.agent.md',
      errors: ['missing YAML frontmatter block'],
    });
  });
});

describe('validateAll over a directory', () => {
  it('finds the broken fixture among the fixtures and names its path + reason', () => {
    const snap = loadAgents(FIXTURES);
    expect(snap.agents.map((a) => a.name)).toEqual(['registry-fixture-valid']);
    expect(snap.failures).toEqual([{ path: BROKEN, errors: ['missing required field: class'] }]);
  });

  it('returns every failing file, not just the first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyp-agents-'));
    copyFileSync(VALID, join(dir, 'registry-fixture-valid.agent.md'));
    copyFileSync(BROKEN, join(dir, 'registry-fixture-missing-class.agent.md'));
    writeFileSync(join(dir, 'second-broken.agent.md'), variant('name: registry-fixture-valid', 'name: second-broken').replace('domain: KNOWLEDGE', 'domain: MARKETING'));
    const registry = createAgentRegistry({ dir, log: () => {} });
    expect(registry.validateAll().map((f) => basename(f.path))).toEqual([
      'registry-fixture-missing-class.agent.md',
      'second-broken.agent.md',
    ]);
  });

  it('skips _-prefixed templates explicitly (reported, not silently ignored)', () => {
    const snap = loadAgents(AGENTS_DIR);
    expect(snap.skipped.map((p) => basename(p))).toContain('_template.agent.md');
    expect(snap.failures).toEqual([]);
  });
});

describe('registry API: list / get / validateAll / refresh', () => {
  it('rejects loudly: one log line per failing file with path + reason', () => {
    const lines: string[] = [];
    createAgentRegistry({ dir: FIXTURES, log: (l) => lines.push(l) });
    expect(lines).toEqual([`[agent-registry] REJECTED ${BROKEN}: missing required field: class`]);
  });

  it('list() and get() serve only valid agents', () => {
    const registry = createAgentRegistry({ dir: FIXTURES, log: () => {} });
    expect(registry.list().map((a) => a.name)).toEqual(['registry-fixture-valid']);
    expect(registry.get('registry-fixture-valid')?.class).toBe('Knowledge');
    expect(registry.get('registry-fixture-missing-class')).toBeUndefined();
    expect(registry.snapshot().failures.map((f) => f.path)).toEqual([BROKEN]);
  });

  it('caches until refresh() is called (manual refresh is the only trigger)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyp-agents-'));
    copyFileSync(VALID, join(dir, 'registry-fixture-valid.agent.md'));
    const registry = createAgentRegistry({ dir, log: () => {} });
    writeFileSync(join(dir, 'late-arrival.agent.md'), variant('name: registry-fixture-valid', 'name: late-arrival'));
    expect(registry.get('late-arrival')).toBeUndefined();
    registry.refresh();
    expect(registry.get('late-arrival')?.name).toBe('late-arrival');
  });
});
