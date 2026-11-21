# XYP3RN OS 3.0 — Knowledge Engine & Context Engine

Canonical Phase 06 reference covering the Knowledge Engine, multi-domain Knowledge Graph, Structural & Semantic Indexes, ACL-aware Context Engine, and DAW Brain Context assembly.

## 1. Architectural Invariants

- **Obsidian-First Canonical Authority:** Markdown notes under the configured Obsidian Vault remain the sole canonical source of truth. SQLite `index_state` and semantic vector entries are disposable, fully rebuildable caches derived from disk.
- **No Unapproved Writes:** Promotion into canonical prefixes (`CANONICAL_PATH_PREFIXES`) is blocked outside `VaultPromotionGate` (`VaultEngine.promote()` / `Os3KnowledgeEngine.promoteCandidate()`), which requires human approval (`pending_approvals`), blocks self-approval, and verifies provenance/evidence metadata.
- **Live vs. Stored Knowledge Separation:** DAW runtime observations (`liveObserved` telemetry or SQLite `daw_sessions.cachedSnapshot`) are quarantined inside `DawContextPackage.liveObservation` with `isLiveEphemeral: true`, `authoritativeForKnowledge: false`, and `persistedInVault: false`. They never impersonate saved `.flp`/Vault project state or canonical knowledge.

---

## 2. Knowledge Engine (`core/knowledge-engine/`)

Primary class: `Os3KnowledgeEngine` (`core/knowledge-engine/knowledge-engine.ts`), exported via `core/knowledge-engine/index.ts`.

### Capabilities

| Area | Methods / Components | Behavior |
| :--- | :--- | :--- |
| Markdown & Metadata Validation | `parseMarkdown()`, `validateDocument()` | Parses YAML frontmatter without mutating content and delegates schema/secret/ID checks to `VaultEngine.validate()`. |
| Knowledge Graph Construction | `getGraph(forceRebuild?)` (`Os3KnowledgeGraph`) | Compiles Vault index entries into nodes and typed edges, auto-invalidating when `index_state` `(vaultPath, sha256)` changes. |
| Entity Resolution | `resolveEntity(idOrPathOrAlias)` | Resolves deterministically in priority order: `entity_id` -> `vault_path` (extension-insensitive) -> `alias` (`aliases`, `name`, `slug`, `decision_key`, `capability_id`, `adapter_id`, `isrc`, `upc`) -> `title`, surfacing `ambiguousMatches` when multiple entities collide. |
| Relationships & Backlinks | `extractRelationships()`, `getBacklinks()` | Extracts outgoing typed edges, incoming edges, unresolved target references (`unresolved:*`), and Vault backlinks. |
| Search & Time Queries | `search(query, options)` | Supports `domain`, `sector`, `docType`, `entityKind`, `status`, `tags`, ISO `updatedAfter`/`updatedBefore`/`createdAfter`/`createdBefore`, and `sortBy: 'relevance' \| 'recency'`. |
| Duplicate Detection | `detectDuplicates(sector?)` | Detects duplicate `id` values across files (`duplicateEntityIds`), byte-identical `.md` SHA-256 checksums (`exactContentDuplicates`), and colliding normalized `(title, docType)` pairs (`titleCollisions`). |
| Provenance Resolution | `getProvenance(idOrPath)` | Combines frontmatter `source_ref`/`source_refs`, `evidence_ids`, `approval_id`, `approved_by`, `promoted_via`, `superseded_by`, `archived_from`, and 2-hop upstream graph nodes (`cites_source`, `backed_by_evidence`, `approved_by`, `variant_of`). |
| Document Lifecycle | `validateLifecycleTransition()`, `archiveDocument()`, `supersedeDocument()`, `promoteCandidate()` | Enforces allowed status transitions, prevents archived resurrection, routes canonical promotions through `VaultPromotionGate`, and routes retirement/supersession through explicit `12_ARCHIVE` workflows. |
| Index Rebuild | `rebuildIndexes(options?)` | Executes `Os3StructuralIndex.rebuildFromScratch()`, optional `Os3SemanticIndex.rebuild()`, and forces a fresh `Os3KnowledgeGraph`. |

### Knowledge Graph Entity Kinds & Edge Types (`core/knowledge-engine/types.ts`)

`classifyKnowledgeEntityKind()` maps every Vault note using frontmatter `schema`, `type` (`docType`), and sector into:

- **Core & Knowledge:** `knowledge`, `research`, `agent`, `tool`, `workflow`, `governance`, `entity`
- **X3LIUS Records:** `song`, `release`
- **DAW Brain:** `production_session`, `daw_adapter`, `plugin`, `audio_analysis`, `dsp_concept`

