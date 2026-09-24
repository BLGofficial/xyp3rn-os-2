import { describe, expect, it } from 'vitest';
import { AMBIGUITY_MARGIN, ROUTABLE_DOMAINS, ROUTING_LEXICON, routeRequest } from './router.ts';

describe('keyword router (deterministic, evidence attached, ambiguity flagged)', () => {
  it('routes to exactly the four F5 targets; CORE and KNOWLEDGE are infrastructure', () => {
    expect([...ROUTABLE_DOMAINS]).toEqual(['RESEARCH_INTELLIGENCE', 'RECORDS', 'TECH', 'GOVERNANCE']);
    expect(Object.keys(ROUTING_LEXICON).sort()).toEqual([...ROUTABLE_DOMAINS].sort());
  });

  it('routes the Phase 17 acceptance request to Research Intelligence', () => {
    const r = routeRequest('Research the best current method for controlling dark baritone vocals in Suno.');
    expect(r.status).toBe('routed');
    if (r.status !== 'routed') return;
    expect(r.domain).toBe('RESEARCH_INTELLIGENCE');
    expect(r.evidence.RESEARCH_INTELLIGENCE).toEqual(expect.arrayContaining(['research', 'best current method']));
  });

  it.each([
    ['Write a hook and two verses for the new X3LIUS track', 'RECORDS'],
    ['Add a stereo-width meter feature to the TRACE plugin backlog', 'TECH'],
    ['Is this sample cleared? Check the license and copyright before approval', 'GOVERNANCE'],
    ['Run an experiment comparing Suno v4.5 and v5 prompt adherence and collect evidence', 'RESEARCH_INTELLIGENCE'],
  ])('"%s" → %s', (request, domain) => {
    const r = routeRequest(request);
    expect(r).toMatchObject({ status: 'routed', domain });
  });

  it('flags a genuine two-domain request instead of guessing (rights: Records data vs Governance check, F3)', () => {
    const r = routeRequest('Check the rights on this track');
    expect(r.status).toBe('ambiguous');
    if (r.status !== 'ambiguous') return;
    expect([...r.candidates].sort()).toEqual(['GOVERNANCE', 'RECORDS']);
    expect(r.margin).toBeLessThan(AMBIGUITY_MARGIN);
  });

  it('returns unroutable (not a default domain) when nothing matches', () => {
    expect(routeRequest('hello there')).toMatchObject({ status: 'unroutable' });
  });

  it('matches whole words and simple plurals only', () => {
    expect(routeRequest('songs and verses').status).toBe('routed');
    expect(routeRequest('masterclass in oversongwriting').status).toBe('unroutable');
  });
});
