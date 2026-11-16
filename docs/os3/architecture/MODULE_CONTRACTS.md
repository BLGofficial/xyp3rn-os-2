# XYP3RN OS 3.0 — TypeScript Module Contracts Specification

**Status:** Phase 2 Architecture Freeze
**Compiler Constraints:** `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"verbatimModuleSyntax": true`, `"erasableSyntaxOnly": true`

All contracts below use pure TypeScript `type` aliases and `as const` unions (no `enum`, no constructor parameter properties) to comply with `erasableSyntaxOnly: true`.

---

## 1. Core Taxonomy & Primitives (`core/contracts/taxonomy.ts`)

```ts
export const DOMAINS = [
  'CORE',
  'KNOWLEDGE',
  'RESEARCH_INTELLIGENCE',
  'RECORDS',
  'TECH',
  'GOVERNANCE',
] as const;

export type Domain = (typeof DOMAINS)[number];

export const AGENT_CLASSES = [
  'Research',
  'Knowledge',
  'Planning',
  'Creative',
  'Critic',
  'Revision',
  'Execution',
  'Governance',
] as const;

export type AgentClass = (typeof AGENT_CLASSES)[number];

export const VAULT_SECTORS = [
  '01_CORE',
  '02_KNOWLEDGE_LAYER',
  '03_RESEARCH_INTELLIGENCE',
  '04_RESEARCH_MATERIAL',
  '05_XYP3RN_RECORDS',
  '06_GOVERNANCE',
] as const;

export type VaultSector = (typeof VAULT_SECTORS)[number];
```

---

## 2. Vault Engine Contract (`core/vault-engine/`)

```ts
export type ExtractedWikilink = {
  readonly target: string;
  readonly heading: string | null;
  readonly alias: string | null;
  readonly embed: boolean;
  readonly raw: string;
};

export type VaultNoteDocument = {
  readonly vaultPath: string;
  readonly sector: VaultSector | 'ROOT_KB';
  readonly isCanonical: boolean;
  readonly rawContent: string;
  readonly body: string;
  readonly frontmatter: Readonly<Record<string, unknown>> & {
    readonly tags: readonly string[];
  };
  readonly wikilinks: readonly ExtractedWikilink[];
  readonly sha256: string;
  readonly byteSize: number;
  readonly mtimeMs: number;
  readonly frontmatterError: string | null;
};

export type WriteNoteRequest = {
  readonly vaultPath: string;
  readonly content: string;
  readonly actor: string;
  /**
   * 'no-overwrite' (default): writes `Stem (2).ext` if `vaultPath` exists.
   * 'compare-and-swap': overwrites ONLY when existing file's SHA-256 matches `expectedSha256`.
   */
  readonly writeMode?: 'no-overwrite' | 'compare-and-swap' | undefined;
  readonly expectedSha256?: string | undefined;
};

export type WriteNoteResult = {
  readonly vaultPath: string;
  readonly sha256: string;
  readonly previousSha256: string | null;
  readonly createdCopy: boolean;
  readonly byteSize: number;
};

export type AppendNoteRequest = {
  readonly vaultPath: string;
  readonly appendText: string;
  readonly actor: string;
  readonly expectedSha256?: string | undefined;
};

export type PromoteToCanonicalRequest = {
  readonly approvalId: string;
  readonly targetVaultPath: string;
  readonly title: string;
  readonly body: string;
  readonly domain: Domain | string;
  readonly tags?: readonly string[] | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly readOnlyOnDisk?: boolean | undefined;
};

export type VaultEngineContract = {
  readonly vaultRoot: string;
  readonly readNote: (relPath: string) => Promise<VaultNoteDocument>;
  readonly writeNote: (req: WriteNoteRequest) => Promise<WriteNoteResult>;
  readonly appendNote: (req: AppendNoteRequest) => Promise<WriteNoteResult>;
  readonly promoteToCanonical: (req: PromoteToCanonicalRequest) => Promise<WriteNoteResult>;
  readonly scanVault: (options?: { readonly full?: boolean | undefined }) => Promise<VaultScanSummary>;
  readonly search: (
    query: string,
    options?: { readonly sector?: string | undefined; readonly limit?: number | undefined },
  ) => readonly IndexEntryRecord[];
  readonly resolveLinks: (vaultPath: string) => {
    readonly outgoing: readonly string[];
    readonly backlinks: readonly string[];
  };
};
```

