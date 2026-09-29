import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLoggedOut, isTransient, parseClaudeResult, runClaudeCli, type ClaudeRunner } from './claude-cli.ts';
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

/** A provider failure worth retrying (overload, rate limit, gateway): the request itself was fine. */
class TransientProviderError extends Error {}
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const providerError = (message: string, status: number | string | undefined): Error =>
  TRANSIENT_STATUS.has(Number(status)) ? new TransientProviderError(message) : new Error(message);

/** Default waits between attempts: free/shared routes (e.g. OpenRouter :free) overload often. */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [2_000, 6_000];
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
      throw providerError(`anthropic API error ${e.status}: ${detail}`, e.status);
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

const schemaInstruction = (req: LlmRequest): string =>
  `RESPONSE FORMAT\nReply with a single JSON object that validates against this JSON Schema (${req.schema.name}). No prose, no code fences.\n${JSON.stringify(req.schema.schema)}`;

const openAiCompatible = (provider: Exclude<Provider, 'anthropic'>): Transport => async (key, model, req, fetchFn) => {
  const res = await (fetchFn ?? fetch)(`${PROVIDERS[provider].baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      // Also stated in the prompt: some routes accept response_format but drop it (OpenRouter :free
      // variants), and a model that never sees the schema can't match it. Validation stays local.
      messages: [{ role: 'system', content: `${req.system}\n\n${schemaInstruction(req)}` }, { role: 'user', content: req.user }],
      response_format: { type: 'json_schema', json_schema: { name: req.schema.name.replace(/[^A-Za-z0-9_-]/g, '_'), strict: true, schema: req.schema.schema } },
    }),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as ChatCompletion;
  // OpenRouter can report an upstream failure inside a 200.
  if (!res.ok || body.error) {
    const status = body.error?.code ?? res.status;
    throw providerError(`${provider} API error ${status}: ${body.error?.message ?? res.statusText}`, status);
  }
  const choice = body.choices?.[0];
  const finish = choice?.finish_reason ?? null;
  if (finish === 'content_filter') throw new Error(`${provider} refused (content_filter)`);
  // "error": the upstream provider abandoned the generation (seen live after 137s; the same request
  // then completed), so it is retried like a 5xx. "length" is the request's own limit: never retried.
  if (finish === 'error') throw new TransientProviderError(`${provider} reply incomplete (error)`);
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

/**
 * LLM_ENGINE=claude-code: Anthropic agents run through the owner's logged-in Claude Code CLI
 * (subscription) instead of the API. No Claude Code tools: the OS still runs every agent tool.
 * cwd is a neutral directory so project hooks and plugins cannot touch the JSON reply.
 */
const ENGINE_FLAGS = ['-p', '--output-format', 'json', '--tools', '', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands'] as const;
const engineDir = (): string => { const d = join(tmpdir(), 'xyp-claude-engine'); mkdirSync(d, { recursive: true }); return d; };

const claudeCodeTransport = (run: ClaudeRunner): Transport => async (_key, model, req) => {
  // System prompts can exceed Windows' command-line limit, so they go through a file.
  const dir = mkdtempSync(join(tmpdir(), 'xyp-sys-'));
  const file = join(dir, 'system.txt');
  writeFileSync(file, `${req.system}\n\n${schemaInstruction(req)}`);
  try {
    let out;
    try {
      out = await run([...ENGINE_FLAGS, '--model', model, '--system-prompt-file', file], req.user, { cwd: engineDir(), ...(req.signal ? { signal: req.signal } : {}) });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('claude CLI not found on PATH (install Claude Code or set CLAUDE_BIN)');
      throw e;
    }
    const r = parseClaudeResult(out.stdout);
    if (!r) throw new Error(`claude-code exited ${out.code} without a result`);
    if (r.isError) {
      if (isLoggedOut(r)) throw new Error('claude CLI is not logged in; run `claude` once and sign in');
      if (isTransient(r)) throw new TransientProviderError(`claude-code transient error (${r.apiErrorStatus ?? r.subtype})`);
      throw new Error(`claude-code error (${r.apiErrorStatus ?? r.subtype})`);
    }
    return { provider: 'anthropic', model: r.model ?? model, text: r.text, usage: r.usage, stopReason: r.stopReason };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error(String(signal.reason)));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error(String(signal.reason))); }, { once: true });
  });

/**
 * Retries a transport call on transient provider errors only. Safe because a completion changes
 * no external state (unlike Execution agents, which stay retry-free per Phase 4D). Bounded by
 * `delays` and by the run's abort signal (dispatch timeout).
 */
const withRetries = async (call: () => Promise<Raw>, delays: readonly number[], signal?: AbortSignal): Promise<Raw> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (!(e instanceof TransientProviderError)) throw e;
      if (attempt >= delays.length) throw new Error(attempt > 0 ? `${e.message} (after ${attempt + 1} attempts)` : e.message);
      await pause(delays[attempt]!, signal);
    }
  }
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
  /** Waits before each retry of a transient provider error; its length is the retry count (default 2 retries). */
  readonly retryDelaysMs?: readonly number[];
  /** Claude CLI runner override (tests); used only when env.LLM_ENGINE is `claude-code`. */
  readonly runClaude?: ClaudeRunner;
}): LlmClient => {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const modelRef = parseModelRef(options.model);
  return {
    modelRef,
    complete: async (req) => {
      const viaCli = modelRef.provider === 'anthropic' && options.env.LLM_ENGINE === 'claude-code';
      const { keyEnv } = PROVIDERS[modelRef.provider];
      const key = options.env[keyEnv] ?? '';
      if (!viaCli && !key) throw new Error(`LLM runner unavailable: ${keyEnv} is not set (agent ${options.agentName} uses model ${options.model})`);
      const transport = viaCli ? claudeCodeTransport(options.runClaude ?? runClaudeCli) : TRANSPORTS[modelRef.provider];
      const raw = await withRetries(() => transport(key, modelRef.model, req, options.fetch), delays, req.signal);
      const json = parseReply(modelRef.provider, raw.text);
      const errors = validateJson(req.schema.schema, json);
      if (errors.length > 0) throw new Error(`${modelRef.provider} reply violates schema ${req.schema.name}: ${errors.join('; ')}`);
      return { ...raw, json };
    },
  };
};
