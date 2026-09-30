/**
 * Claude Code skills Mercury may start (server-side allowlist). Each wraps one OS entrypoint via
 * `pnpm ask`, so the work, traces and approvals stay in the OS. Files: .claude/skills/<name>/SKILL.md.
 */
export const SKILLS = [
  { name: 'xyp-research', label: 'Research', spoken: ['research'], command: "pnpm ask '$ARGUMENTS' --domain RESEARCH_INTELLIGENCE" },
  { name: 'xyp-music', label: 'Music', spoken: ['music'], command: "pnpm ask '$ARGUMENTS' --domain RECORDS" },
  { name: 'xyp-song-to-suno', label: 'Song to Suno', spoken: ['song to suno', 'song-to-suno'], command: "pnpm ask '$ARGUMENTS' --workflow song-to-suno" },
  { name: 'xyp-retrieve-summarize', label: 'Retrieve & summarize', spoken: ['retrieve and summarize', 'retrieve & summarize'], command: "pnpm ask '$ARGUMENTS' --workflow retrieve-and-summarize" },
] as const;

export type SkillName = (typeof SKILLS)[number]['name'];
const NAMES: readonly string[] = SKILLS.map(s => s.name);
export const isSkillName = (v: unknown): v is SkillName => typeof v === 'string' && NAMES.includes(v);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest spoken names first so "song to suno" wins over any shorter prefix.
const PATTERNS = SKILLS.flatMap(s => s.spoken.map(p => ({ skill: s.name, re: new RegExp(`^\\s*${escape(p)}\\s*[:,.\\-–—]?\\s+(\\S[\\s\\S]*)$`, 'i'), len: p.length })))
  .sort((a, b) => b.len - a.len);

/** Matches a spoken skill name at the very start of the text, followed by the text to act on. */
export const matchSkill = (text: string): { readonly skill: SkillName; readonly text: string } | null => {
  for (const p of PATTERNS) { const m = p.re.exec(text); if (m) return { skill: p.skill, text: m[1]!.trim() }; }
  return null;
};
