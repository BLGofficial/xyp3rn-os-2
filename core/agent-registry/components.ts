import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Domain } from '../contracts/taxonomy.ts';
import { TECH_COMPONENTS } from '../../tech/catalog.ts';

export type Component = { id: string; domain: Domain; label: string; sourceRef: string; description?: string };
/** Architecture registrations point to implementations, never reserved-but-unbuilt names. */
const COMPONENTS: readonly Component[] = [
  ...[
    ['orchestrator','Orchestrator','core/orchestrator/dispatch.ts'], ['agent-registry','Agent Registry','core/agent-registry/registry.ts'],
    ['workflow-engine','Workflow Engine','core/workflow-engine/engine.ts'], ['tool-registry','Tool Registry','core/tool-registry/registry.ts'],
    ['context-engine','Context Engine','core/context-engine/context-engine.ts'], ['memory','Memory','core/memory/memory.ts'],
    ['evaluation-observability','Run Observability','core/orchestrator/dispatch.ts'],
  ].map(([id,label,sourceRef]) => ({ id: id!, label: label!, sourceRef: sourceRef!, domain: 'CORE' as const })),
  ...[
    ['canonical-knowledge','Canonical Knowledge','knowledge/promotion-gate/gate.ts'], ['source-registry','Source Registry','knowledge/source-registry/acquire.ts'],
    ['prompt-library','Prompt Library','knowledge/ingestion/ingest.ts'], ['vector-retrieval','Vector Retrieval','knowledge/vector-retrieval/compose.ts'],
    ['knowledge-graph','Knowledge Graph','core/context-engine/context-engine.ts'], ['versioning-provenance','Versioning + Provenance','knowledge/promotion-gate/gate.ts'],
    ['promotion-gate','Knowledge Promotion','knowledge/promotion-gate/gate.ts'],
  ].map(([id,label,sourceRef]) => ({ id: id!, label: label!, sourceRef: sourceRef!, domain: 'KNOWLEDGE' as const })),
  ...[
    ['research-orchestrator','Research Orchestrator','research-intelligence/agents/research-orchestrator.ts'], ['evidence-engine','Evidence Engine','research-intelligence/evidence/engine.ts'],
    ['source-verification','Source Verification','research-intelligence/sources/verify.ts'], ['contradiction-engine','Contradiction Engine','research-intelligence/contradictions/engine.ts'],
    ['experiment-engine','Experiment Engine','research-intelligence/experiments/engine.ts'], ['synthesis','Finding Synthesis','research-intelligence/synthesis/findings.ts'],
  ].map(([id,label,sourceRef]) => ({ id: id!, label: label!, sourceRef: sourceRef!, domain: 'RESEARCH_INTELLIGENCE' as const })),
  ...TECH_COMPONENTS.map(c => ({ ...c, domain: 'TECH' as const })),
  ...[
    ['x3lius-music-system','X3LIUS Music System','records/x3lius/music-system.manifest.yaml'],
    ['catalog','Catalog','records/ops/tools.ts'], ['rights-splits','Rights Splits','records/ops/splits.ts'],
    ['release-calendar','Release Calendar','records/ops/schedulable.ts'],
  ].map(([id,label,sourceRef]) => ({ id: id!, label: label!, sourceRef: sourceRef!, domain: 'RECORDS' as const })),
  ...[
    ['legal','Legal','governance/rules.ts'], ['rights-conflict','Rights Conflict','governance/tools.ts'], ['permissions-rbac','Permissions / RBAC','governance/auth.ts'],
    ['human-approval','Human Approval','governance/auth.ts'], ['audit-provenance','Audit / Provenance','supabase/migrations/20260925130000_governance.sql'],
  ].map(([id,label,sourceRef]) => ({ id: id!, label: label!, sourceRef: sourceRef!, domain: 'GOVERNANCE' as const })),
];
export const registeredComponents = (root: string): readonly Component[] => COMPONENTS.filter(c => existsSync(join(root,c.sourceRef)));
