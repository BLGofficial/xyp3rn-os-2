# XYP3RN OS 3.0 — Dependency & Runtime Compatibility Audit

## 1. Runtime & Toolchain Matrix across Repositories

| Component / Setting | `xyp3rn-os-2` Root (`officialFolderofXYP3RNOS/package.json`) | `xyp3rn-os-2` Legacy Web (`apps/web/package.json`) | Primary Interface `UI-xyp3rn` (`UI-xyp3rn/package.json`) | Compatibility & Resolution |
|---|---|---|---|---|
| **Node.js Engine** | `>=22` (`.nvmrc`: `22`; built-in `node:sqlite` + native `.ts` execution) | Inherits Node `>=22` | `@types/node: ^22.10.0` | **Compatible.** Standardized on **Node.js 22 LTS** across both repositories. |
| **Package Manager** | `pnpm` (`pnpm-lock.yaml`, `pnpm-workspace.yaml`) | `pnpm` workspace member (`@xyp3rn/web`) | `npm` (`package-lock.json`) | **Action:** Keep `pnpm.cmd` in `xyp3rn-os-2` and `npm.cmd` in `UI-xyp3rn` (or unify under pnpm workspace in a later phase after explicit sign-off). |
| **TypeScript** | `devDependencies.typescript: ^7.0.2` + `dependencies.typescript-api: npm:typescript@5.9.3` | `~5.9.3` | `^5.6.3` | **Warning Flagged:** Root `package.json` specifies `^7.0.2` alongside `typescript-api` (`5.9.3`). Both `tsc --noEmit` checks pass today with 0 errors. |
| **Module System** | `"type": "module"`, `"module": "NodeNext"`, `"allowImportingTsExtensions": true`, `"erasableSyntaxOnly": true` | `"type": "module"`, `"moduleResolution": "bundler"` | CommonJS default (no `"type": "module"` in `package.json`), `"moduleResolution": "bundler"` | **Resolved:** `erasableSyntaxOnly: true` in `xyp3rn-os-2` forbids TS `enum` and constructor parameter properties (`private readonly`); all OS 3.0 modules use `#private` fields and `as const` unions. |
| **Next.js** | N/A | `15.5.27` | `14.2.35` | **Security Advisory Note:** `UI-xyp3rn` runs Next.js `14.2.35` (pinned for strict layout/bundle stability), bound strictly to `127.0.0.1` (`-H 127.0.0.1`). |
| **React / React DOM** | N/A | `18.3.1` | `18.3.1` | **100% Match (`18.3.1`).** |
| **Tailwind CSS & PostCSS** | `pnpm.overrides: { "next>postcss": "8.5.28" }` | `tailwindcss: 3.4.17`, `postcss: ^8.5.28` | `tailwindcss: ^3.4.19`, `postcss: ^8.4.49` | **Compatible (Tailwind v3.4).** |
| **Animation Library** | N/A | `motion: ^14.0.0`, `three: ^0.186.1`, `@react-three/fiber: ^9.8.1` | `framer-motion: ^14.12.0` | **Compatible.** `UI-xyp3rn` uses `framer-motion` imperative motion values; unused `three` in `apps/web` is deprecated. |
| **Test Runner** | `vitest: ^5.0.1` | `playwright-core: 1.56.1` | `vitest: ^5.1.0` + `@testing-library/react: ^16.3.0` + `jsdom: ^31.0.0` | **Compatible (Vitest v5).** |

---

## 2. Backend & Native Dependency Audit (`xyp3rn-os-2`)

