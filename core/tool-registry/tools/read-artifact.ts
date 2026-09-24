import { quoteIdent, type Sql } from '../../db/client.ts';
import { defineTool, type Tool } from '../registry.ts';

type Row = { id: string; lineage_id: string; version: number; schema_id: string; agent_name: string; body: Record<string, unknown>; created_at: string };

/**
 * read_artifact (capability artifact.read, Phase 9): one creative artifact version by id, read-only
 * as xyp_runtime. How a Creative agent builds on an upstream artifact (the Suno formula on Phase 8
 * lyrics) without the caller pasting its content — the id is the provenance.
 * @param deps - pool the read runs through
 * @returns the tool definition
 */
export const createReadArtifactTool = (deps: { readonly sql: Sql }): Tool =>
  defineTool({
    name: 'read_artifact',
    capability: 'artifact.read',
    description: 'One creative artifact version by id: schema id, version, lineage, author agent and body.',
    handler: async (_ctx, args) => {
      const id = (args as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('read_artifact: id must be an artifact uuid');
      const rows = (await deps.sql.begin('read only', async (tx) => {
        await tx.unsafe(`set local role ${quoteIdent('xyp_runtime')}`);
        return tx<Row[]>`select id, lineage_id, version, schema_id, agent_name, body, created_at from creative_artifacts where id = ${id}`;
      })) as Row[];
      const row = rows[0];
      if (!row) throw new Error(`read_artifact: no artifact ${id}`);
      return { id: row.id, lineageId: row.lineage_id, version: row.version, schemaId: row.schema_id, agentName: row.agent_name, body: row.body, createdAt: row.created_at };
    },
  });
