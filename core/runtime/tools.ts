import { createContextEngine } from '../context-engine/context-engine.ts';
import type { Sql } from '../db/client.ts';
import { createLongTermMemory, type LongTermMemory } from '../memory/memory.ts';
import { createToolRegistry, type ToolRegistry } from '../tool-registry/registry.ts';
import { logMessageTool } from '../tool-registry/tools/log-message.ts';
import { createReadArtifactTool } from '../tool-registry/tools/read-artifact.ts';
import { createRetrieveClaimsTool } from '../tool-registry/tools/retrieve-claims.ts';
import { createRetrieveContextTool } from '../tool-registry/tools/retrieve-context.ts';
import { createWriteArtifactTool } from '../tool-registry/tools/write-artifact.ts';
import { loadEmbedder } from '../../knowledge/vector-retrieval/embedder.ts';
import { ARTIFACT_SCHEMAS } from '../../records/x3lius/creative/schemas.ts';
import { createReadCritiqueTool, createWriteCritiqueTool } from '../../records/x3lius/evaluation/tools.ts';
import { createFlagReleaseTool, createProposeScheduleTool, createReadReleaseTool, createRegisterTrackTool } from '../../records/ops/tools.ts';
import { createCaptureSunoTakesTool, createSubmitSunoTool } from '../../records/x3lius/suno/tools.ts';
import { createFetchSourceTool } from '../../research-intelligence/tools/fetch-source.ts';
import { createWriteEvidenceTool } from '../../research-intelligence/tools/write-evidence.ts';
import { createBacklogTool } from '../../tech/backlog.ts';
import { createGovernanceTools } from '../../governance/tools.ts';

/**
 * The live tool set. Adding a tool here is the only way it becomes requestable.
 * @param deps - pool the tools run through (each under its own xyp_* role); `env` for external
 *   configuration such as SUNO_API_KEY (default process.env); `fetch` override for external calls (tests)
 * @returns registry with log_message, retrieve_context, retrieve_claims, fetch_source, write_evidence,
 *   write_artifact, read_artifact, write_critique, read_critique, submit_suno, capture_suno_takes,
 *   register_track, read_release, flag_release, propose_schedule (Phase 13)
 */
export const createRuntimeTools = (deps: {
  readonly sql: Sql;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}): ToolRegistry => {
  const external = { sql: deps.sql, env: deps.env ?? process.env, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
  let longTerm: Promise<LongTermMemory> | undefined;
  const lazyLongTerm = () => (longTerm ??= loadEmbedder().then((e) => createLongTermMemory(createContextEngine(deps.sql, e))));
  return createToolRegistry([
    createBacklogTool(deps.sql),
    ...createGovernanceTools(deps.sql),
    logMessageTool,
    createRetrieveContextTool(lazyLongTerm),
    createRetrieveClaimsTool(deps),
    createFetchSourceTool(deps),
    createWriteEvidenceTool(deps),
    createWriteArtifactTool({ sql: deps.sql, schemas: ARTIFACT_SCHEMAS }),
    createReadArtifactTool(deps),
    createWriteCritiqueTool(deps),
    createReadCritiqueTool(deps),
    createSubmitSunoTool(external),
    createCaptureSunoTakesTool(external),
    createRegisterTrackTool(deps),
    createReadReleaseTool(deps),
    createFlagReleaseTool(deps),
    createProposeScheduleTool(deps),
  ]);
};
