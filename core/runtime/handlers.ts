import { contextRetriever } from '../agents/context-retriever.ts';
import { extractiveSummarizer } from '../agents/extractive-summarizer.ts';
import { healthCheck } from '../agents/health-check.ts';
import type { HandlerMap } from '../orchestrator/dispatch.ts';
import { researchOrchestrator } from '../../research-intelligence/agents/research-orchestrator.ts';
import { CREATIVE_SUBDOMAINS } from '../../records/x3lius/creative/program.ts';
import { mixMaster } from '../../records/x3lius/mix-master/agent.ts';
import { loadMusicSystem } from '../../records/x3lius/music-system.ts';
import { subdomainStub } from '../../records/x3lius/subdomain-stub.ts';
import { sunoSubmitter } from '../../records/x3lius/suno/submitter.ts';
import { vocalDnaAgent } from '../../records/x3lius/vocal-dna/agent.ts';
import { rvcPost } from '../../records/x3lius/vocal-dna/rvc-post.ts';
import { catalog, CATALOG_AGENT } from '../../records/ops/catalog/catalog.ts';
import { catalogLookup, CATALOG_LOOKUP_AGENT } from '../../records/ops/catalog/lookup.ts';
import { releaseCalendar, CALENDAR_AGENT } from '../../records/ops/release-calendar/calendar.ts';
import { rightsCheck, RIGHTS_AGENT } from '../../records/ops/rights-splits/check.ts';
import { loadTechSystem, techStub } from '../../tech/tech-system.ts';
import { AUDIO_TOOLS_AGENT, audioTools } from '../../tech/trace/intake.ts';
import { VAULT_CURATOR_AGENT, vaultCurator } from '../../knowledge/ingestion/vault-curator.ts';
import { LYRIC_EDITOR_AGENT, lyricEditor } from '../../records/vault/lyric-editor.ts';
import { recordsSongs, SONGS_AGENT } from '../../records/vault/songs-agent.ts';
import { recordsTasks, TASKS_AGENT } from '../../records/ops/tasks/tasks.ts';

/** X3LIUS sub-domains a phase has built: no longer served by the Phase 7 stub. */
export const BUILT_SUBDOMAINS: readonly string[] = [...CREATIVE_SUBDOMAINS, 'x3lius-vocal-dna', 'x3lius-mix-master', 'x3lius-evaluation'];

/**
 * Deterministic (`model: none`) agent handlers, keyed by agent name. Checked in and
 * typechecked on purpose: nothing is loaded dynamically from agents/. A `model: none` agent
 * missing here fails dispatch with "no handler registered".
 */
export const HANDLERS: HandlerMap = {
  'context-retriever': contextRetriever,
  'extractive-summarizer': extractiveSummarizer,
  'health-check': healthCheck,
  'research-orchestrator': researchOrchestrator,
  // Phase 9: Suno Execution (deterministic; its side effects go through submit_suno / capture_suno_takes).
  'suno-submitter': sunoSubmitter,
  // Phase 10: Vocal DNA (Knowledge) and its RVC post-processing consumer (Execution), one reader.
  'x3lius-rvc-post': rvcPost,
  // Phase 11: Mix/Master (Creative, deterministic): a TRACE analysis checked against the canonical rubric.
  'x3lius-mix-master': mixMaster,
  // Phase 13: Records ops (all deterministic). F10 split: the catalog lookup (Knowledge) and the
  // catalog writer (Execution), chained by records/workflows/register-track.workflow.yaml; the Rights
  // check (Governance) before the calendar (Execution) in schedule-release.workflow.yaml.
  [CATALOG_LOOKUP_AGENT]: catalogLookup,
  [CATALOG_AGENT]: catalog,
  [RIGHTS_AGENT]: rightsCheck,
  [CALENDAR_AGENT]: releaseCalendar,
  // Phase 14: TECH. Audio Tools is the TRACE intake (Execution); R&D is an LLM program
  // (core/runtime/programs.ts); the other components are manifest stubs until a phase builds them.
  [AUDIO_TOOLS_AGENT]: audioTools,
  // AOS-01: the Creative Vault. The owner's writes go through deterministic agents (A2): files
  // (Execution), songs and links (Execution), and the owner's own lyric versions (Creative).
  [VAULT_CURATOR_AGENT]: vaultCurator,
  [SONGS_AGENT]: recordsSongs,
  [LYRIC_EDITOR_AGENT]: lyricEditor,
  // AOS-02: the owner's to-dos (Execution, deterministic); catalog metadata goes through records-catalog.
  [TASKS_AGENT]: recordsTasks,
  ...Object.fromEntries(loadTechSystem().components.filter((c) => c.builtIn === null).map((c) => [c.slug, techStub])),
  // Phase 7: one stub per X3LIUS sub-domain no phase has built yet (none since Phase 12): the
  // fallback for a sub-domain a future manifest adds. Built ones run as LLM agents (core/runtime/programs.ts).
  ...Object.fromEntries(
    loadMusicSystem().subdomains.filter((s) => !BUILT_SUBDOMAINS.includes(s.slug)).map((s) => [s.slug, subdomainStub]),
  ),
  'x3lius-vocal-dna': vocalDnaAgent,
};
