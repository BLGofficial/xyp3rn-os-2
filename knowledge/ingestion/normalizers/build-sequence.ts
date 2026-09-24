/**
 * Rule-based parser for the XYP3RN Agentic OS Build Sequence PDF (user decision: no LLM
 * extraction — same bytes must always yield the same entries).
 *
 * Format-specific by design. The document's own table of contents is the heading oracle:
 * a line is a section heading only if it exactly equals a TOC entry, so prompt text that
 * mentions "PHASE 4 — ..." mid-sentence can never be mistaken for a heading.
 */

export type ParsedPrompt = {
  /** '0'..'17' for single-prompt phases, '4A' etc. for sub-prompts, or a protocol key. */
  readonly key: string;
  readonly title: string;
  readonly kind: 'meta-prompt' | 'protocol';
  /** The paste-ready text: from "You are ..." to the end of OUTPUT (verbatim line breaks). */
  readonly body: string;
  readonly role?: string;
  /** Lines between the role line and CONTEXT (e.g. 16A's reference note). */
  readonly preamble?: string;
  readonly context?: string;
  readonly task: readonly string[];
  readonly constraints: readonly string[];
  readonly output?: string;
  /** Sub-prompt "Deliverables:" line (6A–6D). */
  readonly deliverables?: string;
  /** 6B's proposed specialist roster. */
  readonly roster?: ReadonlyArray<{ readonly n: number; readonly name: string }>;
};

export type ParsedSection = {
  readonly kind: 'phase' | 'protocol';
  readonly phase?: number;
  readonly title: string;
  readonly goal?: string;
  readonly dependsOn?: string;
  readonly deliverables?: string;
  /** Prose that isn't Goal/Depends/Deliverables (e.g. "Split into five sub-prompts ..."). */
  readonly intro?: string;
  readonly prompts: readonly ParsedPrompt[];
};

export type ParsedBuildSequence = {
  readonly title: string;
  readonly subtitle: string;
  readonly docLabel: string;
  /** ISO date (first of the stated month), or null if the header states none. */
  readonly documentDate: string | null;
  readonly toc: readonly string[];
  /** TOC entries actually found as headings in the body. */
  readonly headingsFound: readonly string[];
  readonly sections: readonly ParsedSection[];
};

const TITLE = 'XYP3RN AGENTIC OS';
const SUBTITLE_MARK = 'Build Sequence — Meta-Prompt Library';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TOC_LINE = /^(.+?)(?:\s*\.){5,}\s*(\d+)$/;
const PHASE_HEADING = /^PHASE (\d+) — (.+)$/;
const APPENDIX_HEADING = /^Appendix ([A-Z]) — (.+)$/;
const BLOCK_HEADER = /^(CONTEXT|TASK|CONSTRAINTS|OUTPUT)(?:\s|$)/;
// Prose lines wrap near ~100 chars; a line ending in . or : well short of that closes its paragraph.
const PARAGRAPH_END_MAX = 85;

/**
 * Checks whether extracted pages are this document.
 * @param pages - per-page text
 * @returns true when page 1 opens with the build-sequence title block
 */
export const detectBuildSequence = (pages: readonly string[]): boolean => {
  const first = (pages[0] ?? '').split('\n').map((l) => l.trim());
  return first[0] === TITLE && first.some((l) => l.startsWith(SUBTITLE_MARK));
};

/** Drops each page's trailing page-number footer, then flattens to one line list. */
const toLines = (pages: readonly string[]): string[] =>
  pages.flatMap((page) => {
    const lines = page.split('\n').map((l) => l.trimEnd());
    while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
    if (lines.length > 0 && /^\d+$/.test(lines.at(-1)!.trim())) lines.pop();
    return lines;
  });

/**
 * Joins wrapped prose lines. A hyphen after a lowercase letter at a line end is a syllable
 * break ("ex-" + "ists"); any other trailing hyphen is a real compound ("RBAC-" + "driven").
 * Known limit: a lowercase compound split exactly at its hyphen would be merged. None occur in
 * this document (checked: three line-end hyphens total).
 */
const joinProse = (lines: readonly string[]): string =>
  lines.reduce((acc, line) => {
    const l = line.trim();
    if (acc === '') return l;
    if (/[a-z]-$/.test(acc) && /^[a-z]/.test(l)) return acc.slice(0, -1) + l;
    if (/-$/.test(acc)) return acc + l;
    return `${acc} ${l}`;
  }, '');