---

## 3. Agent Registry Contract (`core/agent-registry/`)

```ts
export type AgentDefinition = {
  readonly name: string;
  readonly class: AgentClass;
  readonly domain: Domain;
  readonly description: string;
  readonly model: string;
  readonly capabilities: readonly Capability[];
  readonly tools: readonly string[];
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly instructions: string;
  readonly filePath: string;
};

export type ValidationFailure = {
  readonly path: string;
  readonly errors: readonly string[];
};

export type RegistrySnapshot = {
  readonly agents: readonly AgentDefinition[];
  readonly failures: readonly ValidationFailure[];
  readonly skipped: readonly string[];
};

export type AgentRegistryContract = {
  readonly list: () => readonly AgentDefinition[];
  readonly get: (name: string) => AgentDefinition | undefined;
  readonly validateAll: () => readonly ValidationFailure[];
  readonly refresh: () => RegistrySnapshot;
  readonly snapshot: () => RegistrySnapshot;
};
```

---

## 4. Tool Registry Contract (`core/tool-registry/`)

```ts
export const CAPABILITIES = [
  'context.read',
  'log.write',
  'web.read',
  'research.write',
  'research.read',
  'candidate.propose',
  'plan.write',
  'artifact.write',
  'artifact.read',
  'critique.write',
  'critique.read',
  'catalog.read',
  'catalog.write',
  'trace.write',
  'vault.write',
  'vault.read',
  'task.write',
  'feedback.write',
  'external.execute',
  'governance.flag',
  'canonical.write',
  'approval.decide',
  'audit.write',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type ToolContext = {
  readonly runId: string;
  readonly agentName: string;
  readonly researchRunId?: string | undefined;
  readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
};

export type Tool = {
  readonly name: string;
  readonly capability: Capability;
  readonly description: string;
  readonly handler: (ctx: ToolContext, args: unknown) => Promise<unknown>;
};

export type Authorization =
  | { readonly allow: true; readonly capability: Capability }
  | { readonly allow: false; readonly reason: string };

export type ToolRegistryContract = {
  readonly get: (name: string) => Tool | undefined;
  readonly list: () => readonly Tool[];
  readonly authorize: (agentClass: AgentClass, toolName: string) => Authorization;
};
```

---

## 5. Context Engine Contract (`core/context-engine/`)

```ts
export type ContextCorpus = 'knowledge' | 'vault';

export type ContextItem = {
  readonly id: string;
  readonly kind: 'canonical_prompt' | 'source' | 'vault_note' | 'artifact' | 'finding';
  readonly title: string;
  readonly body: string;
  readonly vaultPath?: string | undefined;
  readonly sha256: string;
  readonly score: number;
  readonly reason: string;
  readonly modelScope?: string | null | undefined;
};

export type ContextBundle = {
  readonly query: string;
  readonly corpus: ContextCorpus;
  readonly items: readonly ContextItem[];
  readonly cached: boolean;
  readonly retrievedAt: string;
};

export type ContextEngineContract = {
  readonly retrieve: (
    query: string,
    options?: {
      readonly corpus?: ContextCorpus | undefined;
      readonly limit?: number | undefined;
      readonly scope?: { readonly modules: readonly string[] } | undefined;
      readonly modelScope?: string | undefined;
    },
  ) => Promise<ContextBundle>;
  readonly readClaims: (
    topicPrefix: string,
    options?: { readonly modelScope?: string | undefined },
  ) => Promise<ReadonlyArray<{
    readonly topic: string;
    readonly value: unknown;
    readonly modelScope: string;
    readonly sourceRef: string;
    readonly version: number;
  }>>;
};
```

---

## 6. Workflow Engine Contract (`core/workflow-engine/`)

