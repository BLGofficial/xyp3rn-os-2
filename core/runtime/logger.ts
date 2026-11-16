import type { LogLevel } from './config.ts';

export type StructuredLogEntry = {
  readonly timestamp: string;
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly service: string;
  readonly event: string;
  readonly message: string;
  readonly context?: Record<string, unknown> | undefined;
};

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

const SECRET_REDACTION_PATTERNS: readonly RegExp[] = [
  /\bsk-or-v1-[a-zA-Z0-9_-]{12,}\b/g,
  /\bsk-ant-[a-zA-Z0-9_-]{12,}\b/g,
  /\bgsk_[a-zA-Z0-9_-]{12,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bBearer\s+[a-zA-Z0-9._-]{16,}\b/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

export const redactSecrets = (text: string): string => {
  let out = text;
  for (const re of SECRET_REDACTION_PATTERNS) {
    out = out.replace(re, '[REDACTED_SECRET]');
  }
  return out;
};

const redactValue = (val: unknown): unknown => {
  if (typeof val === 'string') return redactSecrets(val);
  if (Array.isArray(val)) return val.map((item) => redactValue(item));
  if (val !== null && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (/api[_-]?key|secret|password|token|authorization/i.test(k)) {
        out[k] = '[REDACTED_SECRET]';
      } else {
        out[k] = redactValue(v);
      }
    }
    return out;
  }
  return val;
};

/**
 * Structured JSON logger with automatic secret redaction and in-memory ring buffer
 * for diagnostic inspection.
 */
export class StructuredLogger {
  readonly #service: string;
  readonly #minLevel: LogLevel;
  readonly #sink: ((entry: StructuredLogEntry) => void) | undefined;
  readonly #buffer: StructuredLogEntry[] = [];
  readonly #maxBufferSize: number;

  constructor(options: {
    readonly service?: string | undefined;
    readonly level?: LogLevel | undefined;
    readonly sink?: ((entry: StructuredLogEntry) => void) | undefined;
    readonly maxBufferSize?: number | undefined;
  } = {}) {
    this.#service = options.service ?? 'xyp3rn-os3-runtime';
    this.#minLevel = options.level ?? 'info';
    this.#sink = options.sink;
    this.#maxBufferSize = options.maxBufferSize ?? 250;
  }

  get entries(): readonly StructuredLogEntry[] {
    return this.#buffer;
  }

  log(
    level: Exclude<LogLevel, 'silent'>,
    event: string,
    message: string,
    context?: Record<string, unknown>,
  ): StructuredLogEntry | null {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#minLevel]) {
      return null;
    }

    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.#service,
      event,
      message: redactSecrets(message),
      ...(context ? { context: redactValue(context) as Record<string, unknown> } : {}),
    };

    this.#buffer.push(entry);
    if (this.#buffer.length > this.#maxBufferSize) {
      this.#buffer.shift();
    }

    if (this.#sink) {
      this.#sink(entry);
    }

    return entry;
  }

  debug(event: string, message: string, context?: Record<string, unknown>): StructuredLogEntry | null {
    return this.log('debug', event, message, context);
  }

  info(event: string, message: string, context?: Record<string, unknown>): StructuredLogEntry | null {
    return this.log('info', event, message, context);
  }

  warn(event: string, message: string, context?: Record<string, unknown>): StructuredLogEntry | null {
    return this.log('warn', event, message, context);
  }

  error(event: string, message: string, context?: Record<string, unknown>): StructuredLogEntry | null {
    return this.log('error', event, message, context);
  }
}
