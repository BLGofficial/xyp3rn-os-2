import { kindName } from '../creative/lyrics.ts';
import { SECTION_KINDS } from '../creative/schemas.ts';

/**
 * Meta-tag sets (AOS-03, S2): the section tags Suno sees, as a versioned record. F21 kept the tags in
 * code (`sectionLabels`) because the model wrote section ids as tags live; they are still never the
 * model's. The code labels are now the default set's first version, and the owner's edits (labels,
 * numbering, cues) are its next versions.
 */

export type TagSection = { readonly kind: string; readonly label: string; readonly numbered: boolean; readonly cues: readonly string[] };
export type TagSet = { readonly name: string; readonly sections: readonly TagSection[]; readonly notes: readonly string[] };
/** A sung section as a lyric version holds it (x3lius.lyrics/v2 `sections`). */
export type SungSection = { readonly kind: string; readonly bars: readonly { readonly text: string }[] };

export const DEFAULT_TAG_SET_NAME = 'Default (code labels)';

/**
 * The code labels as a tag set: every section kind, named as `sectionLabels` names it, verses
 * numbered in song order, no cues. Rendering with it gives exactly the Phase 9 formula's lyrics.
 * @returns the default set
 */
export const defaultTagSet = (): TagSet => ({
  name: DEFAULT_TAG_SET_NAME,
  sections: SECTION_KINDS.map((kind) => ({ kind, label: kindName(kind), numbered: kind === 'verse', cues: [] })),
  notes: ['Seeded from the code labels (sectionLabels, F21): verses numbered in song order, every other kind by its name, no cues.'],
});

// A bracket would end or open a tag early, and a line break would split one: either garbles what Suno reads.
const TAG_TEXT = /^[^[\]\r\n]+$/;

/**
 * What makes a tag set unreadable to Suno or ambiguous to render. The schema checks the shape and
 * the kinds; this checks the text.
 * @param set - a tag set
 * @returns every problem, empty when there is none
 */
export const tagSetProblems = (set: TagSet): string[] => {
  const problems: string[] = [];
  if (set.name.trim() === '') problems.push('the name is blank');
  if (set.sections.length === 0) problems.push('a tag set covers at least one section kind');
  const seen = new Set<string>();
  for (const s of set.sections) {
    if (seen.has(s.kind)) problems.push(`${s.kind} is tagged twice; one entry per kind`);
    seen.add(s.kind);
    if (s.label.trim() === '') problems.push(`the ${s.kind} label is blank`);
    else if (!TAG_TEXT.test(s.label)) problems.push(`the ${s.kind} label "${s.label}" can't contain [ or ] or a line break`);
    for (const c of s.cues) {
      if (c.trim() === '') problems.push(`a ${s.kind} cue is blank`);
      else if (!TAG_TEXT.test(c)) problems.push(`the ${s.kind} cue "${c}" can't contain [ or ] or a line break`);
    }
  }
  return problems;
};

/**
 * Renders sung sections into Suno's lyrics field with a tag set: per section `[label]` (or
 * `[label n]` when numbered, n counting that kind in song order), then one `[cue]` line per cue,
 * then the bars; sections separated by a blank line. The words are the lyric version's.
 * @param sections - sung sections in song order
 * @param set - the tag set
 * @returns the lyrics text
 * @throws when a section's kind has no tag in the set
 */
export const renderWithTags = (sections: readonly SungSection[], set: TagSet): string => {
  const byKind = new Map(set.sections.map((s) => [s.kind, s]));
  const missing = [...new Set(sections.map((s) => s.kind))].filter((k) => !byKind.has(k));
  if (missing.length > 0) throw new Error(`tag set "${set.name}" has no tag for ${missing.join(', ')}`);
  const count = new Map<string, number>();
  return sections.map((s) => {
    const t = byKind.get(s.kind)!;
    const n = (count.get(s.kind) ?? 0) + 1;
    count.set(s.kind, n);
    const head = [`[${t.numbered ? `${t.label} ${n}` : t.label}]`, ...t.cues.map((c) => `[${c}]`)].join('\n');
    return `${head}\n${s.bars.map((b) => b.text).join('\n')}`;
  }).join('\n\n');
};
