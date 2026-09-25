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
import { createLocalVaultStore, defaultVaultDir, type VaultStore } from '../../knowledge/source-registry/vault-store.ts';
import { createReadVaultFileTool, createRegisterVaultFileTool } from '../../knowledge/source-registry/vault-tools.ts';
import { createSongTools } from '../../records/vault/tools.ts';
import { ARTIFACT_SCHEMAS } from '../../records/x3lius/creative/schemas.ts';
import { createReadCritiqueTool, createWriteCritiqueTool } from '../../records/x3lius/evaluation/tools.ts';
import { createRecordsOpsTools } from '../../records/ops/tools.ts';
import { createReadFrontierEvidenceTool, createWriteRdBacklogTool } from '../../tech/r-and-d/tools.ts';
import { createLinkTraceReportTool, createRecordTraceAnalysisTool } from '../../tech/trace/tools.ts';
import { createCaptureSunoTakesTool, createSubmitSunoTool } from '../../records/x3lius/suno/tools.ts';
import { createFetchSourceTool } from '../../research-intelligence/tools/fetch-source.ts';
import { createWriteEvidenceTool } from '../../research-intelligence/tools/write-evidence.ts';

/**
 * The live tool set. Adding a tool here is the only way it becomes requestable.
 * @param deps - pool the tools run through (each under its own xyp_* role); `env` for external
 *   configuration such as SUNO_API_KEY (default process.env); `fetch` override for external calls (tests)
 * @returns registry with log_message, retrieve_context, retrieve_claims, fetch_source, write_evidence,
 *   write_artifact, read_artifact, write_critique, read_critique, submit_suno, capture_suno_takes, and the
 *   Records ops tools (Phase 13): resolve_take, read_catalog, register_track, write_splits, assign_codes,
 *   schedule_release; TECH (Phase 14): record_trace_analysis, link_trace_report, read_frontier_evidence,
 *   write_rd_backlog; and the Creative Vault (AOS-01): register_vault_file, read_vault_file, write_song,
 *   link_song, unlink_song. `vault` is the byte store (default: the local store at defaultVaultDir(env)).
 */
export const createRuntimeTools = (deps: {
  readonly sql: Sql;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly vault?: VaultStore;
}): ToolRegistry => {
  const external = { sql: deps.sql, env: deps.env ?? process.env, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
  let longTerm: Promise<LongTermMemory> | undefined;
  const lazyLongTerm = () => (longTerm ??= loadEmbedder().then((e) => createLongTermMemory(createContextEngine(deps.sql, e))));
  return createToolRegistry([
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
    ...createRecordsOpsTools(deps),
    createRecordTraceAnalysisTool(deps),
    createLinkTraceReportTool(deps),
    createReadFrontierEvidenceTool(deps),
    createWriteRdBacklogTool(deps),
    createRegisterVaultFileTool({ sql: deps.sql, vault: deps.vault ?? createLocalVaultStore(defaultVaultDir(external.env)) }),
    createReadVaultFileTool(deps),
    ...createSongTools(deps),
  ]);
};