```ts
export type WorkflowStepSpec = {
  readonly id: string;
  readonly agent: string;
  readonly dependsOn: readonly string[];
  readonly input: Readonly<Record<string, unknown>>;
};

export type WorkflowSpec = {
  readonly name: string;
  readonly description: string;
  readonly requiredInput: readonly string[];
  readonly optionalInput: readonly string[];
  readonly steps: readonly WorkflowStepSpec[];
  readonly output: Readonly<Record<string, unknown>>;
};

export type LoadedWorkflow = WorkflowSpec & {
  readonly path: string;
  readonly sha256: string;
};

export type WorkflowResult = {
  readonly workflowRunId: string;
  readonly status: 'success' | 'error';
  readonly output?: unknown;
  readonly failedStep?: string | undefined;
  readonly error?: string | undefined;
  readonly skippedSteps: readonly string[];
  readonly steps: ReadonlyArray<{
    readonly stepId: string;
    readonly agentRunId: string;
    readonly status: 'success' | 'error';
  }>;
};

export type WorkflowEngineContract = {
  readonly loadWorkflow: (path: string, registry: AgentRegistryContract) => LoadedWorkflow;
  readonly compileWorkflow: (source: string, registry: AgentRegistryContract, label: string) => LoadedWorkflow;
  readonly runWorkflow: (
    wf: LoadedWorkflow,
    input: Readonly<Record<string, unknown>>,
    options?: { readonly timeoutMs?: number | undefined; readonly researchRunId?: string | undefined },
  ) => Promise<WorkflowResult>;
};
```

---

## 7. Orchestrator & JARVIS Core Contract (`core/orchestrator/`, `core/src/jarvis/`)

```ts
export type RoutableDomain = 'RESEARCH_INTELLIGENCE' | 'RECORDS' | 'TECH' | 'GOVERNANCE';

export type DispatchResult = {
  readonly runId: string;
  readonly agentName: string;
  readonly status: 'success' | 'error';
  readonly output?: unknown;
  readonly error?: string | undefined;
  readonly tokensUsed: number;
  readonly latencyMs: number;
};

export type JarvisSource = 'cli' | 'http' | 'voice';

export type JarvisStatus =
  | 'OK'
  | 'ERROR'
  | 'HOLD'
  | 'CLARIFY'
  | 'BLOCKED'
  | 'PENDING_HUMAN_APPROVAL';

export type JarvisRequest =
  | {
      readonly type: 'ask';
      readonly request: string;
      readonly domain?: RoutableDomain | undefined;
      readonly workflow?: string | undefined;
      readonly projectSlug?: string | undefined;
    }
  | { readonly type: 'dispatch'; readonly agent: string; readonly input: unknown }
  | {
      readonly type: 'workflow';
      readonly path: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | { readonly type: 'canonical-write'; readonly candidateId: string }
  | {
      readonly type: 'propose-split';
      readonly trackId: string;
      readonly splits: ReadonlyArray<{ readonly payee: string | null; readonly percentage: number }>;
      readonly reason: string;
      readonly proposer?: string | undefined;
    }
  | { readonly type: 'apply-split'; readonly approvalId: string };

export type JarvisResult = {
  readonly status: JarvisStatus;
  readonly summary: string;
  readonly source: JarvisSource;
  readonly approvalIds?: readonly string[] | undefined;
  readonly data?: unknown;
};

export type OrchestratorContract = {
  readonly dispatch: (
    agentName: string,
    input: unknown,
    options?: {
      readonly jobId?: string | undefined;
      readonly stepId?: string | undefined;
      readonly timeoutMs?: number | undefined;
    },
  ) => Promise<DispatchResult>;
  readonly interceptAndExecute: (source: JarvisSource, req: JarvisRequest) => Promise<JarvisResult>;
};
```

---

## 8. Model Gateway Contract (`core/llm/`)

```ts
export type LlmMessage = {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
};

export type LlmCompletionRequest = {
  readonly modelRef: string; // e.g. 'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free' | 'anthropic:claude-3-7-sonnet'
  readonly messages: readonly LlmMessage[];
  readonly outputSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly timeoutMs?: number | undefined;
};

export type LlmCompletionResponse = {
  readonly modelServed: string;
  readonly text: string;
  readonly structured?: unknown;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
};

export type ModelGatewayContract = {
  readonly complete: (req: LlmCompletionRequest) => Promise<LlmCompletionResponse>;
};
```

---

## 9. Runtime Store Contract (`core/sqlite/client.ts`)

