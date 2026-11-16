# XYP3RN OS 3.0 — Local Deployment & Operations Guide

## 1. Prerequisites
- **Node.js `>= 22`** (includes built-in `node:sqlite` — zero external native SQL builds or Docker required)
- **pnpm** (`pnpm.cmd` on Windows PowerShell) & **npm** (for `UI-xyp3rn`)
- External **Obsidian Vault** directory (e.g., `OBSIDIAN_VAULT_PATH` set in `.env.local`)

---

## 2. Configuration (`.env.local` in `officialFolderofXYP3RNOS`)

Copy `.env.example` to `.env.local` and configure:
```ini
OBSIDIAN_VAULT_PATH=<absolute-path-to-your-obsidian-vault>
OBSIDIAN_SYNC_MODE=bidirectional
XYP_SQLITE_PATH=.local-db/xyp3rn-os3.sqlite
XYP_GATEWAY_PORT=8077
# Optional API token protection for local HTTP endpoints:
# XYP_GATEWAY_TOKEN=<random-local-token>
```
*(Optional LLM provider keys `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY` are only needed if invoking live external models instead of deterministic local workflows.)*

---

## 3. One-Time Provisioning & Validation
```powershell
pnpm.cmd vault:os3 provision   # Ensures 6 sectors + 52 agents + 7 workflows + schemas in OBSIDIAN_VAULT_PATH
pnpm.cmd vault:os3 scan        # Indexes Vault notes, tags, wikilinks, and SHA-256 hashes into SQLite
pnpm.cmd vault:os3 validate    # Verifies YAML schemas, IDs, uniqueness, and 0 leaked secrets
```

---

## 4. Starting the System
- **Recommended Single Command (`officialFolderofXYP3RNOS`):**
  ```powershell
  pnpm.cmd start:os
  ```
- **Manual Two-Terminal Start:**
  1. Gateway API (`http://127.0.0.1:8077`):
     ```powershell
     pnpm.cmd gateway:os3
     ```
  2. Primary UI (`UI-xyp3rn`, `http://127.0.0.1:3000`):
     ```powershell
     npm.cmd run build
     npm.cmd run start -- -H 127.0.0.1 -p 3000
     ```

---

## 5. Health Verification
- Gateway health JSON: `http://127.0.0.1:8077/api/health` (`ok: true`, `sqliteOpen: true`, `integrityOk: true`)
- UI Routes: `/map` (Galaxy Map + Jarvis Console), `/dashboards` (Agents, Workflows, Approvals, Research, Records), `/chart` (Knowledge Graph), `/jarvis`
