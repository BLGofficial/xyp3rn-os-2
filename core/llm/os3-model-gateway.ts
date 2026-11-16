import type { SqliteRuntimeDb } from '../sqlite/client.ts';
import type { JsonSchema } from './json-schema.ts';
import {
  createLlmClient,
  parseModelRef,
  PROVIDERS,
  type LlmRequest,
  type LlmResponse,
  type ModelRef,
  type Provider,
} from './providers.ts';

export type ModelGatewayErrorCode =
  | 'INVALID_MODEL_REF'
  | 'AUTH_MISSING'
  | 'RATE_LIMITED'
  | 'PROVIDER_TRANSIENT'
  | 'PROVIDER_PERMANENT'
  | 'SCHEMA_VIOLATION'
  | 'TIMEOUT';

export class Os3ModelGatewayError extends Error {
  readonly code: ModelGatewayErrorCode;
  readonly provider: Provider | null;
  readonly model: string;

  constructor(options: {
    readonly code: ModelGatewayErrorCode;
    readonly provider: Provider | null;
    readonly model: string;
    readonly message: string;
  }) {
    super(options.message);
    this.name = 'Os3ModelGatewayError';
    this.code = options.code;
    this.provider = options.provider;
    this.model = options.model;
  }
}

export type ProviderRateLimitConfig = {
  readonly maxRequestsPerWindow: number;
  readonly windowMs: number;
};

export type ModelRequestConfig = {
  readonly system: string;
  readonly user: string;
  readonly schema: { readonly name: string; readonly schema: JsonSchema };
  readonly maxTokens?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
};

export type ModelUsageSummary = {
  readonly totalRequests: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalLatencyMs: number;
  readonly byProvider: Readonly<
    Record<
      Provider,
      {
        readonly requests: number;
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly errors: number;
      }
    >
  >;
  readonly byModel: Readonly<
    Record<
      string,
      {
        readonly requests: number;
        readonly inputTokens: number;
        readonly outputTokens: number;
      }
    >
  >;
};

export type CustomProviderAdapter = (
  modelRef: ModelRef,
  config: ModelRequestConfig,
) => Promise<{
  readonly text: string;
  readonly json: unknown;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly stopReason?: string | null | undefined;
}>;

/**
 * OS 3.0 Model Gateway separating Provider, Model, Request Configuration,
 * Authentication, Rate Limiting, Usage Tracking, and Error Handling.
 * Never hardcodes model IDs: the model is always supplied from the Agent's definition.
 */