```ts
export type ApprovalItemType =
  | 'knowledge_candidate'
  | 'split_proposal'
  | 'artifact_version'
  | 'critique_escalation'
  | 'rd_backlog_item'
  | 'vault_promotion';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type PendingApprovalRecord = {
  readonly id: string;
  readonly itemType: ApprovalItemType;
  readonly itemId: string;
  readonly status: ApprovalStatus;
  readonly request: Record<string, unknown>;
  readonly proposer: string;
  readonly approver: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
};

export type RuntimeStoreContract = {
  readonly dbPath: string;
  readonly close: () => void;
  // 1. Agent runs
  readonly startAgentRun: (input: StartAgentRunInput) => AgentRunRecord;
  readonly completeAgentRun: (id: string, input: CompleteAgentRunInput) => AgentRunRecord;
  readonly failAgentRun: (id: string, input: FailAgentRunInput) => AgentRunRecord;
  readonly getAgentRun: (id: string) => AgentRunRecord | null;
  readonly listAgentRuns: (limit?: number) => readonly AgentRunRecord[];
  // 2. Jobs
  readonly enqueueJob: (input: {
    readonly id?: string | undefined;
    readonly kind: 'workflow' | 'research' | 'ingest' | 'index' | 'task';
    readonly name: string;
    readonly specSha256?: string | null | undefined;
    readonly input?: unknown;
    readonly startImmediately?: boolean | undefined;
  }) => JobRecord;
  readonly startJob: (id: string) => JobRecord;
  readonly completeJob: (id: string, output: unknown, skippedSteps?: readonly string[]) => JobRecord;
  readonly failJob: (id: string, errorDetail: string, failedStep?: string | null) => JobRecord;
  readonly getJob: (id: string) => JobRecord | null;
  readonly listJobs: (limit?: number) => readonly JobRecord[];
  // 3. Cooperative Locks
  readonly acquireLock: (resourceKey: string, ownerId: string, ttlMs?: number) => boolean;
  readonly releaseLock: (resourceKey: string, ownerId: string) => boolean;
  readonly getLock: (resourceKey: string) => LockRecord | null;
  // 4. Operator Sessions
  readonly upsertSession: (input: {
    readonly id: string;
    readonly operatorId?: string | undefined;
    readonly source: 'cli' | 'http' | 'voice' | 'ui';
    readonly activeSector?: string | null | undefined;
    readonly selectedJobId?: string | null | undefined;
    readonly exchanges?: readonly unknown[] | undefined;
  }) => SessionRecord;
  readonly appendSessionExchange: (
    sessionId: string,
    exchange: unknown,
    maxExchanges?: number,
    source?: 'cli' | 'http' | 'voice' | 'ui',
  ) => SessionRecord;
  readonly getSession: (id: string) => SessionRecord | null;
  // 5. Append-Only Runtime & Audit Events
  readonly appendEvent: (input: {
    readonly eventType: string;
    readonly domain: string;
    readonly actor: string;
    readonly targetPath?: string | null | undefined;
    readonly payload?: Record<string, unknown> | undefined;
    readonly checksumSha256?: string | null | undefined;
  }) => RuntimeEventRecord;
  readonly listEvents: (options?: {
    readonly afterId?: number | undefined;
    readonly eventType?: string | undefined;
    readonly limit?: number | undefined;
  }) => readonly RuntimeEventRecord[];
  // 6. Pending Human Approvals
  readonly queueApproval: (input: {
    readonly id?: string | undefined;
    readonly itemType: ApprovalItemType;
    readonly itemId: string;
    readonly request: Record<string, unknown>;
    readonly proposer: string;
  }) => PendingApprovalRecord;
  readonly decideApproval: (input: {
    readonly approvalId: string;
    readonly decision: 'approved' | 'rejected';
    readonly approver: string;
    readonly reason: string;
  }) => PendingApprovalRecord;
  readonly getApproval: (id: string) => PendingApprovalRecord | null;
  readonly listApprovals: (status?: ApprovalStatus) => readonly PendingApprovalRecord[];
  // 7. Disposable Structural Index State
  readonly upsertIndexEntry: (entry: UpsertIndexEntryInput) => IndexEntryRecord;
  readonly removeIndexEntry: (vaultPath: string) => boolean;
  readonly getIndexEntry: (vaultPath: string) => IndexEntryRecord | null;
  readonly searchIndex: (
    query: string,
    options?: { readonly sector?: string | undefined; readonly limit?: number | undefined },
  ) => readonly IndexEntryRecord[];
  readonly getIndexStats: () => {
    readonly totalFiles: number;
    readonly bySector: Readonly<Record<string, number>>;
  };
};
```

---

## 10. Promotion Gate Contract (`knowledge/promotion-gate/`)

