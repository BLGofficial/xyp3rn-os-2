/**
 * The JSON Schema subset LLM structured outputs share across providers: object (with required
 * and additionalProperties: false), array, string (optional enum), integer, number, boolean.
 * Nothing else is supported on purpose — numeric/length constraints aren't portable across
 * providers, so semantic checks live in the caller, not in the schema.
 */
export type JsonSchema =
  | { readonly type: 'object'; readonly properties: Readonly<Record<string, JsonSchema>>; readonly required: readonly string[]; readonly additionalProperties: false; readonly description?: string }
  | { readonly type: 'array'; readonly items: JsonSchema; readonly description?: string }
  | { readonly type: 'string'; readonly enum?: readonly string[]; readonly description?: string }
  | { readonly type: 'integer' | 'number' | 'boolean'; readonly description?: string };

/** Builders for the subset. `obj` requires every property and allows no others. */
export const str = (description?: string): JsonSchema => (description ? { type: 'string', description } : { type: 'string' });
export const int = (description: string): JsonSchema => ({ type: 'integer', description });
export const num = (description: string): JsonSchema => ({ type: 'number', description });
export const arr = (items: JsonSchema, description?: string): JsonSchema => (description ? { type: 'array', items, description } : { type: 'array', items });
export const obj = (properties: Record<string, JsonSchema>, description?: string): JsonSchema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false, ...(description ? { description } : {}),
});

const typeOk = (schema: JsonSchema, v: unknown): boolean => {
  switch (schema.type) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
  }
};

/**
 * Validates a value against the subset. Pure; returns every violation at once.
 * @param schema - schema in the supported subset
 * @param value - parsed JSON
 * @param path - JSONPath-ish prefix for messages (default `$`)
 * @returns violations like `$.bars[2].n must be integer`, empty when valid
 */
export const validateJson = (schema: JsonSchema, value: unknown, path = '$'): string[] => {
  if (!typeOk(schema, value)) return [`${path} must be ${schema.type}`];
  if (schema.type === 'string' && schema.enum && !schema.enum.includes(value as string)) {
    return [`${path} must be one of ${schema.enum.join(', ')}`];
  }
  if (schema.type === 'array') return (value as unknown[]).flatMap((v, i) => validateJson(schema.items, v, `${path}[${i}]`));
  if (schema.type !== 'object') return [];
  const o = value as Record<string, unknown>;
  return [
    ...Object.entries(schema.properties).flatMap(([k, s]) =>
      k in o ? validateJson(s, o[k], `${path}.${k}`) : schema.required.includes(k) ? [`${path}.${k} is required`] : []),
    ...Object.keys(o).filter((k) => !(k in schema.properties)).map((k) => `${path}.${k} is not allowed`),
  ];
};