export class Os3ModelGateway {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #db: SqliteRuntimeDb | null;
  readonly #fetchFn: typeof fetch | undefined;
  readonly #rateLimits: Readonly<Record<Provider, ProviderRateLimitConfig>>;
  readonly #requestTimestamps: Record<Provider, number[]> = {
    anthropic: [],
    groq: [],
    openrouter: [],
  };
  readonly #customAdapters = new Map<Provider, CustomProviderAdapter>();

  #totalRequests = 0;
  #totalInputTokens = 0;
  #totalOutputTokens = 0;
  #totalLatencyMs = 0;

  readonly #providerStats: Record<
    Provider,
    { requests: number; inputTokens: number; outputTokens: number; errors: number }
  > = {
    anthropic: { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0 },
    groq: { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0 },
    openrouter: { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0 },
  };

  readonly #modelStats = new Map<
    string,
    { requests: number; inputTokens: number; outputTokens: number }
  >();

  constructor(options: {
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
    readonly db?: SqliteRuntimeDb | null | undefined;
    readonly fetch?: typeof fetch | undefined;
    readonly rateLimits?: Partial<Record<Provider, ProviderRateLimitConfig>> | undefined;
    readonly customAdapters?: Partial<Record<Provider, CustomProviderAdapter>> | undefined;
  } = {}) {
    this.#env = options.env ?? process.env;
    this.#db = options.db ?? null;
    this.#fetchFn = options.fetch;
    const defaultLimit: ProviderRateLimitConfig = { maxRequestsPerWindow: 60, windowMs: 60_000 };
    this.#rateLimits = {
      anthropic: options.rateLimits?.anthropic ?? defaultLimit,
      groq: options.rateLimits?.groq ?? defaultLimit,
      openrouter: options.rateLimits?.openrouter ?? defaultLimit,
    };

    if (options.customAdapters) {
      for (const [prov, adapter] of Object.entries(options.customAdapters) as [
        Provider,
        CustomProviderAdapter | undefined,
      ][]) {
        if (adapter) this.#customAdapters.set(prov, adapter);
      }
    }
  }

  /**
   * Resolves `<provider>:<model>` without hardcoding any model ID.
   */
  resolveModel(modelString: string): ModelRef {
    try {
      return parseModelRef(modelString);
    } catch (err) {
      throw new Os3ModelGatewayError({
        code: 'INVALID_MODEL_REF',
        provider: null,
        model: modelString,
        message: (err as Error).message,
      });
    }
  }

  /**
   * Verifies authentication credentials for the resolved provider.
   */
  verifyAuthentication(provider: Provider, modelString: string, agentName: string): void {
    if (this.#customAdapters.has(provider)) return;
    const viaCli = provider === 'anthropic' && this.#env.LLM_ENGINE === 'claude-code';
    if (viaCli) return;

    const { keyEnv } = PROVIDERS[provider];
    const key = this.#env[keyEnv]?.trim();
    if (!key) {
      throw new Os3ModelGatewayError({
        code: 'AUTH_MISSING',
        provider,
        model: modelString,
        message: `Authentication missing for provider "${provider}": ${keyEnv} is not set (requested by agent "${agentName}")`,
      });
    }
  }

  /**
   * Enforces per-provider sliding-window rate limits.
   */
  #checkAndRecordRateLimit(provider: Provider, modelString: string): void {
    const now = Date.now();
    const cfg = this.#rateLimits[provider];
    const windowStart = now - cfg.windowMs;
    const timestamps = this.#requestTimestamps[provider].filter((t) => t > windowStart);
    this.#requestTimestamps[provider] = timestamps;

    if (timestamps.length >= cfg.maxRequestsPerWindow) {
      this.#providerStats[provider].errors += 1;
      throw new Os3ModelGatewayError({
        code: 'RATE_LIMITED',
        provider,
        model: modelString,
        message: `Rate limit exceeded for provider "${provider}": max ${cfg.maxRequestsPerWindow} requests per ${cfg.windowMs}ms`,
      });
    }

    timestamps.push(now);
  }

  async complete(options: {
    readonly agentName: string;
    readonly model: string;
    readonly request: ModelRequestConfig;
  }): Promise<LlmResponse> {
    const startMs = Date.now();
    const modelRef = this.resolveModel(options.model);
    this.verifyAuthentication(modelRef.provider, options.model, options.agentName);
    this.#checkAndRecordRateLimit(modelRef.provider, options.model);

    try {
      let response: LlmResponse;
      const custom = this.#customAdapters.get(modelRef.provider);
      if (custom) {
        const out = await custom(modelRef, options.request);
        response = {
          provider: modelRef.provider,
          model: modelRef.model,
          text: out.text,
          json: out.json,
          usage: { inputTokens: out.inputTokens, outputTokens: out.outputTokens },
          stopReason: out.stopReason ?? 'stop',
        };
      } else {
        const client = createLlmClient({
          model: options.model,
          agentName: options.agentName,
          env: this.#env,
          ...(this.#fetchFn ? { fetch: this.#fetchFn } : {}),
        });
        const llmReq: LlmRequest = {
          system: options.request.system,
          user: options.request.user,
          schema: options.request.schema,
          ...(options.request.maxTokens !== undefined ? { maxTokens: options.request.maxTokens } : {}),
          ...(options.request.signal ? { signal: options.request.signal } : {}),
        };
        response = await client.complete(llmReq);
      }

      const latencyMs = Date.now() - startMs;
      this.#recordUsage(
        modelRef.provider,
        `${modelRef.provider}:${response.model}`,
        options.agentName,
        response.usage.inputTokens,
        response.usage.outputTokens,
        latencyMs,
      );

      return response;
    } catch (err) {
      if (err instanceof Os3ModelGatewayError) throw err;
      this.#providerStats[modelRef.provider].errors += 1;
      const msg = (err as Error).message;
      const code: ModelGatewayErrorCode = msg.includes('violates schema')
        ? 'SCHEMA_VIOLATION'
        : msg.includes('timeout') || msg.includes('abort')
          ? 'TIMEOUT'
          : 'PROVIDER_PERMANENT';
      throw new Os3ModelGatewayError({
        code,
        provider: modelRef.provider,
        model: options.model,
        message: msg,
      });
    }
  }

  #recordUsage(
    provider: Provider,
    fullModelKey: string,
    agentName: string,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
  ): void {
    this.#totalRequests += 1;
    this.#totalInputTokens += inputTokens;
    this.#totalOutputTokens += outputTokens;
    this.#totalLatencyMs += latencyMs;

    const pStat = this.#providerStats[provider];
    pStat.requests += 1;
    pStat.inputTokens += inputTokens;
    pStat.outputTokens += outputTokens;

    const mStat = this.#modelStats.get(fullModelKey) ?? {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    mStat.requests += 1;
    mStat.inputTokens += inputTokens;
    mStat.outputTokens += outputTokens;
    this.#modelStats.set(fullModelKey, mStat);

    if (this.#db && this.#db.isOpen) {
      try {
        this.#db.appendEvent({
          eventType: 'model.usage',
          domain: 'CORE',
          actor: agentName,
          payload: {
            provider,
            model: fullModelKey,
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            latencyMs,
          },
        });
      } catch {
        // Ignore if SQLite closed
      }
    }
  }

  getUsageSummary(): ModelUsageSummary {
    return {
      totalRequests: this.#totalRequests,
      totalInputTokens: this.#totalInputTokens,
      totalOutputTokens: this.#totalOutputTokens,
      totalLatencyMs: this.#totalLatencyMs,
      byProvider: {
        anthropic: { ...this.#providerStats.anthropic },
        groq: { ...this.#providerStats.groq },
        openrouter: { ...this.#providerStats.openrouter },
      },
      byModel: Object.fromEntries(this.#modelStats.entries()),
    };
  }
}
