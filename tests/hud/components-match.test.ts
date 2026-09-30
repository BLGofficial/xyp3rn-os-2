import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { COMPONENTS, componentId, matchComponent, SHARED } from '../../knowledge/knowledge-graph/components.ts';
import { REPO_ROOT } from '../helpers/db.ts';

// Mercury HUD (F52): the path-rule table matches every repo file to exactly one sub-component. Pure: no DB.

describe('matchComponent', () => {
  it.each([
    ['core/orchestrator/ask.ts', 'CORE', 'CORE:orchestrator'],
    ['core/workflows/retrieve-and-summarize.workflow.yaml', 'CORE', 'CORE:workflow-engine'],
    ['knowledge/vector-retrieval/embedder.ts', 'KNOWLEDGE', 'KNOWLEDGE:vector-retrieval'],
    ['research-intelligence/specialists/select.ts', 'RESEARCH_INTELLIGENCE', 'RESEARCH_INTELLIGENCE:specialists'],
    ['agents/suno-researcher.agent.md', 'RESEARCH_INTELLIGENCE', 'RESEARCH_INTELLIGENCE:specialists'],
    ['records/x3lius/vocal-dna/profile.ts', 'RECORDS', 'RECORDS:vocal-dna'],
    ['records/x3lius/vocal-dna.yaml', 'RECORDS', 'RECORDS:vocal-dna'],
    ['agents/x3lius-suno-package.agent.md', 'RECORDS', 'RECORDS:suno'],
    ['agents/x3lius-lyric-editor.agent.md', 'RECORDS', 'RECORDS:lyrics'],
    ['records/ops/catalog/tools.ts', 'RECORDS', 'RECORDS:catalog'],
    ['agents/records-catalog-lookup.agent.md', 'RECORDS', 'RECORDS:catalog'],
    ['tech/r-and-d/backlog.ts', 'TECH', 'TECH:r-and-d'],
    ['tech/trace/report.ts', 'TECH', 'TECH:trace'],
    ['governance/approvals.ts', 'GOVERNANCE', 'GOVERNANCE:human-approval'],
  ] as const)('%s → %s', (path, owner, id) => {
    expect(matchComponent(path, owner)).toBe(id);
  });

  it("falls back to the owner domain's Other, then to Shared", () => {
    expect(matchComponent('records/x3lius/music-system.ts', 'RECORDS')).toBe('RECORDS:other');
    expect(matchComponent('agents/vault-curator.agent.md', 'KNOWLEDGE')).toBe('KNOWLEDGE:other');
    expect(matchComponent('docs/ARCHITECTURE.md', null)).toBe(SHARED);
    expect(matchComponent(null, 'CORE')).toBe('CORE:other');
  });

  it('the most specific rule wins, whatever the table order', () => {
    // `agents/*-researcher.agent.md` (specialists) is less specific than an exact agent file.
    expect(matchComponent('agents/research-orchestrator.agent.md', 'RESEARCH_INTELLIGENCE')).toBe('RESEARCH_INTELLIGENCE:research-orchestrator');
  });

  it('ids are unique, and every rule is repo-relative', () => {
    const ids = COMPONENTS.map((c) => componentId(c.domain, c.slug));
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of COMPONENTS) for (const r of c.rules) expect(r).toMatch(/^[a-z][a-z0-9-]*\/[^\\]*$/);
  });

  it('every x3lius and records agent in this repo lands on a named sub-component, not Other', () => {
    const agents = execFileSync('git', ['ls-files', 'agents'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n')
      .filter((p) => /^agents\/(x3lius|records)-.*\.agent\.md$/.test(p) && !/x3lius-studio-editor/.test(p));
    expect(agents.length).toBeGreaterThan(15);
    for (const p of agents) expect(matchComponent(p, 'RECORDS'), p).not.toBe('RECORDS:other');
  });
});
