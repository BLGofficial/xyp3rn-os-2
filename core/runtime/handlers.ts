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
  // Phase 7: one stub per X3LIUS sub-domain no phase has built yet (none since Phase 12): the
  // fallback for a sub-domain a future manifest adds. Built ones run as LLM agents (core/runtime/programs.ts).
  ...Object.fromEntries(
    loadMusicSystem().subdomains.filter((s) => !BUILT_SUBDOMAINS.includes(s.slug)).map((s) => [s.slug, subdomainStub]),
  ),
  'x3lius-vocal-dna': vocalDnaAgent,
};
