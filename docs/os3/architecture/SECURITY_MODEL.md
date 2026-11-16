# XYP3RN OS 3.0 — Security Model & Governance Specification

**Status:** Phase 2 Architecture Freeze
**Security Principle:** Deny-by-Default, Single File Authority (`VaultEngine`), Human-in-the-Loop Promotion Gate (`F35 D2`), Localhost-Only Binding (`127.0.0.1`).

---

## 1. Filesystem Boundaries (`core/vault-engine/path-guard.ts`)

1. **Zero Unrestricted Agent Filesystem Access:**
   - Agents never receive raw `fs` handles or shell execution primitives. Every file read, write, append, or search must pass through `VaultEngine`.
2. **Path Traversal & Separator Enforcement (`validateVaultPath`):**
   - Rejects empty paths, null bytes (`\0`), absolute paths (`/`, `\`, `C:\`), backslashes (`\`), double slashes (`//`), `.` or `..` segments, and hidden segments (`.env`, `.git`, `.obsidian`, `.vault-revisions`).
   - Verifies via `path.resolve(vaultRoot, ...segments)` that the resolved absolute path remains strictly inside `vaultRoot`.
3. **Extension Allowlist (`ALLOWED_VAULT_EXTENSIONS`):**
   - Only `.md`, `.yaml`, `.yml`, `.json`, `.txt`, `.wav`, `.mp3`, `.flac`, `.png`, `.jpg`, `.jpeg`, `.pdf`, and `.canvas` are permitted. Executables (`.exe`, `.sh`, `.ps1`, `.bat`, `.cmd`, `.js`, `.ts`, `.py`) are rejected with `403 FORBIDDEN`.
4. **Canonical Sector Write Protection (`CANONICAL_PATH_PREFIXES`):**
   - `01_CORE/00_Identity/`, `01_CORE/01_System_Prompts/`, `02_KNOWLEDGE_LAYER/`, `06_GOVERNANCE/00_Policies/`, `06_GOVERNANCE/01_Standards/`, `06_GOVERNANCE/02_Access_Control/`, `canonical/`, and `ROOT_KB` are marked `isCanonical: true`.
   - `VaultEngine.writeNote()` and `VaultEngine.appendNote()` refuse all direct writes to `isCanonical: true` paths and log a `vault.write.denied` audit event in SQLite `runtime_events`.
   - Notes whose YAML frontmatter declares `status: canonical` or `domain: canonical` are likewise refused outside `promoteToCanonical()`.
5. **No-Overwrite & Compare-and-Swap Guards:**
   - Default write mode is `'no-overwrite'`: writing to an existing path creates a numbered sibling copy (`Note (2).md`, `Note (3).md`) via `resolveNoOverwritePath()`, preserving the original file untouched.
   - `'compare-and-swap'` mode requires `expectedSha256` to match the file's current SHA-256 on disk; any mismatch aborts the write and logs `vault.write.conflict`.

---

## 2. Agent & Tool Permission Matrix (`core/tool-registry/capabilities.ts`)

Every agent declares a single `class` (`AgentClass`), and every tool declares a single `capability` (`Capability`). `ToolRegistry.authorize(agentClass, toolName)` denies by default:

| Capability | Allowed Agent Classes | Purpose |
|---|---|---|
| `context.read` | All 8 classes | Retrieve ranked knowledge/vault context & canonical claims. |
| `log.write` | All 8 classes | Emit structured run logs. |
| `web.read` | `Research` | Fetch operator-approved URLs (`fetch_source`). |
| `research.write` | `Research` | Record verbatim-verified research evidence (`write_evidence`). |
| `research.read` | `Planning` | Read research evidence for R&D backlog synthesis. |
| `candidate.propose` | `Research` | Propose a `knowledge_candidate` (`status = 'proposed'`). |
| `plan.write` | `Planning` | Propose R&D backlog items (queued in `pending_approvals`). |
| `artifact.write` | `Creative`, `Revision` | Write versioned creative drafts (lyrics, structures, recipes). |
| `artifact.read` | `Creative`, `Critic`, `Revision`, `Execution`, `Governance` | Read creative artifact versions by ID. |
| `critique.write` | `Critic` | Write structured rubric critiques. |
| `critique.read` | `Critic`, `Revision`, `Governance` | Read critiques in the evaluation loop. |
| `catalog.read` | `Knowledge`, `Governance` | Read songs, releases, tracks, and rights splits. |
| `catalog.write` | `Execution` | Register tracks, releases, credits, platform links, and approved splits. |
| `trace.write` | `Execution` | Record `trace.analysis/v1` payloads (`tech-audio-tools`). |
| `vault.write` | `Execution` | Write non-canonical Vault notes (`vault-curator`, `records-songs`). |
| `vault.read` | `Knowledge`, `Creative`, `Execution` | Read Vault notes and lyric sheets. |
| `task.write` | `Execution` | Create/update tasks in `01_CORE/06_Tasks/` (`records-tasks`). |
| `feedback.write` | `Execution` | Record owner take ratings (`suno-submitter`). |
| `external.execute` | `Execution` | Execute explicit external adapter handoff (`manual` / `sunoapi`). |
| `governance.flag` | `Governance` | Flag rights-split or compliance violations (`records-rights-splits`). |
| `canonical.write` | **`[]` (No Agent Class)** | Reserved exclusively for `PromotionGate` (`promoteToCanonical`). |
| `approval.decide` | **`[]` (No Agent Class)** | Reserved exclusively for the human operator (`decideApproval`). |
| `audit.write` | **`[]` (No Agent Class)** | Reserved exclusively for runtime/DB audit triggers (`appendEvent`). |

---

## 3. Human Approval Requirements (`F35 D2` Invariant)

Nothing in XYP3RN OS 3.0 auto-approves. Explicit human operator decision (`status = 'approved'`, non-empty `approver` and `reason` in SQLite `pending_approvals`) is mandatory for:
1. **Canonical Knowledge Promotion (`knowledge_candidate` / `vault_promotion`):** Moving any finding, staged note, or rule into `02_KNOWLEDGE_LAYER/` or `canonical/`.
2. **Rights Split Changes (`split_proposal`):** Writing a new version of `rights_splits` (`propose-split` queues the full 100%-summed set; `apply-split` executes only after human approval and verifies version has not moved).
3. **Creative Artifact Approval (`artifact_version`):** Approving lyric versions, style recipes, and meta-tag sets before `build-suno-package` handoff (`xyp_suno_package_ready` gate).
4. **Critique Escalations (`critique_escalation`):** Resolving creative outputs that hit `MAX_REVISIONS = 3`, stall, or require studio mix adjustments (`F26`, `F27`).
5. **R&D Backlog Proposals (`rd_backlog_item`):** Reviewing Frontier Scanner R&D proposals (`F33 D4`).

Once a `pending_approvals` row leaves `'pending'`, `trg_pending_approvals_seal` permanently seals the row against any `UPDATE` or `DELETE`.

---

## 4. Secret Management

- **Zero Secrets in Vault or Frontend:** API keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `SUNO_API_KEY`, `XYP_TRACE_TOKEN`, `XYP_WHISPER_API_KEY`, `XYP_KOKORO_API_KEY`) are read exclusively by the local Node.js runtime from `process.env` / `.env` (which is gitignored).
- No secret value is ever written to SQLite, logged in `agent_runs`/`runtime_events`, written to an Obsidian note, or transmitted to `UI-xyp3rn`.

