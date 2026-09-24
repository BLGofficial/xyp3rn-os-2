import { describe, expect, it } from 'vitest';
import { parseWorkflowSpec, topoOrder } from './spec.ts';

const AGENTS = new Set(['context-retriever', 'extractive-summarizer', 'health-check']);

const VALID = `
name: retrieve-and-summarize
description: Retrieve ranked context for a query, then summarize it.
input:
  required: [query]
steps:
  - id: retrieve
    agent: context-retriever
    input:
      query: { $from: input.query }
  - id: summarize
    agent: extractive-summarizer
    dependsOn: [retrieve]
    input:
      query: { $from: input.query }
      items: { $from: steps.retrieve.output.items }
output: { $from: steps.summarize.output }
`;

const errorsOf = (yaml: string) => {
  const r = parseWorkflowSpec(yaml, AGENTS);
  return r.ok ? [] : r.errors;
};

describe('parseWorkflowSpec (pure; every problem reported)', () => {
  it('accepts a valid two-step spec', () => {
    const r = parseWorkflowSpec(VALID, AGENTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.name).toBe('retrieve-and-summarize');
    expect(r.spec.steps.map((s) => s.id)).toEqual(['retrieve', 'summarize']);
  });

  it.each([
    ['unknown agent', VALID.replace('agent: extractive-summarizer', 'agent: ghost-writer'), /step summarize: unknown agent ghost-writer/],
    ['unknown dependency', VALID.replace('dependsOn: [retrieve]', 'dependsOn: [fetch]'), /step summarize: dependsOn unknown step fetch/],
    ['ref to a non-ancestor step', VALID.replace('dependsOn: [retrieve]', 'dependsOn: []'), /step summarize: \$from steps\.retrieve\.output\.items references retrieve, which is not an upstream dependency/],
    ['ref to an undeclared input', VALID.replace('query: { $from: input.query }\n  - id', 'query: { $from: input.topic }\n  - id'), /step retrieve: \$from input\.topic is not a declared input \(required: query\)/],
    ['malformed $from', VALID.replace('{ $from: steps.retrieve.output.items }', '{ $from: retrieve.items }'), /step summarize: \$from must start with "input\." or "steps\.<id>\.output": retrieve\.items/],
    ['duplicate step id', VALID.replace('id: summarize', 'id: retrieve'), /duplicate step id: retrieve/],
    ['unknown top-level key', `${VALID}\nretries: 3\n`, /unknown field: retries/],
    ['unknown step key', VALID.replace('    agent: context-retriever', '    agent: context-retriever\n    timeout: 5'), /step retrieve: unknown field: timeout/],
    ['no steps', 'name: empty\ndescription: x\nsteps: []\n', /steps must be a non-empty list/],
  ])('rejects %s', (_label, yaml, reason) => {
    expect(errorsOf(yaml).join('\n')).toMatch(reason);
  });

  it('rejects a cycle, naming the steps involved', () => {
    const cyclic = VALID.replace('    agent: context-retriever\n', '    agent: context-retriever\n    dependsOn: [summarize]\n');
    expect(errorsOf(cyclic).join('\n')).toMatch(/cycle detected: retrieve -> summarize -> retrieve|cycle detected: summarize -> retrieve -> summarize/);
  });

  it('reports several problems at once', () => {
    const bad = VALID.replace('agent: extractive-summarizer', 'agent: ghost-writer').replace('dependsOn: [retrieve]', 'dependsOn: [fetch]');
    expect(errorsOf(bad).length).toBeGreaterThanOrEqual(2);
  });
});

describe('topoOrder', () => {
  it('orders by dependencies, breaking ties by spec order (deterministic)', () => {
    const steps = [
      { id: 'c', dependsOn: ['a', 'b'] },
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'd', dependsOn: [] },
    ];
    expect(topoOrder(steps)).toEqual(['a', 'b', 'c', 'd']);
  });
});