const paragraphs = (lines: readonly string[]): string[][] => {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    cur.push(line);
    const t = line.trim();
    if (/[.:]$/.test(t) && t.length < PARAGRAPH_END_MAX) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
};

/** Pulls "Goal: … Depends on: … Deliverables: …" out of prose; the rest becomes intro. */
const parseProse = (lines: readonly string[]) => {
  let goal: string | undefined;
  let dependsOn: string | undefined;
  let deliverables: string | undefined;
  const rest: string[] = [];
  for (const para of paragraphs(lines).map(joinProse)) {
    if (!/^(Goal|Deliverables):/.test(para)) {
      rest.push(para);
      continue;
    }
    goal = /Goal:\s*(.*?)\s*(?=Depends on:|Deliverables:|$)/.exec(para)?.[1] || goal;
    dependsOn = /Depends on:\s*(.*?)\s*(?=Deliverables:|$)/.exec(para)?.[1] || dependsOn;
    deliverables = /Deliverables:\s*(.*)$/.exec(para)?.[1] || deliverables;
  }
  return { goal, dependsOn, deliverables, intro: rest.length > 0 ? rest.join('\n\n') : undefined };
};

/** Splits "1. a 11. b" two-column table lines into roster entries. */
const parseRoster = (lines: readonly string[]) => {
  const entries: { n: number; name: string }[] = [];
  for (const line of lines) {
    if (!/^\d+\.\s/.test(line.trim())) continue;
    for (const m of line.trim().matchAll(/(\d+)\.\s+(.+?)(?=\s+\d+\.\s|$)/g)) {
      entries.push({ n: Number(m[1]), name: m[2]!.trim() });
    }
  }
  return entries.length > 0 ? entries.sort((a, b) => a.n - b.n) : undefined;
};

/** Numbered items ("1. …") or dash items ("- …"), continuation lines folded in. */
const items = (lines: readonly string[], marker: RegExp): string[] => {
  const out: string[] = [];
  const lead: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === '') continue;
    if (marker.test(t)) out.push(t.replace(marker, ''));
    else if (out.length === 0) lead.push(t);
    else out[out.length - 1] += ` ${t}`;
  }
  // Text before the first marker (e.g. 6B's "For each of the 20 roles …") is kept as item 0.
  if (lead.length > 0) out.unshift(lead.join(' '));
  return out;
};

const parsePromptBody = (lines: readonly string[]) => {
  const blocks = new Map<string, string[]>();
  const pre: string[] = [];
  let current: string | undefined;
  for (const line of lines) {
    const h = BLOCK_HEADER.exec(line.trim());
    if (h) {
      current = h[1]!;
      // Phase 0 carries text on its header line ("CONTEXT — target architecture …"): keep it.
      const inline = line.trim().slice(current.length).replace(/^\s*—\s*/, '').trim();
      blocks.set(current, inline ? [inline] : []);
    } else if (current) {
      blocks.get(current)!.push(line);
    } else {
      pre.push(line);
    }
  }
  const preText = joinProse(pre);
  const role = /^You are .*?\.(?=\s|$)/.exec(preText)?.[0];
  const text = (k: string) => {
    const b = blocks.get(k);
    return b && b.join('\n').trim() !== '' ? b.join('\n').trim() : undefined;
  };
  return {
    role,
    preamble: role ? preText.slice(role.length).trim() || undefined : undefined,
    context: text('CONTEXT'),
    task: items(blocks.get('TASK') ?? [], /^\d+\.\s+/),
    constraints: items(blocks.get('CONSTRAINTS') ?? [], /^-\s+/),
    output: text('OUTPUT') ? joinProse(text('OUTPUT')!.split('\n')) : undefined,
  };
};

/**
 * A span of lines holding pre-prompt prose followed by a "You are …" prompt. Only sub-prompts
 * own their pre-prompt Deliverables; a single-prompt phase's prose belongs to the phase.
 */
const parsePromptSpan = (key: string, title: string, span: readonly string[], isSubPrompt: boolean) => {
  const start = span.findIndex((l) => l.trim().startsWith('You are '));
  const prose = start === -1 ? span : span.slice(0, start);
  const bodyLines = start === -1 ? [] : span.slice(start);
  const { deliverables } = parseProse(prose);
  const roster = parseRoster(prose);
  const prompt: ParsedPrompt = stripUndefined({
    key,
    title,
    kind: 'meta-prompt',
    body: bodyLines.join('\n').trim(),
    ...parsePromptBody(bodyLines),
    ...(isSubPrompt && deliverables ? { deliverables } : {}),
    ...(roster ? { roster } : {}),
  });
  return { prompt, prose };
};