---

## 5. Localhost Binding & API Access Control (`core/gateway/server.ts`)

1. **Strict `127.0.0.1` Binding:**
   - `startOs3GatewayServer()` refuses to bind to `0.0.0.0` or any non-loopback interface (`127.0.0.1` and `localhost` only).
2. **Same-Origin & Host Allowlist (`isAllowedGatewayOrigin`):**
   - Every HTTP request is checked against `LOCAL_HOST_RE` (`^(127\.0\.0\.1|localhost)(:\d+)?$`) and `LOCAL_ORIGIN_RE` (`^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$`).
   - Any request carrying a foreign `Host` or `Origin` header is immediately rejected with `403 FORBIDDEN`.
3. **Payload Size & Timeout Bounds:**
   - JSON request bodies on `:8077` are capped at `256 KB`.
   - Vault note reads for indexing are capped at `5 MB` (`MAX_PARSE_BYTES`).

---

## 6. Append-Only Audit Logging (`core/sqlite/schema.ts`)

- Every `agent_runs` row is sealed upon leaving `pending` (`trg_agent_runs_seal`) and cannot be deleted (`trg_agent_runs_no_delete`).
- Every `jobs` row is sealed upon reaching a terminal status (`trg_jobs_seal`) and cannot be deleted (`trg_jobs_no_delete`).
- Every `runtime_events` row (`vault.write`, `vault.write.denied`, `vault.write.conflict`, `vault.append`, `vault.promoted`, `approval.queued`, `approval.approved`, `approval.rejected`) is strictly immutable (`trg_runtime_events_no_update`, `trg_runtime_events_no_delete`).
