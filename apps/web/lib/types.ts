import type { Domain } from '../../../core/contracts/taxonomy.ts';
import type { Identity } from '../../../governance/auth.ts';
export type GraphNode = { id: string; kind: 'hub'|'domain'|'satellite'; domain: Domain; label: string; subtitle?: string; status: string; sourceRef: string; sourceType: 'file'|'database'|'configuration'; entityType: string; entityId: string; href: string; metadata: Record<string,unknown> };
export type GraphEdge = { id: string; fromId: string; toId: string; relation: 'ownership'|'runtime'|'knowledge'|'workflow'; status: string; sourceRef: string };
export type LiveActivityEvent = { id: string; source: string; sourceRef: string; domain: Domain; eventType: string; summary: string; timestamp: string; severity: 'info'|'warning'|'error' };
export type Metric = { value: number|null; source: string; query: string; generatedAt: string; note?: string };
export type SystemStatusSnapshot = { systemHealth: 'HEALTHY'|'DEGRADED'|'PARTIAL_OUTAGE'|'UNAVAILABLE'|'UNKNOWN'; agentsOnline: Metric; agentsTotal: Metric; workflowsActive: Metric; knowledgeNodes: Metric; researchTasksOpen: Metric; recordsProjectsOpen: Metric; apiConnections: Metric; uptimePercent: Metric; generatedAt: string };
export type Projection = { nodes: GraphNode[]; edges: GraphEdge[]; events: LiveActivityEvent[]; status: SystemStatusSnapshot; identity: Identity; version: string; domains: { id:Domain; label:string; color:string }[]; errors: string[]; generatedAt:string; truncated: string[] };
