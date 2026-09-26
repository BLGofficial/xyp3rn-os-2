/**
 * How the Suno Execution agent reaches Suno (Phase 9, user decision: pluggable). Suno has no
 * official public API (a developer API is in partner-only exploration since 2026-07), so:
 * - `manual`: nothing leaves the system on submit; the operator generates in the Suno UI with
 *   the recorded prompt and registers the resulting takes. No key, no ToS exposure.
 * - `sunoapi`: the sunoapi.org reseller (unofficial resale of Suno access). Shapes follow
 *   docs.sunoapi.org; UNVERIFIED against the live service until SUNO_API_KEY exists.
 * The caller names the adapter: an Execution agent never decides how to perform an operation.
 */

export const SUNO_ADAPTERS = ['manual', 'sunoapi'] as const;
export type SunoAdapterName = (typeof SUNO_ADAPTERS)[number];

export type SunoPrompt = { readonly title: string; readonly style: string; readonly excludeStyles: readonly string[]; readonly lyrics: string };

/** One take: an https URL (the provider's, or the operator's) or, since AOS-03, a Vault audio file (S3). */
export type TakeInput = {
  readonly audioUrl?: string;
  readonly sourceId?: string;
  readonly providerTakeId?: string;
  readonly title?: string;
  readonly durationSeconds?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type SunoAdapter = {
  readonly name: SunoAdapterName;
  readonly submit: (p: { readonly prompt: SunoPrompt; readonly sunoModel: string; readonly signal?: AbortSignal }) => Promise<{ readonly providerTaskId: string | null; readonly providerResponse: unknown }>;
  /** `complete` with the takes, or `pending` (no takes yet) — a pending task is not an error. */
  readonly capture: (p: { readonly providerTaskId: string | null; readonly takes?: readonly unknown[]; readonly signal?: AbortSignal }) => Promise<{ readonly status: 'complete' | 'pending'; readonly takes: readonly TakeInput[]; readonly providerResponse: unknown }>;
};

type Env = Readonly<Record<string, string | undefined>>;

const SUNOAPI_BASE = 'https://api.sunoapi.org/api/v1';
const HTTPS_URL = /^https:\/\/[^\s/]+\//;

/**
 * Suno version as the formula records it (`v5`, `v4.5`, `v4.5plus`) → the reseller's enum (`V5`, `V4_5`, `V4_5PLUS`).
 * @param v - formula `sunoModel`
 * @returns the reseller model id
 * @throws Error when it doesn't look like a Suno version
 */
export const toSunoApiModel = (v: string): string => {
  const m = /^v(\d+)(?:\.(\d+))?([a-z]*)$/i.exec(v);
  if (!m) throw new Error(`suno model ${JSON.stringify(v)} is not a version like v5 or v4.5`);
  return `V${m[1]}${m[2] ? `_${m[2]}` : ''}${m[3] ? m[3].toUpperCase() : ''}`;
};

/**
 * Validates operator-supplied takes; returns them normalized or throws listing every problem. Since
 * AOS-03 (S3) a take is the audio file itself, uploaded to the Vault (`sourceId`), or an https URL.
 */
const operatorTakes = (takes: readonly unknown[] | undefined): TakeInput[] => {
  if (!Array.isArray(takes) || takes.length === 0) throw new Error('manual capture needs takes: [{ sourceId | audioUrl, title?, durationSeconds? }] from the Suno UI');
  const errors: string[] = [];
  const out = takes.map((t, i) => {
    const o = (t ?? {}) as Record<string, unknown>;
    if ((o.audioUrl === undefined) === (o.sourceId === undefined)) errors.push(`takes[${i}] needs exactly one of audioUrl, sourceId (a Vault audio file)`);
    else if (o.audioUrl !== undefined && (typeof o.audioUrl !== 'string' || !HTTPS_URL.test(o.audioUrl))) errors.push(`takes[${i}].audioUrl must be an https URL`);
    else if (o.sourceId !== undefined && typeof o.sourceId !== 'string') errors.push(`takes[${i}].sourceId must be a Vault file id`);
    if (o.durationSeconds !== undefined && !(typeof o.durationSeconds === 'number' && o.durationSeconds > 0)) errors.push(`takes[${i}].durationSeconds must be a positive number`);
    if (o.title !== undefined && typeof o.title !== 'string') errors.push(`takes[${i}].title must be a string`);
    return {
      ...(typeof o.audioUrl === 'string' ? { audioUrl: o.audioUrl } : {}),
      ...(typeof o.sourceId === 'string' ? { sourceId: o.sourceId } : {}),
      ...(typeof o.title === 'string' ? { title: o.title } : {}),
      ...(typeof o.durationSeconds === 'number' ? { durationSeconds: o.durationSeconds } : {}),
    };
  });
  if (errors.length > 0) throw new Error(`manual capture rejected: ${errors.join('; ')}`);
  return out;
};

const manual: SunoAdapter = {
  name: 'manual',
  submit: async () => ({ providerTaskId: null, providerResponse: null }),
  capture: async ({ takes }) => ({ status: 'complete', takes: operatorTakes(takes), providerResponse: null }),
};

type SunoApiReply = {
  code?: number;
  msg?: string;
  data?: { taskId?: string; status?: string; errorMessage?: string; response?: { sunoData?: Record<string, unknown>[] } | null } | null;
};

const FAILED = new Set(['CREATE_TASK_FAILED', 'GENERATE_AUDIO_FAILED', 'CALLBACK_EXCEPTION', 'SENSITIVE_WORD_ERROR']);

const sunoapi = (env: Env, fetchFn: typeof fetch): SunoAdapter => {
  const key = () => {
    const k = env.SUNO_API_KEY;
    if (!k) throw new Error('sunoapi unavailable: SUNO_API_KEY is not set');
    return k;
  };
  const call = async (path: string, init: RequestInit): Promise<SunoApiReply> => {
    const res = await fetchFn(`${SUNOAPI_BASE}${path}`, { ...init, headers: { authorization: `Bearer ${key()}`, 'content-type': 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as SunoApiReply;
    // The vendor reports errors in `code`, sometimes inside an HTTP 200.
    if (!res.ok || body.code !== 200) throw new Error(`sunoapi error ${body.code ?? res.status}: ${body.msg ?? res.statusText}`);
    return body;
  };
  return {
    name: 'sunoapi',
    submit: async ({ prompt, sunoModel, signal }) => {
      key();
      // Required by the vendor even though this adapter polls; the operator decides where it points.
      const callBackUrl = env.SUNO_CALLBACK_URL;
      if (!callBackUrl) throw new Error('sunoapi unavailable: SUNO_CALLBACK_URL is not set (the vendor requires callBackUrl; this adapter polls either way)');
      const reply = await call('/generate', {
        method: 'POST',
        body: JSON.stringify({
          customMode: true, instrumental: false, model: toSunoApiModel(sunoModel), callBackUrl,
          title: prompt.title, style: prompt.style, negativeTags: prompt.excludeStyles.join(', '), lyrics: prompt.lyrics,
        }),
        ...(signal ? { signal } : {}),
      });
      const taskId = reply.data?.taskId;
      if (!taskId) throw new Error('sunoapi error: generate returned no taskId');
      return { providerTaskId: taskId, providerResponse: reply };
    },
    capture: async ({ providerTaskId, takes, signal }) => {
      if (takes !== undefined) throw new Error('sunoapi takes come from the provider; do not pass takes');
      if (!providerTaskId) throw new Error('sunoapi capture needs the submission’s provider task id');
      const reply = await call(`/generate/record-info?taskId=${encodeURIComponent(providerTaskId)}`, { method: 'GET', ...(signal ? { signal } : {}) });
      const status = reply.data?.status ?? 'UNKNOWN';
      if (FAILED.has(status)) throw new Error(`sunoapi task ${providerTaskId} failed: ${status}${reply.data?.errorMessage ? ` (${reply.data.errorMessage})` : ''}`);
      if (status !== 'SUCCESS') return { status: 'pending', takes: [], providerResponse: reply };
      // Field casing differs across the vendor's doc versions (audio_url vs audioUrl): accept both.
      const found = (reply.data?.response?.sunoData ?? []).map((d): TakeInput => {
        const audioUrl = (d.audio_url ?? d.audioUrl) as string;
        return {
          audioUrl, providerTakeId: String(d.id),
          ...(typeof d.title === 'string' ? { title: d.title } : {}),
          ...(typeof d.duration === 'number' && d.duration > 0 ? { durationSeconds: d.duration } : {}),
          metadata: Object.fromEntries(Object.entries(d).filter(([k]) => !['id', 'audio_url', 'audioUrl', 'title', 'duration'].includes(k))),
        };
      });
      const bad = found.filter((t) => typeof t.audioUrl !== 'string' || !HTTPS_URL.test(t.audioUrl));
      if (bad.length > 0) throw new Error(`sunoapi task ${providerTaskId}: ${bad.length} take(s) without an https audio URL`);
      return { status: 'complete', takes: found, providerResponse: reply };
    },
  };
};

/**
 * @param name - `manual` or `sunoapi` (named by the caller, never chosen here)
 * @param deps - `env` holding SUNO_API_KEY / SUNO_CALLBACK_URL; `fetch` override (tests)
 * @returns the adapter
 * @throws Error on an unknown adapter name
 */
export const createSunoAdapter = (name: string, deps: { readonly env: Env; readonly fetch?: typeof fetch }): SunoAdapter => {
  if (name === 'manual') return manual;
  if (name === 'sunoapi') return sunoapi(deps.env, deps.fetch ?? fetch);
  throw new Error(`adapter must be one of ${SUNO_ADAPTERS.join(', ')}, got ${JSON.stringify(name)}`);
};