/** Keys whose value may be undefined become optional-and-absent (exactOptionalPropertyTypes). */
type Compact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

const stripUndefined = <const T extends object>(o: T): Compact<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Compact<T>;

/**
 * Parses the build sequence into sections and prompts.
 * @param pages - per-page text from extractPdfPages()
 * @returns header, TOC, and one section per phase plus the build protocol
 * @throws Error if the document isn't the build sequence
 */
export const parseBuildSequence = (pages: readonly string[]): ParsedBuildSequence => {
  if (!detectBuildSequence(pages)) throw new Error('not an XYP3RN build-sequence document');
  const lines = toLines(pages);

  const header = lines.slice(0, 6).map((l) => l.trim());
  const dateLine = header.find((l) => new RegExp(`^(${MONTHS.join('|')}) \\d{4}$`).test(l));
  const documentDate = dateLine
    ? `${dateLine.split(' ')[1]}-${String(MONTHS.indexOf(dateLine.split(' ')[0]!) + 1).padStart(2, '0')}-01`
    : null;

  const contentsAt = lines.findIndex((l) => l.trim() === 'Contents');
  const toc: string[] = [];
  let i = contentsAt + 1;
  for (; i < lines.length; i++) {
    const m = TOC_LINE.exec(lines[i]!.trim());
    if (!m) break;
    toc.push(m[1]!.trim());
  }
  const body = lines.slice(i);

  // Heading positions: exact full-line match against the TOC, first occurrence after the TOC.
  const headingAt = new Map<number, string>();
  for (const entry of toc) {
    const at = body.findIndex((l) => l.trim() === entry);
    if (at !== -1) headingAt.set(at, entry);
  }
  const positions = [...headingAt.keys()].sort((a, b) => a - b);
  const spanOf = (at: number) => body.slice(at + 1, positions.find((p) => p > at) ?? body.length);

  const sections: ParsedSection[] = [];
  const protocolPrompts: ParsedPrompt[] = [];
  let protocolDescription: string | undefined;

  for (const at of positions) {
    const heading = headingAt.get(at)!;
    const span = spanOf(at);
    const phase = PHASE_HEADING.exec(heading);
    const appendix = APPENDIX_HEADING.exec(heading);

    if (!phase) {
      const key = appendix ? `appendix-${appendix[1]!.toLowerCase()}` : 'how-to-use-this';
      const text = span.join('\n').trim();
      if (!appendix) protocolDescription = /^.*?\.(?=\s|$)/.exec(joinProse(span.slice(0, 2)))?.[0];
      protocolPrompts.push({
        key,
        title: appendix ? appendix[2]! : heading,
        kind: 'protocol',
        body: text,
        task: [],
        constraints: [],
      });
      continue;
    }

    const n = Number(phase[1]);
    const subHeading = new RegExp(`^${n}([A-E]) — (.+)$`);
    const subAt = span.map((l, j) => (subHeading.test(l.trim()) ? j : -1)).filter((j) => j !== -1);
    const prompts: ParsedPrompt[] = [];
    let phaseProse: readonly string[];

    if (subAt.length === 0) {
      const { prompt, prose } = parsePromptSpan(String(n), phase[2]!, span, false);
      prompts.push(prompt);
      phaseProse = prose;
    } else {
      phaseProse = span.slice(0, subAt[0]);
      subAt.forEach((s, k) => {
        const m = subHeading.exec(span[s]!.trim())!;
        const sub = span.slice(s + 1, subAt[k + 1] ?? span.length);
        prompts.push(parsePromptSpan(`${n}${m[1]}`, m[2]!, sub, true).prompt);
      });
    }

    sections.push(stripUndefined({ kind: 'phase', phase: n, title: phase[2]!, ...parseProse(phaseProse), prompts }));
  }

  sections.push(
    stripUndefined({ kind: 'protocol', title: 'Build protocol', intro: protocolDescription, prompts: protocolPrompts }),
  );

  return {
    title: header[0]!,
    subtitle: header[1]!,
    docLabel: header[2]!,
    documentDate,
    toc,
    headingsFound: toc.filter((t) => [...headingAt.values()].includes(t)),
    sections,
  };
};
