import type postgres from 'postgres';
import { quoteIdent, type Sql } from '../../db/client.ts';
import { validateJson, type JsonSchema } from '../../llm/json-schema.ts';
import { defineTool, type Tool } from '../registry.ts';

/** The DB role creative writes run as (migration 20260924180000): INSERT/SELECT on creative_artifacts only. */
export const CREATIVE_ROLE = 'xyp_creative';

export type WriteArtifactArgs = {
  readonly schemaId: string;
  readonly brief: string;
  readonly body: unknown;
  readonly contextRefs: readonly unknown[];
  readonly knowledge: Readonly<Record<string, unknown>>;
  readonly model: string;
  /** Set to write the next version of an existing artifact; omitted for v1. */
  readonly parentId?: string;
  /** Defects found in the body that did not block the write (default none). */
  readonly warnings?: readonly unknown[];
};

/**
 * write_artifact (capability artifact.write): appends one version of a structured creative
 * artifact. The body must satisfy the registered schema for `schemaId` — no schema, no write, so
 * a prose blob can never land here. Agent and run come from the run context, not the arguments.
 * @param deps - pool the write runs through (as xyp_creative); `schemas` by schema id
 * @returns the tool definition
 */
export const createWriteArtifactTool = (deps: { readonly sql: Sql; readonly schemas: Readonly<Record<string, JsonSchema>> }): Tool =>
  defineTool({
    name: 'write_artifact',
    capability: 'artifact.write',
    description: 'Append a schema-validated creative artifact version (insert-only; lineage/version derived by the database).',
    handler: async (ctx, args) => {
      const a = (args ?? {}) as Partial<WriteArtifactArgs>;
      const schema = typeof a.schemaId === 'string' ? deps.schemas[a.schemaId] : undefined;
      const errors = [
        ...(schema ? validateJson(schema, a.body, '$.body') : [`schemaId ${JSON.stringify(a.schemaId)} is not a registered artifact schema`]),
        ...(typeof a.brief === 'string' && a.brief.trim() !== '' ? [] : ['brief is required']),
        ...(Array.isArray(a.contextRefs) ? [] : ['contextRefs must be an array']),
        ...(a.knowledge && typeof a.knowledge === 'object' && !Array.isArray(a.knowledge) ? [] : ['knowledge must be an object']),
        ...(typeof a.model === 'string' && a.model !== '' ? [] : ['model is required']),
        ...(a.warnings === undefined || Array.isArray(a.warnings) ? [] : ['warnings must be an array']),
      ];
      if (errors.length > 0) throw new Error(`write_artifact rejected: ${errors.join('; ')}`);
      const row = await deps.sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${quoteIdent(CREATIVE_ROLE)}`);
        const [r] = await tx<{ id: string; lineage_id: string; version: number }[]>`
          insert into creative_artifacts (schema_id, agent_name, agent_run_id, parent_id, brief, body, context_refs, knowledge, model, warnings)
          values (${a.schemaId!}, ${ctx.agentName}, ${ctx.runId}, ${a.parentId ?? null}, ${a.brief!},
                  ${tx.json(a.body as postgres.JSONValue)}, ${tx.json(a.contextRefs as postgres.JSONValue)},
                  ${tx.json(a.knowledge as postgres.JSONValue)}, ${a.model!}, ${tx.json((a.warnings ?? []) as postgres.JSONValue)})
          returning id, lineage_id, version`;
        return r!;
      });
      ctx.log('info', `write_artifact → ${a.schemaId} ${row.id} v${row.version}`);
      return { artifact_id: row.id, lineage_id: row.lineage_id, version: row.version };
    },
  });
