# XYP3RN OS 3.0 + DAW Brain — Secure Vault Engine (`VaultEngine`, Phase 04)

**Status:** Phase 04 Implementation Delivered  
**Package Root:** [core/vault-engine/](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/engine.ts)  
**Primary Authority Rule:** Every runtime read, index query, draft mutation, conflict resolution, revision restore, and canonical promotion from OS3 and DAW Brain subsystems MUST flow through `VaultEngine` (and `VaultPromotionGate` for canonical paths).

---

## 1. Architecture & Module Responsibilities

| Module | Responsibility |
|---|---|
| [vault-engine.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/vault-engine.ts) | `VaultEngine` facade exposing all 13 contract operations + conflict resolution + history verification + full incremental/full Vault scanning |
| [path-guard.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/path-guard.ts) | Lexical Vault root containment, allowed sectors (`OS3_VAULT_DIRS` + `VAULT_SECTORS`), allowed extensions, `CANONICAL_PATH_PREFIXES`, `resolveNoOverwritePath` |
| [path-resolver.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/path-resolver.ts) | `resolveVaultPathSync` + async `assertNoSymlinkEscape` (`lstat` + `realpath` segment-by-segment check against symlinks and Windows junctions) |
| [vault-config.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/vault-config.ts) | `createVaultConfig`, `DEFAULT_WRITABLE_SECTORS`, `VaultPermissionChecker`, `readOnly` policy, `assertVaultPermission` |
| [reader.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/reader.ts) & [search.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/search.ts) | Controlled `read`, `readMetadata`, derived SQLite `list`, and `search` operations |
| [writer.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/writer.ts) | Lock-first `executeControlledWrite`, `executeControlledUpdate`, `executeControlledAppend`, `commitValidatedNote`, canonical blocking, entity ID immutability |
| [frontmatter.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/frontmatter.ts) & [schema-validator.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/schema-validator.ts) | Strict/lenient YAML parsing, NUL-byte corruption rejection, secret redaction/detection, 32-schema + archive/supersession validation |
| [revision.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/revision.ts) & [version-manager.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/version-manager.ts) | `writeFileAtomic` (temp file + `fsync` + atomic rename + error cleanup), `.vault-revisions/` SHA-256 content-addressed blobs, JSONL history, `verifyRevisionHistory`, snapshots |
| [transaction-manager.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/transaction-manager.ts) | In-process + SQLite `locks` mutex (`withPathLock`), external Obsidian edit detection (`inspectAndGuardDiskState`), atomic multi-file rollback (`executeAtomicBatch`) |
| [conflict-resolver.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/conflict-resolver.ts) | `inspectVaultConflict` & safe `resolveVaultConflict` (`keep-disk`, `save-fork`, `accept-proposed`) |
| [promotion-gate.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/promotion-gate.ts) | `VaultPromotionGate` — sole canonical writer requiring human `approved` decision, non-self approval, provenance/evidence/confidence >= 0.70, and optional CAS `expectedSha256` |
| [links.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/links.ts) | Broken-reference detection, canonical Obsidian `[[target|alias]]` appending, outgoing & backlink resolution |
| [watcher.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/watcher.ts) & [audit.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/audit.ts) | External Obsidian edit sync (`reconcileExternalEdit`) and immutable `vault.audit` logging in SQLite (`runtime_events`) |
| [errors.ts](file:///C:/Users/blago/Desktop/oss2/officialFolderofXYP3RNOS/core/vault-engine/errors.ts) | Typed error classes (`VaultPathSecurityError`, `VaultPermissionError`, `VaultConflictError`, `VaultValidationError`, `VaultNotFoundError`) |

---

## 2. Controlled API Operations (All 13 Core Operations + Extensions)

| Operation | Signature Summary | Security / Concurrency / Audit Behavior |
|---|---|---|
| `read(relPath, actor)` | Returns full `VaultNoteDocument` (`rawContent`, `body`, `frontmatter`, `sha256`, `frontmatterError`) | Symlink & containment check, `assertVaultPermission`, emits `read` audit |
| `readMetadata(relPath, actor)` | Returns lightweight `VaultNoteMetadata` | Same guards + emits `readMetadata` audit |
| `list(options, actor)` | Filters derived SQLite `index_state` by `sector`, `domain`, `docType`, `status`, `tag`, `prefix` | Permission check + emits `list` audit |
| `search(query, options, actor)` | Full-text / metadata query over derived SQLite index | Permission check + emits `search` audit |
| `write(req)` | Creates non-canonical notes (`no-overwrite` default creates `(2)` copy, `reject-overwrite`, or `compare-and-swap`) | Path lock acquired BEFORE disk check (no TOCTOU race), canonical block, schema/NUL check, atomic write, revision blob, index update, `vault.write` + `write` audit |
| `update(req)` | Updates existing non-canonical note requiring `expectedSha256` | CAS checksum guard, external edit preservation, stable entity ID immutability (`ENTITY_ID_MUTATION_FORBIDDEN`), atomic write, `update` audit |
| `append(req)` | Appends Markdown text to non-canonical note (optional `expectedSha256`) | Re-validates complete combined document before committing, `vault.append` + `append` audit |
| `validate(vaultPath, options)` | Validates YAML, NUL corruption, secret hygiene, `v3` schemas, metadata, archive/supersession rules, optional wikilink checks | Does not mutate disk; emits `validate` audit (`success` / `invalid`) |
| `link(req)` | Appends verified `[[target|alias]]` wikilink after verifying target exists on disk or in index | Blocks `BROKEN_REFERENCE`, blocks canonical source mutations, uses CAS `update()`, emits `link` audit |
| `backlinks(vaultPath, actor)` | Resolves incoming wikilinks (`resolveLinks()` returns both `outgoing` and `backlinks`) | Permission check + emits `backlinks` audit |
| `history(vaultPath, actor)` | Lists ordered immutable revisions from `.vault-revisions/history/*.jsonl` (`verifyHistory()` verifies JSONL & SHA-256 blobs) | Permission check + emits `history` audit |
| `snapshot(label, actor)` | Writes immutable point-in-time `VaultSnapshotManifest` JSON (works even if SQLite is offline via disk fallback) | Permission check + emits `snapshot` audit |
| `promote(req)` | **Sole canonical writer** via `VaultPromotionGate` | Requires existing human `approved` decision (`approver !== proposer`, non-agent identity), provenance/evidence/confidence `>= 0.70`, path lock, optional `expectedSha256`, optional `chmod 0o444`, emits `vault.promoted` + `promote` audit |
| `restore(req)` | Restores a non-canonical file to a prior `targetSha256` | Verifies `sha256Hex(blob) === targetSha256` (rejects corrupted blobs), validates `.md` YAML/NUL before write, records restore as a new forward revision |
| `inspectConflict` & `resolveConflict` | Detects `checksum_mismatch` / `external_obsidian_edit` / `corrupted_document` / `missing_on_disk` and resolves safely | Supports `keep-disk`, `save-fork`, and CAS `accept-proposed` (archives overwritten disk content to `.vault-revisions/` first) |

---

## 3. Security, Concurrency, Corruption & Conflict Guarantees

1. **Root Containment & Symlink Escape Prevention:** Rejects `..`, `.`, leading `/` or `\`, Windows drive prefixes, backslashes, `//`, NUL bytes in paths, hidden files (`.obsidian`, `.env`, `.vault-revisions`), unregistered sectors, disallowed extensions, and any symlink or Windows junction whose resolved `realpath` escapes `realpath(vaultRoot)`.
2. **Permission Policies:**
   - Default non-writable directory: `00_SYSTEM` (`DISALLOWED_DIRECTORY`).
   - Protected canonical prefixes (`CANONICAL_PATH_PREFIXES`): `CANONICAL_WRITE_FORBIDDEN` for `write`, `update`, `append`, `link`, `restore`, `resolveConflict(accept-proposed)`, or frontmatter declaring `status: canonical` outside `promote()`.
   - Actor & instance controls (`vault-config.ts`): mutating operations require non-empty `actor`; `readOnly: true` blocks all mutations; optional `authorize(ctx)` enforces per-actor/per-sector ACLs cleanly.
3. **Atomic Durability & Interrupted-Write Safety (`revision.ts`):**
   - `writeFileAtomic()` writes to `.tmp-<pid>-<uuid>` in the destination directory, opens & `sync()`s the descriptor, optionally executes test hooks (`onBeforeRename`), performs atomic `rename()` with bounded backoff on Windows `EBUSY`/`EPERM`/`EACCES`, and guarantees temp-file deletion on any failure.
   - Multi-file changes via `VaultTransactionManager.executeAtomicBatch()` snapshot prior file contents in memory and roll back in reverse order on failure.
4. **Optimistic Concurrency & Pessimistic Locks (`writer.ts`, `transaction-manager.ts`):**
   - Acquire both per-path in-process `Set` lock and SQLite `locks` row (`ttlMs`) BEFORE inspecting disk state in `executeControlledWrite()`, `executeControlledUpdate()`, `executeControlledAppend()`, `restore()`, `promote()`, and `resolveConflict()`.
   - External modifications made directly inside Obsidian are detected by comparing live disk SHA-256 against `index_state`, automatically archived under `.vault-revisions/` as `operation: "external-sync"`, and reported as `EXTERNAL_OBSIDIAN_EDIT` so user edits are never overwritten silently.
5. **Structured Error Hierarchy (`errors.ts`):**
   - `VaultPathSecurityError`: `PATH_TRAVERSAL`, `SYMLINK_ESCAPE`, `DISALLOWED_DIRECTORY`, `DISALLOWED_EXTENSION`, `ABSOLUTE_PATH_FORBIDDEN`
   - `VaultPermissionError`: `CANONICAL_WRITE_FORBIDDEN`, `UNAUTHORIZED_ACTOR`, `SELF_APPROVAL_FORBIDDEN`
   - `VaultConflictError`: `CHECKSUM_MISMATCH`, `SILENT_OVERWRITE_FORBIDDEN`, `EXTERNAL_OBSIDIAN_EDIT`, `LOCK_BUSY`
   - `VaultValidationError`: `INVALID_YAML`, `INVALID_SCHEMA`, `INVALID_METADATA`, `INVALID_ARCHIVE_OR_SUPERSESSION`, `MISSING_ENTITY_ID`, `ENTITY_ID_MUTATION_FORBIDDEN`, `BROKEN_REFERENCE`, `MISSING_PROVENANCE`, `INSUFFICIENT_EVIDENCE`, `SECRET_DETECTED`
   - `VaultNotFoundError`: `NOTE_NOT_FOUND`, `REVISION_NOT_FOUND`, `APPROVAL_NOT_FOUND`

---

## 4. Operational Runbook & Conflict Resolution

### Handling Write / Obsidian Conflicts (`CHECKSUM_MISMATCH` / `EXTERNAL_OBSIDIAN_EDIT`)
1. Call `const conflict = await vault.inspectConflict(vaultPath, expectedSha256, actor)` to inspect `kind`, `diskSha256`, `indexedSha256`, and `diskFrontmatterError`.
2. Choose one of three lossless resolution paths via `await vault.resolveConflict(...)`:
   - `strategy: 'keep-disk'` — accept the live disk / Obsidian version and reconcile `index_state` + revision history.
   - `strategy: 'save-fork'` — write the competing `proposedContent` to a numbered sibling copy (`Note (2).md`) while leaving disk untouched.
   - `strategy: 'accept-proposed'` — supply `expectedDiskSha256: conflict.diskSha256` + `proposedContent`; `VaultEngine` archives the prior disk content into `.vault-revisions/` first, then swaps atomically.

### Recovering Corrupted Notes & Auditing Revisions
- Inspect document health via `await vault.validate(vaultPath, { checkReferences: true })` and revision integrity via `await vault.verifyHistory(vaultPath)`.
- Roll back to a verified prior revision `sha256` with `await vault.restore({ vaultPath, targetSha256, actor, reason })`; `VaultEngine` re-hashes `.vault-revisions/<xx>/<sha256>.blob` and rejects any tampered or corrupted blob (`CHECKSUM_MISMATCH`).
- Review full operation lineage via `vault.listAuditLog({ filePath, actor, operation, result, limit })`.

### Verification Command
```powershell
pnpm.cmd typecheck
pnpm.cmd vitest run tests/os3-phase4-vault-engine/vault-engine-full.test.ts tests/os3-phase1/vault-engine.test.ts tests/os3-phase12-security/security-governance-adversarial.test.ts
```