Typed relations (`KnowledgeRelationType`): `wikilink`, `cites_source`, `backed_by_evidence`, `belongs_to_project`, `variant_of`, `uses_tool`, `runs_agent`, `implements_capability`, `targets_adapter`, `uses_plugin`, `analyzes_session`, `backed_by_analysis`, `references_dsp`, `part_of_release`, `targets_song`, `belongs_to_lineage`, `approved_by`, `governs_item`, `superseded_by`, `archived_from`, `depends_on`.

---

## 3. Structural & Semantic Indexes (`core/context-engine/`)

- **`Os3StructuralIndex` (`structural-index.ts`):**
  - Builds in-memory entity nodes directly from SQLite `index_state` and exposes `version`, `createdAt`, `updatedAt`, `wikilinks`, `backlinks`, and `dependencies`.
  - Maintains an in-memory body cache keyed by `(vaultPath, sha256)` (`maxBodyScans` default `1500`) so full-text search scans actual Markdown bodies across large filtered corpora without adding forbidden SQLite FTS virtual tables (preserving `SqliteRuntimeDb.checkIntegrity()` table allowlists).
  - `detectStaleEntries()`, `reconcileWithVault()`, and `rebuildFromScratch()` repair renames (matching deleted+added SHA-256 pairs), external edits, and missing index rows from disk.
- **`Os3SemanticIndex` (`semantic-index.ts`):**
  - Computes and persists embedding vectors keyed by file SHA-256 (`createLocalDeterministicEmbedder` offline fallback or Transformers embedder). Skips unchanged files incrementally and rebuilds cleanly from canonical Vault files.

---

## 4. Context Engine & Packages (`core/context-engine/os3-context-engine.ts`)

`Os3ContextEngine.retrieveContext(query, options)` merges structural matches, semantic vector matches, and bounded graph relationship expansion (`relationshipDepth`, 1..3 hops), enforces caller ACL policies (`VaultEngine.config.authorize`), deduplicates by `entityId` and `checksum`, enforces `tokenBudget`, and caches results keyed by `(query, options, actor, vaultGeneration, semanticModel)`.

Each `Os3RetrievedContextItem` provides:

- `entityId`, `filePath`, `title`, `domain`, `sector`, `status`, `docType`, `version`
- `relevantExcerpt`, `relevanceScore`, `relevanceReason`, `matchSource` (`structural` | `semantic` | `hybrid` | `relationship`)
- `provenance` (`sourceRef`, `approvalId`, `approvedBy`, `promotedVia`, `origin`)
- `checksum` (SHA-256)
- `permissionStatus` (`allowed_canonical` | `allowed_working` | `restricted_acl` | `read_only`)
- `epistemologicalClass` (`canonical_knowledge` | `working_draft` | `historical_record`)
- `createdAt`, `updatedAt`, `estimatedTokens`

Supported query filters: `domain`, `sector`, `status`, `docTypes`, `tags` (also parsed from `#tag` in query text), `updatedAfter`, `updatedBefore`, `createdAfter`, `createdBefore`, `sortBy` (`relevance` | `recency`), `actor`, `maxItems`, `tokenBudget`, `expandRelationships`, `relationshipDepth`, `bypassCache`.

---

## 5. DAW Brain Context Assembly (`core/context-engine/daw-context.ts`)

`Os3ContextEngine.retrieveDawContext(req)` (delegating to `buildDawContextPackage()`) assembles a token-budgeted `DawContextPackage` separating ephemeral state from persisted records:

1. **`liveObservation`:** Telemetry from live request input (`sourceTier: 'liveObserved'`) or SQLite `daw_sessions.cachedSnapshot` fallback (`sourceTier: 'cached_stale'`), always flagged `isLiveEphemeral: true`, `authoritativeForKnowledge: false`, `persistedInVault: false`.
2. **`projectMetadata`:** Active runtime `sessionId`, `adapterId`, `hostVersion`, `projectPath`, `savedSha256`, `matchesLiveState`, and linked project/session Vault notes.
3. **`pluginDocumentation`:** Retrieved `plugin`, `daw_plugin`, `plugin_chain`, `daw_plugin_chain`, `daw_adapter`, and `daw_capability` notes matching the query and active plugins.
4. **`productionKnowledge`:** `dsp_concept`, `production_workflow`, `knowledge`, and `canonical_prompt` records.
5. **`userApprovedPreferences`:** Preference/mix-reference notes strictly filtered so only verified `status: 'canonical' | 'approved'` records appear; unapproved `draft` or pending preferences are excluded.
6. **`historicalRecords`:** Past `production_session`, `audio_analysis`, `daw_session_report`, `song`, and `release` notes sorted by recency alongside recent SQLite `daw_command_journal` and `daw_audio_analyses` rows.
