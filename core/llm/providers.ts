import Anthropic from '@anthropic-ai/sdk';
import { validateJson, type JsonSchema } from './json-schema.ts';

/**
 * Provider-agnostic LLM access (Phase 8, user decision): native Anthropic Messages through the
 * official SDK, plus OpenAI-compatible chat completions for Groq and OpenRouter. An agent picks its
 * provider in frontmatter `model`: `<provider>:<model>`, or a bare `claude-*` id for Anthropic (the
 * form the Phase 6B specialists already use). Every reply is parsed and validated against the
 * caller's schema here, whatever structured-output guarantee the provider claims.
 */

export type Provider = 'anthropic' | 'groq' | 'openrouter';

export const PROVIDERS: Readonly<Record<Provider, { readonly keyEnv: string; readonly baseUrl: string }>> = {
  // Pinned rather than read from ANTHROPIC_BASE_URL: hosted dev containers set that variable for
  // their own tooling, and following it would send this runner's traffic (and key) there.
  anthropic: { keyEnv: 'ANTHROPIC_API_KEY', baseUrl: 'https://api.anthropic.com' },
  groq: { keyEnv: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1' },
  openrouter: { keyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' },
};

export type ModelRef = { readonly provider: Provider; readonly model: string };

/**
 * @param ref - frontmatter `model`: `anthropic:<id>`, `groq:<id>`, `openrouter:<vendor>/<id>`, or bare `claude-*`
 * @returns provider + the model id sent on the wire
 * @throws Error for `none`, an unknown provider, or an empty model id
 */
export const parseModelRef = (ref: string): ModelRef => {
  if (/^claude-[a-z0-9.-]+$/.test(ref)) return { provider: 'anthropic', model: ref };
  const m = /^([a-z]+):(.+)$/.exec(ref);
  if (!m || !(m[1]! in PROVIDERS) || m[2]!.trim() === '') {
    throw new Error(`model ${JSON.stringify(ref)} is not <provider>:<model> with provider one of ${Object.keys(PROVIDERS).join(', ')} (or a bare claude-* id)`);
  }
  return { provider: m[1] as Provider, model: m[2]! };
};

export type LlmRequest = {
  readonly system: string;
  readonly user: string;
  /** The reply must be JSON satisfying this schema; `name` labels it for providers and errors. */
  readonly schema: { readonly name: string; readonly schema: JsonSchema };
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
};

export type LlmResponse = {
  readonly provider: Provider;
  /** Model id the provider reports it served (may differ from the requested alias). */
  readonly model: string;
  readonly text: string;
  readonly json: unknown;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly stopReason: string | null;
};

export type LlmClient = {
  readonly modelRef: ModelRef;
  readonly complete: (req: LlmRequest) => Promise<LlmResponse>;
};

type Raw = Omit<LlmResponse, 'json'>;
type Transport = (key: string, model: string, req: LlmRequest, fetchFn: typeof fetch | undefined) => Promise<Raw>;

// Non-streaming; 16k leaves room for adaptive thinking plus a structured reply this size.
const DEFAULT_MAX_TOKENS = 16_000;

const anthropicTransport: Transport = async (key, model, req, fetchFn) => {
  // maxRetries 0: dispatch has no retries (Phase 4D decision); the run's timeout bounds the call.
  const client = new Anthropic({ apiKey: key, authToken: null, baseURL: PROVIDERS.anthropic.baseUrl, maxRetries: 0, ...(fetchFn ? { fetch: fetchFn } : {}) });
  let msg: Anthropic.Message;
  try {
    msg = await client.messages.create(
      {
        model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: { format: { type: 'json_schema', schema: req.schema.schema as unknown as Record<string, unknown> } },
      },
      req.signal ? { signal: req.signal } : undefined,
    );
  } catch (e) {
    if (e instanceof Anthropic.APIError && e.status !== undefined) {
      const detail = (e.error as { error?: { message?: string } } | undefined)?.error?.message ?? e.message;
      throw new Error(`anthropic API error ${e.status}: ${detail}`);
    }
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw new Error(`anthropic refused (category ${msg.stop_details?.category ?? 'unknown'})`);
  if (msg.stop_reason !== 'end_turn') throw new Error(`anthropic reply incomplete (${msg.stop_reason})`);
  const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return { provider: 'anthropic', model: msg.model, text, usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens }, stopReason: msg.stop_reason };
};

type ChatCompletion = {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number | string };
};

const openAiCompatible = (provider: Exclude<Provider, 'anthropic'>): Transport => async (key, model, req, fetchFn) => {
  const res = await (fetchFn ?? fetch)(`${PROVIDERS[provider].baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      response_format: { type: 'json_schema', json_schema: { name: req.schema.name.replace(/[^A-Za-z0-9_-]/g, '_'), strict: true, schema: req.schema.schema } },
    }),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as ChatCompletion;
  // OpenRouter can report an upstream failure inside a 200.
  if (!res.ok || body.error) throw new Error(`${provider} API error ${body.error?.code ?? res.status}: ${body.error?.message ?? res.statusText}`);
  const choice = body.choices?.[0];
  const finish = choice?.finish_reason ?? null;
  if (finish === 'content_filter') throw new Error(`${provider} refused (content_filter)`);
  if (finish !== 'stop') throw new Error(`${provider} reply incomplete (${finish})`);
  return {
    provider, model: body.model ?? model, text: choice?.message?.content ?? '',
    usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 }, stopReason: finish,
  };
};

const TRANSPORTS: Readonly<Record<Provider, Transport>> = {
  anthropic: anthropicTransport,
  groq: openAiCompatible('groq'),
  openrouter: openAiCompatible('openrouter'),
};

/** Accepts bare JSON or JSON in one fenced block (some providers fence despite response_format). */
const parseReply = (provider: Provider, text: string): unknown => {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  try {
    return JSON.parse(fenced ? fenced[1]! : text);
  } catch {
    throw new Error(`${provider} reply is not JSON: ${JSON.stringify(text.slice(0, 200))}`);
  }
};

/**
 * An LLM client bound to one agent's model. The key is read at call time, so a run can do its
 * context work (and log it) before failing on a missing key.
 * @param options - `model` frontmatter ref; `agentName` for error messages; `env` holding keys; `fetch` override (tests)
 * @returns the bound client
 * @throws Error synchronously when `model` isn't a valid provider ref
 */
export const createLlmClient = (options: {
  readonly model: string;
  readonly agentName: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}): LlmClient => {
  const modelRef = parseModelRef(options.model);
  return {
    modelRef,
    complete: async (req) => {
      const { keyEnv } = PROVIDERS[modelRef.provider];
      const key = options.env[keyEnv];
      if (!key) throw new Error(`LLM runner unavailable: ${keyEnv} is not set (agent ${options.agentName} uses model ${options.model})`);
      const raw = await TRANSPORTS[modelRef.provider](key, modelRef.model, req, options.fetch);
      const json = parseReply(modelRef.provider, raw.text);
      const errors = validateJson(req.schema.schema, json);
      if (errors.length > 0) throw new Error(`${modelRef.provider} reply violates schema ${req.schema.name}: ${errors.join('; ')}`);
      return { ...raw, json };
    },
  };
};
