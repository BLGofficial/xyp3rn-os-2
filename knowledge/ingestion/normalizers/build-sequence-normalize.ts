import type { Domain } from '../../../core/contracts/taxonomy.ts';
import { slugify, type NormalizedDocument, type NormalizedModule, type NormalizedPrompt, type NormalizedRelation } from '../types.ts';
import type { ParsedBuildSequence, ParsedPrompt, ParsedSection } from './build-sequence.ts';

export const NORMALIZER_ID = 'xyp-build-sequence-v1';

/**
 * Which domain owns each phase's knowledge, per docs/ARCHITECTURE.md. Explicit and exhaustive:
 * a phase missing here is a normalization error, never a silent default.
 */
export const PHASE_DOMAINS: Readonly<Record<number, Domain>> = {
  0: 'CORE',
  1: 'KNOWLEDGE',
  2: 'KNOWLEDGE',
  3: 'KNOWLEDGE',
  4: 'CORE',
  5: 'CORE',
  6: 'RESEARCH_INTELLIGENCE',
  7: 'RECORDS',
  8: 'RECORDS',
  9: 'RECORDS',
  10: 'RECORDS',
  11: 'RECORDS',
  12: 'RECORDS',
  13: 'RECORDS',
  14: 'TECH',
  15: 'GOVERNANCE',
  16: 'CORE',
  17: 'CORE',
};

/**
 * Content tags: explicit (tag, pattern) table matched against a prompt body. Rule-based so the
 * same body always yields the same tags.
 */
export const KEYWORD_TAGS: ReadonlyArray<readonly [string, RegExp]> = [
  ['test-first', /test-first/i],
  ['no-mock-data', /no mock|no synthetic|not a mock|stubbed or mocked|no mocks/i],
  ['idempotency', /idempoten/i],
  ['grant-enforcement', /grant level|grant-level/i],
  ['human-approval', /human[- ]approval|human queue/i],
];

const META_PROMPT_FIELDS = ['role', 'context', 'task', 'constraints', 'output'] as const;
const PROTOCOL_FIELDS = ['body'] as const;

const promptSlug = (phase: number | undefined, p: ParsedPrompt): string => {
  if (p.kind === 'protocol') return slugify(p.key === 'how-to-use-this' ? p.title : `${p.key} ${p.title}`);
  return /[A-E]$/.test(p.key) ? slugify(`phase ${p.key} ${p.title}`) : `phase-${phase}-meta-prompt`;
};

const presentFields = (p: ParsedPrompt): string[] =>
  p.kind === 'protocol'
    ? p.body ? ['body'] : []
    : META_PROMPT_FIELDS.filter((f) => {
        const v = p[f];
        return Array.isArray(v) ? v.length > 0 : Boolean(v);
      });

/** Phase-level facts live on the module, once — prompts don't repeat them. */
const phaseDescription = (s: ParsedSection): string | null =>
  [
    s.goal && `Goal: ${s.goal}`,
    s.dependsOn && `Depends on: ${s.dependsOn}`,
    s.deliverables && `Deliverables: ${s.deliverables}`,
    s.intro,
  ]
    .filter(Boolean)
    .join('\n') || null;

/**
 * Maps a parsed build sequence onto canonical modules, prompts, tags and relations.
 * @param doc - parser output
 * @returns deterministic, DB-agnostic entries
 * @throws Error if a phase has no domain mapping
 */
export const normalizeBuildSequence = (doc: ParsedBuildSequence): NormalizedDocument => {
  const modules: NormalizedModule[] = [];
  const prompts: NormalizedPrompt[] = [];
  const relations: NormalizedRelation[] = [];
  const moduleByPhase = new Map<number, string>();

  for (const section of doc.sections) {
    const isPhase = section.kind === 'phase';
    const phase = section.phase;
    if (isPhase && PHASE_DOMAINS[phase!] === undefined) throw new Error(`no domain mapping for phase ${phase}`);
    const moduleSlug = isPhase ? slugify(`phase ${phase} ${section.title}`) : 'build-protocol';
    if (isPhase) moduleByPhase.set(phase!, moduleSlug);

    modules.push({
      slug: moduleSlug,
      title: isPhase ? `Phase ${phase} — ${section.title}` : section.title,
      description: phaseDescription(section),
      domain: isPhase ? PHASE_DOMAINS[phase!]! : 'CORE',
    });
    relations.push({ subject: { type: 'module', slug: moduleSlug }, predicate: 'derived_from', object: { type: 'source' } });

    let previous: string | undefined;
    for (const p of section.prompts) {
      const slug = promptSlug(phase, p);
      const tags = [
        p.kind,
        ...(isPhase ? [`phase-${phase}`] : []),
        ...(/[A-E]$/.test(p.key) ? ['sub-prompt'] : []),
        ...KEYWORD_TAGS.filter(([, re]) => re.test(p.body)).map(([t]) => t),
      ];
      const { body, title, kind, ...rest } = p;
      prompts.push({
        moduleSlug,
        slug,
        title: isPhase ? `Phase ${p.key} — ${title}` : title,
        body,
        structured: { kind, ...(isPhase ? { phase } : {}), ...rest },
        // Build-guide rules aren't tied to a model version; Suno/vocal rules (6B+) will be.
        modelTag: null,
        tags,
        completeness: {
          expected: p.kind === 'protocol' ? [...PROTOCOL_FIELDS] : [...META_PROMPT_FIELDS],
          present: presentFields(p),
        },
      });
      relations.push({ subject: { type: 'canonical_prompt', slug }, predicate: 'derived_from', object: { type: 'source' } });
      if (previous) {
        relations.push({ subject: { type: 'canonical_prompt', slug: previous }, predicate: 'precedes', object: { type: 'canonical_prompt', slug } });
      }
      previous = slug;
    }
  }

  // "Depends on: Phase 0 template, Phase 3 context engine." → module-level depends_on edges.
  for (const section of doc.sections) {
    if (section.kind !== 'phase' || !section.dependsOn) continue;
    const from = moduleByPhase.get(section.phase!)!;
    const targets = [...section.dependsOn.matchAll(/Phase (\d+)/g)].map((m) => Number(m[1]));
    for (const n of [...new Set(targets)]) {
      const to = moduleByPhase.get(n);
      if (to && to !== from) {
        relations.push({ subject: { type: 'module', slug: from }, predicate: 'depends_on', object: { type: 'module', slug: to } });
      }
    }
  }

  return {
    normalizer: NORMALIZER_ID,
    title: `${doc.title} — ${doc.subtitle}`,
    documentDate: doc.documentDate,
    metadata: { doc_label: doc.docLabel, document_date: doc.documentDate },
    modules,
    prompts,
    relations,
    coverage: { expected: [...doc.toc], present: [...doc.headingsFound] },
  };
};
