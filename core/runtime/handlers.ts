import { contextRetriever } from '../agents/context-retriever.ts';
import { extractiveSummarizer } from '../agents/extractive-summarizer.ts';
import { healthCheck } from '../agents/health-check.ts';
import type { HandlerMap } from '../orchestrator/dispatch.ts';
import { researchOrchestrator } from '../../research-intelligence/agents/research-orchestrator.ts';
import { CREATIVE_SUBDOMAINS } from '../../records/x3lius/creative/program.ts';
import { loadMusicSystem } from '../../records/x3lius/music-system.ts';
import { subdomainStub } from '../../records/x3lius/subdomain-stub.ts';
import { sunoSubmitter } from '../../records/x3lius/suno/submitter.ts';

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
  // Phase 7: one stub per X3LIUS sub-domain, from the checked-in manifest (not from agents/),
  // except those a later phase built as LLM agents (Phases 8–9: core/runtime/programs.ts).
  ...Object.fromEntries(
    loadMusicSystem().subdomains.filter((s) => !CREATIVE_SUBDOMAINS.includes(s.slug)).map((s) => [s.slug, subdomainStub]),
  ),
};
