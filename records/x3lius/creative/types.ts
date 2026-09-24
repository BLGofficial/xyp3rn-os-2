import type { JsonSchema } from '../../../core/llm/json-schema.ts';
import type { AgentContext } from '../../../core/orchestrator/dispatch.ts';

/** Scoped rules below this count mark the artifact `sparse`: expect output close to generic. */
export const MIN_SCOPED_RULES = 3;
/** Voice rules live in Vocal DNA (Phase 7 handoff): every creative agent reads it besides its own module. */
export const VOICE_MODULE = 'x3lius-vocal-dna';
/**
 * The artist's claim namespace: canonical claim topics are `<slugified artist>.<topic>` (set by
 * the build-guide normalizer and by research claim topics). A namespace, not a voice.
 */
export const CLAIM_NAMESPACE = 'x3lius.';

type Source = { readonly id: string; readonly uri: string } | null;

/** One canonical item handed to the model, with the ref it must cite. */
export type ContextEntry =
  | { readonly kind: 'rule'; readonly ref: string; readonly module: string; readonly slug: string | null; readonly title: string; readonly text: string; readonly modelTag: string | null; readonly score: number; readonly why: string; readonly source: Source }
  | { readonly kind: 'claim'; readonly ref: string; readonly module: string; readonly slug: string; readonly title: string; readonly topic: string; readonly value: unknown; readonly modelScope: string; readonly source: Source };

/** What a spec's `prepare` derives from the run input before any context is pulled. */
export type Prepared = {
  /** The brief: the retrieval query and the artifact's `brief`. */
  readonly brief: string;
  /** Extra user-message sections (e.g. upstream artifacts), after the brief. */
  readonly userSections: readonly string[];
  /** Spec-private state carried to `admit` and `finalize`. */
  readonly state: unknown;
};

/** What one model call returns to a spec: the schema-valid reply, its usage, the model that served it. */
export type Completion = { readonly json: unknown; readonly usage: { readonly inputTokens: number; readonly outputTokens: number }; readonly model: string };

/**
 * One model call with the run's system prompt: the user message is the brief and the prepared
 * sections, then `extra`; `schema` defaults to the spec's model schema.
 */
export type ModelCall = (extra: readonly string[], schema?: { readonly id: string; readonly schema: JsonSchema }) => Promise<Completion>;

export type CreativeSpec = {
  /** Artifact schema id and schema: what write_artifact stores. */
  readonly schemaId: string;
  readonly schema: JsonSchema;
  /** What the model may write, when narrower than the artifact (default: the artifact schema). */
  readonly llmSchema?: { readonly id: string; readonly schema: JsonSchema };
  /** What to produce: the task's shape, never its style. */
  readonly task: string;
  /** Modules on the scoped context path (default: the sub-domain's own + Vocal DNA). */
  readonly modules?: readonly string[];
  /** Claim topic prefixes to read (default: the artist namespace). */
  readonly claimNamespaces?: readonly string[];
  /** Input → brief and extra sections (default: `{ request }` only). Throws on bad input. */
  readonly prepare?: (ctx: AgentContext, input: Record<string, unknown>) => Promise<Prepared>;
  /** Keeps an entry out of the prompt when it doesn't apply to this run (e.g. another model version). */
  readonly admit?: (entry: ContextEntry, prepared: Prepared) => boolean;
  /** How excluded entries are described in the knowledge report, e.g. "scoped to another Suno version". */
  readonly exclusionReason?: string;
  /**
   * Drives the model calls itself and returns the combined reply (default: one call). The reply's
   * rulesApplied still goes through the program's ref check. `log` writes a run-log line.
   */
  readonly generate?: (call: ModelCall, prepared: Prepared, log: (message: string) => Promise<void>) => Promise<Completion>;
  /** Model reply → artifact body, plus violations (default: the reply as-is). */
  readonly finalize?: (reply: Record<string, unknown>, prepared: Prepared, entries: readonly ContextEntry[]) => { readonly body: Record<string, unknown>; readonly violations: readonly string[] };
  /** Checks the schema subset can't express; returns violations. */
  readonly check?: (body: Record<string, unknown>) => string[];
  /**
   * JSON paths (of the final body) holding text Suno receives verbatim. A mixed-script word there
   * refuses the run; anywhere else it is written as a warning on the artifact (F22, user decision).
   * Default: none, for bodies Suno never sees directly.
   */
  readonly sunoTextPaths?: readonly RegExp[];
};
