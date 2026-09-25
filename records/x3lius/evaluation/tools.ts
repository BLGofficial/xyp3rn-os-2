import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../../core/db/client.ts';
import { validateJson } from '../../../core/llm/json-schema.ts';
import { defineTool, type Tool } from '../../../core/tool-registry/registry.ts';
import { CRITIQUE_SCHEMA, CRITIQUE_SCHEMA_ID, critiqueBodyErrors, type CritiqueBody } from './schemas.ts';

/** The DB role critique writes run as (migration 20260925100000): INSERT/SELECT on critiques only. */
export const CRITIC_ROLE = 'xyp_critic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What read_critique returns. */
export type CritiqueRow = {
  readonly id: string; readonly artifactId: string; readonly previousId: string | null;
  readonly body: CritiqueBody; readonly checked: number; readonly passed: number; readonly createdAt: string;
};

/**
 * write_critique (capability critique.write, Critic only): appends one x3lius.critique/v1. The body
 * must satisfy the schema and agree with itself (counts, keys), and name the artifact and previous
 * critique it is written for — a prose verdict can never land here. The run comes from the context.
 * @param deps - pool the write runs through (as xyp_critic)
 * @returns the tool definition
 */
export const createWriteCritiqueTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'write_critique',
    capability: 'critique.write',
    description: 'Append one structured critique of a creative artifact version (insert-only; x3lius.critique/v1).',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as { artifactId?: unknown; previousId?: unknown; body?: unknown };
      const shape = validateJson(CRITIQUE_SCHEMA, a.body, '$.body');
      const body = a.body as CritiqueBody;
      const errors = [
        ...(typeof a.artifactId === 'string' && UUID.test(a.artifactId) ? [] : ['artifactId must be an artifact uuid']),
        ...(a.previousId === undefined || (typeof a.previousId === 'string' && UUID.test(a.previousId)) ? [] : ['previousId must be a critique uuid when given']),
        ...shape,
        ...(shape.length > 0 ? [] : critiqueBodyErrors(body)),
        ...(shape.length > 0 || body.artifact.id === a.artifactId ? [] : [`body.artifact.id ${body.artifact.id} is not artifactId ${String(a.artifactId)}`]),
        ...(shape.length > 0 || body.previousCritiqueId === a.previousId ? [] : ['body.previousCritiqueId must equal previousId (both absent on a first pass)']),
      ];
      if (errors.length > 0) throw new Error(`write_critique rejected: ${errors.join('; ')}`);
      const row = await deps.sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${quoteIdent(CRITIC_ROLE)}`);
        const [r] = await tx<{ id: string }[]>`
          insert into critiques (artifact_id, previous_id, agent_run_id, schema_id, body, checked, passed)
          values (${a.artifactId as string}, ${(a.previousId as string | undefined) ?? null}, ${ctx.runId}, ${CRITIQUE_SCHEMA_ID},
                  ${tx.json(body as unknown as postgres.JSONValue)}, ${body.counts.checked}, ${body.counts.passed})
          returning id`;
        return r!;
      });
      ctx.log('info', `write_critique → ${row.id}: ${body.counts.violations} violation(s), ${body.counts.passed}/${body.counts.checked} rules passed`);
      return { critique_id: row.id };
    },
  });

/**
 * read_critique (capability critique.read, Phase 12): one critique by id, read-only as xyp_runtime.
 * How Revision reads the critique it answers and the Critic reads the previous one.
 * @param deps - pool the read runs through
 * @returns the tool definition
 */
export const createReadCritiqueTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'read_critique',
    capability: 'critique.read',
    description: 'One critique by id: the artifact version it reviewed, the previous critique, and its body.',
    handler: async (_ctx, args) => {
      const id = (args as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !UUID.test(id)) throw new Error('read_critique: id must be a critique uuid');
      type Row = { id: string; artifact_id: string; previous_id: string | null; body: CritiqueBody; checked: number; passed: number; created_at: string };
      const rows = (await deps.sql.begin('read only', async (tx) => {
        await tx.unsafe(`set local role ${quoteIdent('xyp_runtime')}`);
        return tx<Row[]>`select id, artifact_id, previous_id, body, checked, passed, created_at from critiques where id = ${id}`;
      })) as Row[];
      const r = rows[0];
      if (!r) throw new Error(`read_critique: no critique ${id}`);
      return { id: r.id, artifactId: r.artifact_id, previousId: r.previous_id, body: r.body, checked: r.checked, passed: r.passed, createdAt: r.created_at } satisfies CritiqueRow;
    },
  });