```ts
export type PromotionGateOutcome = 'pending_approval' | 'promoted' | 'blocked' | 'rejected';

export type PromotionGateRunResult = {
  readonly promotionRunId: string;
  readonly candidateId: string;
  readonly outcome: PromotionGateOutcome;
  readonly reasons: readonly string[];
  readonly confidence: number;
  readonly threshold: number;
  readonly approvalId?: string | undefined;
  readonly promotedVaultPath?: string | undefined;
  readonly promotedSha256?: string | undefined;
};

export type PromotionGateContract = {
  readonly evaluateCandidate: (candidateId: string) => Promise<PromotionGateRunResult>;
  readonly executeApprovedPromotion: (approvalId: string) => Promise<PromotionGateRunResult>;
};
```

---

## 11. Knowledge Index Contract (`core/vault-engine/`, `knowledge/knowledge-graph/`)

```ts
export type VaultScanSummary = {
  readonly scannedFiles: number;
  readonly indexedFiles: number;
  readonly unchangedFiles: number;
  readonly removedFiles: number;
  readonly errors: ReadonlyArray<{ readonly path: string; readonly error: string }>;
  readonly durationMs: number;
};

export type IndexEntryRecord = {
  readonly vaultPath: string;
  readonly sector: string;
  readonly fileExt: string;
  readonly byteSize: number;
  readonly mtimeMs: number;
  readonly sha256: string;
  readonly title: string;
  readonly domain: string | null;
  readonly docType: string | null;
  readonly status: string | null;
  readonly tags: readonly string[];
  readonly wikilinks: readonly ExtractedWikilink[];
  readonly frontmatter: Record<string, unknown>;
  readonly frontmatterError: string | null;
  readonly indexedAt: string;
};

export type KnowledgeIndexContract = {
  readonly scanVault: (options?: { readonly full?: boolean | undefined }) => Promise<VaultScanSummary>;
  readonly search: (
    query: string,
    options?: { readonly sector?: string | undefined; readonly limit?: number | undefined },
  ) => readonly IndexEntryRecord[];
  readonly resolveLinks: (vaultPath: string) => {
    readonly outgoing: readonly string[];
    readonly backlinks: readonly string[];
  };
};
```

---

## 12. UI API Layer Contract (`127.0.0.1:8077` ↔ `UI-xyp3rn/lib/gateway.ts`)

| Endpoint | Method | Request Payload / Query | Response Payload |
|---|---|---|---|
| `/api/health` | `GET` | — | `{ ok: true, service: 'xyp3rn-os3-gateway', vaultRoot: string, sqlitePath: string, agentsCount: number, pendingApprovals: number, indexStats: { totalFiles: number, bySector: Record<string, number> } }` |
| `/api/jarvis` | `POST` | `{ prompt: string, engine?: 'claude-code-cli' \| 'gemini-api', activeSector?: DepartmentId, selectedJobId?: string \| null, sessionId?: string }` | `{ ok: boolean, reply: string, commandKind: string, engine: EngineId, connectorCount: number, connectorHealthy: number, action?: GatewayAction, runId?: string, jobId?: string, approvalId?: string, vaultPath?: string, sha256?: string }` |
| `/api/music/pulse` | `GET` | `?track=<id>&t=<sec>&bpm=<n>` | `{ ok: true, track: string, t: number, spectrum: number[] }` (24 values in `[0.1, 1.0]`) |
| `/api/vault/note` | `GET` | `?path=<vaultRelPath>` | `{ ok: true, note: VaultNoteDocument, links: { outgoing: string[], backlinks: string[] } }` |
| `/api/vault/search` | `GET` | `?q=<query>&sector=<sector>&limit=<n>` | `{ ok: true, query: string, count: number, hits: IndexEntryRecord[] }` |
| `/api/approvals` | `GET` | `?status=pending\|approved\|rejected` | `{ ok: true, count: number, approvals: PendingApprovalRecord[] }` |
| `/api/approvals/decide` | `POST` | `{ approvalId: string, decision: 'approved' \| 'rejected', approver: string, reason: string }` | `{ ok: true, approval: PendingApprovalRecord, promotedNote: WriteNoteResult \| null }` |
| `/api/events` | `GET` | `?afterId=<n>&limit=<n>` | `{ ok: true, count: number, events: RuntimeEventRecord[] }` |
| `/api/runs` | `GET` | `?limit=<n>` | `{ ok: true, agentRuns: AgentRunRecord[], jobs: JobRecord[] }` |
