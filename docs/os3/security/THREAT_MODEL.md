# XYP3RN OS 3.0 — Threat Model

**Architecture:** Local-First AI Operating System (`127.0.0.1`), File-First Canonical Obsidian Vault (`OBSIDIAN_VAULT_PATH`), Ephemeral/Operational `node:sqlite` Runtime, Deny-by-Default Agent & Tool Capabilities.

---

## 1. Trust Boundaries

1. **Operator Interface Boundary (`127.0.0.1:3000` <-> `127.0.0.1:8077`):**
   Browser client (`UI-xyp3rn`) communicating over HTTP JSON with `Os3JarvisRuntime` Gateway. Untrusted cross-origin tabs and LAN callers sit outside this boundary.
2. **Filesystem & Obsidian Vault Boundary (`vaultRoot`):**
   OS3 runtime reads/writes only inside resolved `realpath(vaultRoot)`. User edits in the native Obsidian app sit on the same disk inside `vaultRoot`, separated by optimistic SHA-256 CAS checks and `.vault-revisions/` preservation.
3. **Canonical vs. Workspace Partition:**
   Working artifacts (`10_INBOX/`, `01_CORE/06_Tasks/`, `03_RESEARCH_INTELLIGENCE/00_Briefs/`) are separated from protected canonical truth (`00_SYSTEM/`, `01_CORE/00_Identity/`, `02_KNOWLEDGE_LAYER/`, `06_GOVERNANCE/`).
4. **Agent / Workflow Execution Boundary:**
   Prompt inputs, YAML workflow specs, and agent Markdown definitions are validated against allowlists before dispatch or tool invocation.

---

## 2. STRIDE Threat Analysis & Mitigations

| Threat ID | Category | Attack Vector | Mitigation in OS 3.0 | Verification Owner |
|---|---|---|---|---|
| **T-01** | Tampering / EoP | Direct overwrite or forgery of canonical knowledge, policies, or identity files | `executeControlledWrite()`, `executeControlledAppend()`, `restore()`, and frontmatter guard deny canonical writes (`CANONICAL_WRITE_FORBIDDEN`). Only `VaultPromotionGate` writes canonical notes. | `tests/os3-phase12-security` (#1) |
| **T-02** | Traversal / Info Disclosure | Path traversal (`../`), backslash/UNC paths, null bytes, or Windows/POSIX symlinks/junctions escaping `vaultRoot` | `validateVaultPath()` lexical filter + `resolveVaultPath()` iterative `lstat`/`realpath` ancestor verification (`SYMLINK_ESCAPE`). | `tests/os3-phase12-security` (#2) |
| **T-03** | Elevation of Privilege | Research or Creative agent invoking mutating tools (`vault_write`) or undeclared tools | `Os3ToolRegistry.authorize()` & `Os3Orchestrator` validate agent class (`CLASS_CAPABILITIES`) + agent YAML declared `tools` list before invocation. | `tests/os3-phase12-security` (#3) |
| **T-04** | Repudiation / Governance Bypass | Proposer agent or automation self-approving its promotion candidate or rewriting a past decision | Unified `AGENT_OR_SYSTEM_ACTOR_RE` + `proposer !== approver` enforcement in `server.ts` (`HTTP 403`) and `VaultPromotionGate` (`SELF_APPROVAL_FORBIDDEN`); SQLite trigger (`sealed once decided`) + Gateway `HTTP 409` ensure immutable decisions. | `tests/os3-phase12-security` (#4) |
| **T-05** | Tampering / Data Loss | Concurrent writer race condition or silently clobbering concurrent human edits in Obsidian | `withPathLock()` in-process + SQLite TTL locks, `expectedSha256` CAS validation, `resolveNoOverwritePath()`, and automatic archiving of external Obsidian edits to `.vault-revisions/`. | `tests/os3-phase12-security` (#5) |
| **T-06** | Information Disclosure | API secrets written into Vault Markdown notes, served over HTTP, or leaked in logs/errors | `validateEntityContent()` blocks secret patterns on write; `GET /api/vault/note` blocks on-disk secrets with HTTP `403`; `redactSecrets()` & `StructuredLogger` mask sensitive keys and tokens. | `tests/os3-phase12-security` (#6) |
| **T-07** | Spoofing / CSRF / SSRF | Cross-origin browser request from malicious site (`https://evil.example`), spoofed `Host`, or remote IP scan | Gateway binds strictly to `127.0.0.1`; `isAllowedGatewayOrigin()` validates `Host`, `Origin`, `Referer`; optional `Bearer`/`X-XYP-Token` auth enforced via `timingSafeEqual`. | `tests/os3-phase12-security` (#9) |
| **T-08** | Injection / DoS | Prototype pollution (`__proto__`, `constructor`, `prototype`) in workflow JSON, infinite retry/agent loops, deep nesting | `assertSafeWorkflowInput()` blocks prototype keys, depth > 20, size > 256 KB; `memory.ts` uses `Object.hasOwn()` & blocks prototype keys; `MAX_ORCHESTRATION_STEPS = 32` bounds multi-step runs. | `tests/os3-phase12-security` (#9) |
| **T-09** | Tampering (Supply Chain) | Hot-reloaded broken or unauthorized `.agent.md` replacing active registry | `parseOs3AgentFile()` rejects unknown frontmatter fields, mismatched filenames, invalid models, and unknown tools; `hotReload()` preserves prior valid snapshot when any validation error occurs. | `tests/os3-phase12-security` (#8) |