| Dependency | Version | Purpose | Local-First / OS 3.0 Status |
|---|---|---|---|
| `node:sqlite` (Built-in) | Node 22 built-in | Local SQLite runtime database (`DatabaseSync`) | **Active in OS 3.0 (`core/sqlite/`).** Zero native compilation or `node-gyp` issues on Windows. |
| `chokidar` | `^5.0.0` | File watcher for Obsidian Vault changes | **Reused.** Used by `knowledge/obsidian/watcher.ts` and `VaultEngine`. |
| `yaml` | `^2.9.1` | YAML frontmatter, workflow spec, and manifest parser/serializer | **Reused.** Used across `knowledge/obsidian/parser.ts`, `core/workflow-engine/`, and `core/vault-engine/`. |
| `@huggingface/transformers` | `^4.3.0` | Local `Supabase/gte-small` 384-dim embeddings (`.local-models/`) | **Reused.** Note: `onnxruntime-node` and `protobufjs` are listed in `pnpm.ignoredBuiltDependencies`; runs on WASM/JS CPU fallback locally. |
| `unpdf` | `^1.8.1` | Local PDF text extraction (`XYP3RN_Agentic_OS_Build_Sequence.pdf`) | **Reused.** Pure JS, no external binary dependency. |
| `@anthropic-ai/sdk` | `^0.128.0` | Optional Anthropic model provider (`core/llm/providers.ts`) | **Reused.** Server-side only; keys read from `process.env` at call time. |
| `postgres` (`postgres.js`) | `^3.4.9` | Legacy PostgreSQL client (`core/db/client.ts`) | **Deprecated (Preserved for parity testing).** Replaced for runtime state by `node:sqlite` and for canonical data by `VaultEngine`. |

---

## 3. Environment Variables Audit

| Variable | Repository | Default / Current Value | Security & Scope |
|---|---|---|---|
| `OBSIDIAN_VAULT_PATH` | `xyp3rn-os-2` (`.env.local`) | `"C:/Users/blago/Desktop/XYP3RN-Suno-KB-v1.2-Brain"` | Server-only. Points `VaultEngine` and `Os3JarvisRuntime` to the canonical Obsidian Vault. |
| `XYP_SQLITE_PATH` | `xyp3rn-os-2` (`.env.local`) | `".local-db/xyp3rn-os3.sqlite"` | Server-only. Path to the local WAL-mode SQLite runtime database. |
| `XYP_GATEWAY_PORT` | `xyp3rn-os-2` | `8077` | Server-only (`127.0.0.1:8077`). Matches `LAYOUT.gatewayPort` in `UI-xyp3rn/lib/tokens.ts`. |
| `XYP_DATABASE_URL` | `xyp3rn-os-2` (`.env.example`) | `postgres://postgres:postgres@127.0.0.1:5432/postgres` | Legacy PostgreSQL connection string (used only by legacy `core/db/` tests). |
| `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY` | `xyp3rn-os-2` (`.env.example`) | Unset by default | **Secret.** Read only by `core/llm/providers.ts` in Node; never exposed to `UI-xyp3rn` or written to the Vault. |
| `SUNO_API_KEY`, `SUNO_CALLBACK_URL` | `xyp3rn-os-2` (`.env.example`) | Unset by default | **Secret.** Only used when `adapter: "sunoapi"` is explicitly requested; default `adapter: "manual"` requires no key. |
| `XYP_TRACE_TOKEN` | `xyp3rn-os-2` | Required (>=16 chars) when running `pnpm trace:serve` | **Secret.** Constant-time bearer token for `127.0.0.1:8787` TRACE service. |
| `XYP_WHISPER_URL`, `XYP_KOKORO_URL` | `xyp3rn-os-2` (`.env.example`) | `http://127.0.0.1:9000/...`, `http://127.0.0.1:8880/...` | Local speech service endpoints. |

---

## 4. Runtime Assumptions on Windows Host

1. **PowerShell ExecutionPolicy (`Restricted` / `RemoteSigned`):** Invoking `pnpm` or `npx` in PowerShell attempts to load `pnpm.ps1` / `npx.ps1`, which fails with `PSSecurityException` when script execution is disabled. All scripts and automation must invoke `pnpm.cmd`, `npx.cmd`, `npm.cmd`, or `node` directly.
2. **Windows Path Separators (`\` vs `/`):** All vault-relative identifiers and paths must be normalized to POSIX forward slashes (`/`) via `validateVaultPath()` before indexing or comparing against `UI-xyp3rn` job paths (`01_CORE/00_Identity/Mission.md`).
3. **Windows File Locking (`EBUSY` / `EPERM`):** When Obsidian is open on `XYP3RN-Suno-KB-v1.2-Brain`, atomic file renames can transiently fail with `EBUSY` or `EPERM`. `writeFileAtomic()` in `core/vault-engine/revision.ts` mitigates this with bounded exponential backoff.
