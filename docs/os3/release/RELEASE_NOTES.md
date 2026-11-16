# XYP3RN OS 3.0.0-rc.1 — Release Notes

**Release Date:** 2026-11-16  
**Architecture:** Local-First · Obsidian Vault Canonical Store · Embedded `node:sqlite` Runtime · Localhost-Only (`127.0.0.1`)

---

## Highlights

1. **Canonical Obsidian Vault Storage (`core/vault-engine/`):**
   - Full `VaultEngine` supporting validated reads/writes, compare-and-swap (`expectedSha256`), No-Overwrite Guard, immutable version history and snapshots (`.vault-revisions/`), external Obsidian edit reconciliation, and human-approved `VaultPromotionGate`.
   - Verified on live Vault (`OBSIDIAN_VAULT_PATH`): `20,354` indexed files, `158` schema-checked entities, `20` schemas/templates, `0` secret violations.
2. **Embedded SQLite Operational Runtime (`core/sqlite/`):**
   - Built-in Node.js `node:sqlite` runtime storing only operational/index state (`agent_runs`, `jobs`, `locks`, `pending_approvals`, `runtime_events`, `sessions`, `index_state`, `wikilinks`) with WAL mode, savepoint transactions, stale lock/job recovery, and online backup (`backupDatabase()`).
3. **Agent & Tool Migration + Orchestration (`52` Agents · `39` Tools · `7` Workflows):**
   - Preserves all 8 Agent Classes and 6 Domains (`core/agent-registry/os3-agent-registry.ts`, `core/tool-registry/os3-tool-registry.ts`).
   - Full DAG workflow validation and execution (`core/workflow-engine/os3-workflow-engine.ts`), bounded orchestration (`core/orchestrator/os3-orchestrator.ts`), JARVIS Coordinator (`core/gateway/os3-jarvis-core.ts`), and provider-isolated `Os3ModelGateway`.
4. **Domain Intelligence (`research-intelligence/`, `records/`):**
   - Vault-first Research Intelligence chain (9 entities, verbatim quote checks, multi-source confidence cap, contradiction detection & promotion block).
   - Full X3LIUS Records & Music System (13 subdomains, immutable lyrics, homoglyph guard, Suno AI provenance, GS1 UPC, ISO 3901 ISRC, 100.000% splits, release history).
5. **UI-xyp3rn Primary Operator Interface (`127.0.0.1:3000`):**
   - Preserves Constellation Canvas visuals while replacing static seed authority with the typed OS3 API adapter (`lib/os3-adapter.ts`) and Gateway REST endpoints (`127.0.0.1:8077`).
   - Adds live Operational Dashboard (`/dashboards`), Governance Approvals UI, Entity Inspector, Vault-backed `SkillViewer` & `SearchBar`, and interactive Knowledge Graph (`/chart`).
6. **Legacy PostgreSQL / Supabase Retirement:**
   - Default startup (`pnpm start:os` / `scripts/start-os3.ps1`) and bootstrap (`scripts/session-start.sh`) require zero Docker, PostgreSQL, or Supabase containers, while preserving legacy `supabase/migrations/` history and rollback scripts (`start:legacy-os2`).
