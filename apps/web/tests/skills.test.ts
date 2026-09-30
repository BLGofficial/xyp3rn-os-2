import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSkillName, matchSkill, SKILLS } from '../lib/skills';

const ROOT = join(import.meta.dirname, '../../..');

describe('skill files match the allowlist', () => {
  it.each(SKILLS.map(s => [s.name, s] as const))('%s has a SKILL.md with its name and exact command', (name, s) => {
    const md = readFileSync(join(ROOT, '.claude/skills', name, 'SKILL.md'), 'utf8');
    expect(md).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
    expect(md).toContain(s.command);
  });
});

describe('matchSkill: spoken names at the start only', () => {
  it.each([
    ['research dark baritone vocals in Suno', 'xyp-research', 'dark baritone vocals in Suno'],
    ['Research: dark vocals', 'xyp-research', 'dark vocals'],
    ['MUSIC, write a verse', 'xyp-music', 'write a verse'],
    ['song to suno the new track', 'xyp-song-to-suno', 'the new track'],
    ['song-to-suno. the new track', 'xyp-song-to-suno', 'the new track'],
    ['retrieve and summarize vocal notes', 'xyp-retrieve-summarize', 'vocal notes'],
  ])('%s', (text, skill, rest) => expect(matchSkill(text)).toEqual({ skill, text: rest }));
  it.each(['Write a hook about research', 'researching is fun', 'musical ideas please', 'research'])('no match: %s', (text) => expect(matchSkill(text)).toBeNull());
  it('allowlist', () => {
    expect(isSkillName('xyp-music')).toBe(true);
    expect(isSkillName('xyp-music/../x')).toBe(false);
    expect(isSkillName(7)).toBe(false);
  });
});
