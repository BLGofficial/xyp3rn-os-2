import type { ClaimBundle, ClaimItem } from '../../../core/context-engine/context-engine.ts';
import type { AgentContext } from '../../../core/orchestrator/dispatch.ts';
import type { RvcSettings } from '../../../knowledge/ingestion/normalizers/vocal-dna.ts';
import { CLAIM_NAMESPACE } from '../creative/types.ts';

/**
 * The one reader of the X3LIUS Vocal DNA (Phase 10). Every consumer that needs the vocal
 * signature as data — the RVC post-processing step, the Vocal DNA agent — reads it here, from
 * the current canonical row's claims (retrieve_claims, capability context.read). The creative
 * agents, the Suno formula included, receive the same claims through their generic claim read.
 * Nobody keeps a copy, so a new version reaches every reader at once.
 */

export const VOCAL_DNA_FILE = 'records/x3lius/vocal-dna.yaml';
const PREFIX = `${CLAIM_NAMESPACE}vocal.`;
const ATTRIBUTES = ['tone', 'register', 'delivery', 'adlibs'] as const;

export type VocalDna = {
  /** The canonical row every value came from. */
  readonly source: { readonly canonicalPromptId: string; readonly slug: string; readonly version: number; readonly ref: string; readonly uri: string | null };
  readonly tone: readonly string[];
  readonly register: readonly string[];
  readonly delivery: readonly string[];
  readonly adlibs: readonly string[];
  readonly rvc: RvcSettings;
};

/**
 * Reads the current Vocal DNA.
 * @param ctx - agent context (the agent must declare retrieve_claims)
 * @returns the Vocal DNA and the canonical row it came from
 * @throws Error when no Vocal DNA is admitted, when its claims span more than one row, or when an attribute is missing
 */
export const readVocalDna = async (ctx: AgentContext): Promise<VocalDna> => {
  const bundle = (await ctx.useTool('retrieve_claims', { topicPrefix: PREFIX })) as ClaimBundle;
  if (bundle.items.length === 0) {
    throw new Error(`no canonical Vocal DNA: admit ${VOCAL_DNA_FILE} (pnpm ingest --file ${VOCAL_DNA_FILE} --origin first_party)`);
  }
  // One row, by construction of the normalizer; anything else means two sources of truth.
  const rows = [...new Set(bundle.items.map((i) => i.ref.id))];
  if (rows.length !== 1) throw new Error(`Vocal DNA claims come from ${rows.length} canonical rows (${rows.join(', ')}); expected exactly one`);
  const by = new Map<string, ClaimItem>(bundle.items.map((i) => [i.topic.slice(PREFIX.length), i]));
  const need = (key: string): unknown => {
    const item = by.get(key);
    if (!item) throw new Error(`Vocal DNA row ${rows[0]} has no ${PREFIX}${key} claim`);
    return item.value;
  };
  const first = bundle.items[0]!;
  return {
    source: { canonicalPromptId: first.ref.id, slug: first.slug, version: first.version, ref: `canonical_prompts:${first.ref.id}`, uri: first.source?.uri ?? null },
    ...(Object.fromEntries(ATTRIBUTES.map((a) => [a, need(a) as string[]])) as Record<(typeof ATTRIBUTES)[number], string[]>),
    rvc: need('rvc') as RvcSettings,
  };
};
