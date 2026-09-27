# AOS-04 — The graph and file index: implementation plan (Plan C1 of 4)

> **For agentic workers:** execute task by task. Steps use checkbox (`- [ ]`) syntax. Every task commits its failing test before the code that turns it green (house rule since AOS-01).

**Goal:** one server-built, source-backed graph of the system that every later view reads (design §15.2):
- a **file index** of the repository checkout and the Vault, with an honest scope, coverage, exclusions and failures;
- **entities** with stable IDs, owners and exact sources;
- **edges** that each carry their proof: a row, or a file, line and revision;
- **global search** over the whole index;
- a **List view** with domain filters and the System/Creative lenses;
- an **inspector** with "Why connected?";
- a **safe viewer** for repository files.

No sphere, motion or answers: those are **Plan C2** (outlined at the end, planned after C1 ships).

**Architecture:**
- **Owner:** KNOWLEDGE, as the reserved `knowledge-graph` component (ARCHITECTURE, sub-component table). New code lives in `knowledge/knowledge-graph/`.
- **Two halves of one read model:**
  - **What files declare** (agents, workflows and their steps, decisions, manifests, imports, Markdown links) is parsed at **scan** time. It is stored in index tables, pinned to each file's checksum.
  - **What the database records** (modules, songs, lineages, Vault files, runs, research, approvals) is read **live**. No copy is kept.
  - Two `security_invoker` views, `graph_nodes` and `graph_edges`, union both halves. Listing, search, neighbourhoods and coverage are plain SQL as `xyp_web`.
- **Writer:** one new role, `xyp_indexer`. It can write the index tables and nothing else. It runs from `pnpm index scan`, the web server's boot and a "Rescan" action on `/system`.
- **Not a canonical write path** (§15.2): index rows are derived and rebuildable, so the rollback may drop them. Nothing in this plan writes canonical knowledge, research or Records data.

**Tech stack:** as Plans A and B, plus one new root dependency: `"typescript-api": "npm:typescript@5.9.3"` (Apache-2.0). It is already in the lockfile, since `apps/web` pins it, so nothing new is downloaded.
- **Why:** the root's `typescript@7` is the native compiler and has no JS API.
- **What it does:** `preProcessFile` lists every static, dynamic and type-level import with its offset, in `.ts` and `.tsx` alike, and skips strings and comments.
- **Checked against the alternatives on this repository (2026-09-27):**
  - Node's `stripTypeScriptTypes` + `es-module-lexer` fail on every `.tsx` file;
  - `sucrase` + `es-module-lexer` drop type-only imports.

**Spec:** [AOS-04-design.md](AOS-04-design.md) §§13.1–13.2 (List, lenses, inspector rail), §15, §16 (bullets 1–4), §20, and the C1 rows of §21. Plans [A](AOS-04-plan.md) and [B](AOS-04-plan-B.md) are built (PR #17, merged).

## Decisions (operator, 2026-09-27)

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| S1 | How Plan C is scoped | **Split.** C1 is the data: the projection and index, search, List, inspector and domain filters. C2 is the pixels: the sphere, motion, camera, the answering command bar and performance numbers. This follows §20's order: prove the data before the visuals. | One Plan C (a very large diff); C without answers (leaves §16's answer behaviour unbuilt) |
| S2 | Sphere renderer (C2) | **In-house SVG**, with our own projection maths and no new dependency. It is its own fallback, and the DOM gives picking, labels and accessibility. | three.js + an SVG fallback (two renderers); prototype both first |
| S3 | Where the file index lives | **DB tables + scan runs**, written by `xyp_indexer` and read by `xyp_web`. This gives a real last-scan time, counts, failures and retry, and SQL search over the whole index. | In-memory on demand (no history, lost on restart); a build-time manifest (can't see new files) |
| S4 | What the command bar answers with (C2) | **Extractive, no key:** the existing `retrieve-and-summarize` workflow, whose every sentence cites a row that resolves to a graph node. | An LLM via OpenRouter (not runnable here yet); search only |

## Choices this plan makes (flagged for review; each stands unless you override it)

1. **Workflow identity is its name; its revision is the spec's sha256.**
   - Editing a workflow keeps the node, and its revision changes.
   - A run's `run_of` edge carries the run's own `spec_sha256`. The inspector says "ran this revision" or "ran an earlier revision (`ab12…`)", never silently the current one.
2. **Default scope: the repository checkout (root id `repo`) and the Vault. No other root.**
   - Adding a root is a later, explicit decision (§15.2 item 1).
   - The index never walks outside the checkout, whatever the reference assets' location.
3. **Default exclusions**, counted by rule but never listed by name (§15.2 item 2):
   - **VCS and dependencies:** `.git/`, `node_modules/`;
   - **build output:** `.next/`, `dist/`, `coverage/`, `*.tsbuildinfo`;
   - **private runtime state:** `.local-db/`, `.local-models/`, `.vault/` (whose bytes are indexed as Vault files, by `sources` id);
   - **credentials:** `.env` and `.env.*` (`.env.example` included: C1 has no safe-handling rule for it, so it stays out), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`;
   - **backups:** `*.bak`, `*~`, `*.orig`.
4. **Size and type rules:**
   - Text files up to 1 MiB are hashed, previewed and parsed for references.
   - Larger text files and all binaries (images, PDFs, audio) are hashed and indexed as metadata. Images get the sandboxed raw view; no decoded text for anything else.
5. **A repository file that changed since its scan is not previewed.** The viewer says "changed since the last scan (indexed `ab12…`, now `cd34…`)" and offers Rescan. It never shows new bytes under the old revision.
6. **Tools (the tool registry) are not graph entities in C1.** §15.2 doesn't list them. The `uses_tool` edges from agent frontmatter would be real, and are left open (F47).
7. **Suggested relations** (title mentions, similarity) **are not built.** §15.3 makes them off by default. C1 builds only verified edges and the diagnostics for unresolved references.

## Global constraints

- **Nothing fabricated** (§12.1, §15.1, §20):
  - every node resolves to a file, a row or configuration;
  - every edge resolves to its proof;
  - an empty workspace shows the six domains and the repository's own files, and nothing invented;
  - fewer real nodes is a valid graph.
- **"Record" vs "File":** only a node with stored bytes (an indexed repository file, or a Vault source with `storage`) is labelled File. Every database row is labelled Record. Configuration (the taxonomy's domains) is labelled Configuration.
- **Ownership never forced** (§15.2 item 3):
  - a file's domain comes from its registration first (agent frontmatter, a manifest's `domain`), then from the taxonomy's domain directories;
  - `docs/`, `apps/`, `tests/`, `supabase/`, `scripts/`, `agents/` files without frontmatter, and root files stay **Shared/Unassigned**;
  - there is no seventh domain.
- **File safety** (§15.2):
  - the browser never sends a path;
  - the viewer takes an opaque index id, resolves it server-side, and re-checks the real path against the root (no `..`, no absolute or UNC path, no symlink escape);
  - it verifies the checksum, caps bytes and escapes the preview;
  - raw bytes get `nosniff` and a sandbox CSP, as the Vault raw route does.
- **Existing behaviour stays:** every page, action and smoke line keeps working. The top bar's search changes from Vault search to global search; the Vault page keeps its own search.
- **Gates before each push:**
  - `pnpm typecheck`, `pnpm test`, `pnpm agents:validate`;
  - migration down/up/down/up on the dev DB;
  - `pnpm web:build`, `pnpm web:smoke`.
- **Commit messages:** `AOS-04 red test: …` / `AOS-04 C1: …` / `AOS-04 UI: …`, ending with the Co-Authored-By line.

## Review focus

1. **Every edge has its proof.** An edge row without a provenance reference can't be built: the view's column is NOT NULL by construction, and a test pins it. An unresolved import, link, step agent or decision key becomes a **diagnostic** row, never an edge to a made-up node.
2. **Ownership is by registration, then path, then Shared.** A test pins an agent file under `agents/` owned by its frontmatter domain, a file under `records/` owned by RECORDS, and `docs/ARCHITECTURE.md` as Shared.
3. **Coverage adds up.** eligible = indexed + failed, and excluded is counted apart. A test reconciles a fixture root by hand. `/system` shows the same numbers the DB holds.
4. **The viewer can't be steered.** Traversal, absolute and UNC ids, a row whose path escapes the root, a symlink swapped in after the scan, and an excluded file all return 404 with no contents and no hidden name.
5. **Retractions leave the active graph but keep their history.** A retracted `song_links` or `research_links` row is absent from `graph_edges` and present in the node's history section.
6. **A finding's targets are inherited, not linked.** The inspector labels them "Inherited from brief". No direct finding→target edge exists in `graph_edges`.

## Entities (§15.2)

| Kind | Node id | Backing | Title | Owner domain | Revision | Destination |
|---|---|---|---|---|---|---|
| Domain | `domain:<DOMAIN>` | Configuration (`core/contracts/taxonomy.ts`) | `DOMAIN_META.label` | itself | taxonomy.ts sha256 | `/?domain=<D>` |
| Component | `module:<slug>` | Record (`modules`, current version) | `modules.title` | `modules.domain` | `v<version>` | `/node?id=` |
| Agent | `agent:<name>` | File (`agents/<name>.agent.md`, parsed by `parseAgentFile`) | name | frontmatter `domain` | file sha256 | `/node?id=` |
| Workflow | `workflow:<name>` | File (`*.workflow.yaml`, parsed by `parseWorkflowSpec`) | name | the file's domain directory, else Shared | spec sha256 | `/node?id=` |
| Workflow step | `workflow_step:<name>#<stepId>` | File (the same, step line) | `<name> · <stepId>` | its workflow's | spec sha256 | `/node?id=` |
| Decision | `decision:F<n>` | File (`docs/ARCHITECTURE.md`, the `**F<n>. …**` heading) | the heading text | Shared | section sha256 | `/node?id=` |
| Repository file | `file:repo/<relative path>` | File (`indexed_files`) | the relative path | registration → path → Shared | file sha256 | `/index/files/<id>` |
| Vault file | `sources:<uuid>` (with `storage`) | File (content-addressed store) | filename | KNOWLEDGE | `sources.checksum_sha256` | `/vault/files/<id>` |
| Ingested source | `sources:<uuid>` (no `storage`) | Record | title or URI | KNOWLEDGE | `sources.checksum_sha256` | `/node?id=` |
| Lineage / version | `lineage:<uuid>` / `creative_artifacts:<uuid>` | Record | schema + name / `v<n>` | RECORDS | version | `/vault/lineages/<id>` |
| Song, track, release | `songs:` / `tracks:` / `releases:<uuid>` | Record | current title | RECORDS | revision / — | the existing page |
| Canonical prompt | `canonical_prompts:<uuid>` | Record | title | its module's | version | `/node?id=` |
| Runs | `agent_runs:` / `workflow_runs:` / `research_runs:<uuid>` | Record | agent / workflow / question | the agent's / workflow's / RESEARCH_INTELLIGENCE | status | the run page when one exists |
| Research | `research_questions:` / `research_sources:` / `research_evidence:` / `research_findings:` / `knowledge_candidates:` / `approval_queue:<uuid>` | Record | question / URL / claim / claim / slug / decision | RESEARCH_INTELLIGENCE (candidates and approvals: KNOWLEDGE / GOVERNANCE) | — | the run page / library |

Every node carries:
- `id`, `kind`, `title`;
- `ownerDomain`, or null for Shared/Unassigned, with its `ownershipBasis`;
- `backing` (`file` | `record` | `configuration`), with the exact `sourceRef` (path and line, or table and id) and its `revision`;
- `destination`;
- `availability` (`present` | `missing` | `stale` | `unavailable`);
- `asOf` (the scan time, or the read time for live rows).

## Relations (§15.3)

| Relation | From → to | Proof (the edge's `provenance`) |
|---|---|---|
| `owned_by` | agent, module, file, workflow → domain | frontmatter line / `modules.domain` / the ownership rule and path |
| `defined_by` | agent, workflow → file | the parsed file |
| `part_of` | workflow step → workflow; track → release | spec line / `tracks.release_id` |
| `step_uses_agent` | workflow step → agent | spec line of `agent:` |
| `depends_on` | step → step; module → module | spec line of `dependsOn` / `relations` row |
| `subdomain_of`, `derived_from`, `precedes` | as recorded | `relations` row (predicate copied, not renamed) |
| `imports` | file → file | a resolved static import (file, line, specifier) |
| `references` | file → file | an explicit Markdown link (file, line, target) |
| `linked_to` | song → lineage, source, track, brief; brief → lineage, workflow, decision | unretracted `song_links` / `research_links` row |
| `run_of` | agent run → agent; workflow run → workflow; research run → brief | `agent_runs.agent_name` / `workflow_runs.workflow_name` + `spec_sha256` / FK |
| `produced_by` | version, Vault file, evidence → agent run or research run | the FK column |
| `version_of` | version → lineage | `creative_artifacts.lineage_id` |
| `supported_by` | finding → evidence | `research_finding_evidence` row |
| `quotes` | evidence → research source → source | FK + the preserved quote |
| `proposed_as`, `approved_by`, `promoted_to` | finding → candidate → approval → canonical prompt | FKs and `knowledge_versions` |
| `decides` | approval → finding / version | `approval_queue` row |

- **Edge id:** `<relation>:<provenance>`, stable across reads. For example, `linked_to:row:song_links:<uuid>` or `imports:file:repo/core/db/client.ts@<sha12>:L12`.
- **Verification state:**
  - `verified`: the endpoints exist and the proof is at the recorded revision;
  - `stale`: the file changed since the scan.
- **Diagnostics:** an unresolved reference is kept as a row, not as an edge.
- `run_of`, `version_of`, `part_of` and `decides` are added to §15.3's vocabulary with the same rule (a column or row as proof). The copied `relations` predicates keep their names.

## Data: migration `20260927100000_graph_index` (+ rollback)

- **`index_scans`:**
  - `id`, `trigger` (`cli` | `boot` | `owner`), `roots jsonb`, `started_at`, `finished_at`;
  - `status` (`running` | `success` | `error`), `error`;
  - `counts jsonb` = `{ eligible, indexed, failed, excluded: { <rule>: n }, vault: { present, missing } }`.
  - Sealed once it leaves `running`.
- **`indexed_files`:**
  - `id uuid`, `root` (`repo`), `path` (normalised, relative, `/`-separated; check: no leading `/`, no `..` segment, no `\`, no drive letter);
  - `sha256`, `size_bytes`, `mime`, `mtime`;
  - `text_indexed bool`: false for binaries and oversize text;
  - `owner_domain` (null = Shared) and `ownership_basis` (`frontmatter` | `manifest` | `domain-path` | `shared`);
  - `status` (`present` | `missing` | `unreadable`), `error`;
  - `first_scan_id`, `last_scan_id`, `indexed_at`.
  - `unique (root, path)`. A rename is a new row, and the old one becomes `missing`.
- **`index_nodes`:** file-declared entities (`agent`, `workflow`, `workflow_step`, `decision`):
  - `id` text pk, `kind`, `title`, `owner_domain`, `file_id` → `indexed_files`, `line`, `revision`, `scan_id`, `detail jsonb`.
  - Replaced per file when the file's checksum changes.
- **`index_edges`:** file-derived edges and diagnostics:
  - `id`, `relation`, `from_id`, `to_id` (null = unresolved), `file_id`, `line`, `detail` (the specifier or target text), `revision`, `scan_id`.
  - Replaced per file with its nodes.
- **`index_vault_status`:** `source_id` pk → `sources`, `status` (`present` | `missing` | `size-mismatch`), `checked_at`, `scan_id`.
- **Views** (`security_invoker`):
  - `graph_nodes` = the domains (from a `values` list pinned against `DOMAINS` by a test), index nodes, present and missing files, and the live record kinds above;
  - `graph_edges` = verified index edges plus the live relations above (unretracted links only);
  - `graph_diagnostics` = unresolved index edges;
  - `graph_link_history` = retracted song and research links with their retraction reason.
- **Roles:**
  - **`xyp_indexer`** (new, `nologin noinherit`): SELECT/INSERT/UPDATE/DELETE on the five index tables; SELECT on `sources` (`id`, `checksum_sha256`, `byte_size`, `storage`) for the Vault check. Nothing else (42501 on any other write, pinned by test).
  - **`xyp_web`:** SELECT on the index tables and the four views.
  - **`service_role`:** SELECT only (G20).
  - **`anon` / `authenticated`:** nothing.
- **Rollback:** drops the views, tables and role. Index rows are derived (a scan rebuilds them), so there is no owner-data refusal. The rollback says so in its header.

## File map

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/20260927100000_graph_index.sql`, `supabase/rollbacks/…down.sql`, `tests/aos-04/graph-index-db.test.ts` | tables, views, role, grants | 1 |
| `knowledge/knowledge-graph/scope.ts`, `scan.ts`, `tests/aos-04/index-scan.test.ts` | the walk, exclusions, ownership, hashing, symlink safety, the Vault check, scan runs | 2 |
| `knowledge/knowledge-graph/refs.ts`, `declared.ts`, `tests/aos-04/index-refs.test.ts` | imports, Markdown links, agents, workflows and steps, decisions → index nodes and edges | 3 |
| `knowledge/knowledge-graph/cli.ts`, `package.json` (`index` script, `es-module-lexer`), `apps/web/instrumentation-node.ts` | `pnpm index scan \| status`, the boot scan | 4 |
| `knowledge/knowledge-graph/projection.ts`, `apps/web/server/graph-loaders.ts`, `graph.test.ts`, `apps/web/lib/server.ts` | list, neighbourhood, node detail, coverage, lenses; the `graphLoaders` door | 5 |
| `knowledge/knowledge-graph/search.ts` (+ tests in `graph.test.ts`) | global search, grouped by type | 6 |
| `apps/web/app/index/files/[id]/page.tsx`, `raw/route.ts`, `apps/web/server/graph-files.ts` (+ tests) | the safe repository-file viewer | 7 |
| `apps/web/app/page.tsx`, `app/shell/*`, `app/search/page.tsx`, `app/node/page.tsx`, `app/system/page.tsx`, `app/graph-ui.tsx` | List view, domain filters, lenses, inspector rail, search page, node page, System page | 8 |
| `apps/web/server/ops.ts`, `app/vault/files/[id]/page.tsx` (+ test) | "Saved" vs "Indexed" on a Vault save; retry | 9 |
| `apps/web/e2e/smoke.ts` | the C1 journey | 10 |
| docs, proof, handoff | F46 decided (S1–S4 + this plan's choices), F47 open | 11 |

---

### Task 1: The migration

**Files:** create `supabase/migrations/20260927100000_graph_index.sql`, `supabase/rollbacks/20260927100000_graph_index.down.sql` and `tests/aos-04/graph-index-db.test.ts`.

- [ ] **Step 1: Red test** (throwaway DB, as the other `tests/aos-04` DB tests):
  - **Tables and checks:**
    - the five tables exist;
    - `indexed_files.path` rejects `/etc/passwd`, `../x`, `a/../b`, `C:\x`, `\\server\share\x` and `a\b` (23514);
    - `unique (root, path)` holds (23505);
    - a sealed `index_scans` row refuses updates (55000).
  - **Grants:**
    - `xyp_indexer` can write the index tables;
    - `xyp_indexer` gets 42501 on INSERT into `sources`, `songs`, `research_links`, `canonical_prompts` and `relations`;
    - `xyp_web` can SELECT the four views and cannot write the index tables (42501);
    - `service_role` is SELECT-only;
    - `anon` and `authenticated` see nothing.
  - **Views:**
    - `graph_nodes` has the six domains and nothing else on an empty index with no records;
    - a fixture song linked to a lineage produces one `linked_to` edge whose provenance is the `song_links` row; after its retraction, the edge leaves `graph_edges` and appears in `graph_link_history` with the reason;
    - an `index_edges` row with a null `to_id` appears in `graph_diagnostics` and not in `graph_edges`;
    - every `graph_edges` row has a non-null provenance and both endpoints in `graph_nodes`.
  - **Round trip:** down, up, down, up, with the view definitions intact.
- [ ] **Step 2: Run, see it fail. Commit the red test.**
- [ ] **Step 3: Implement** the migration and rollback as specified in "Data". `SCHEMA.md` gains an "AOS-04 Plan C1 additions" section.
- [ ] **Step 4:** the test, the full suite, the round trip on the dev DB. **Commit:** `AOS-04 C1: graph_index migration (index tables, graph views, xyp_indexer)`.

### Task 2: The scan

**Files:** create `knowledge/knowledge-graph/scope.ts`, `knowledge/knowledge-graph/scan.ts` and `tests/aos-04/index-scan.test.ts`.

**Interfaces:**
- `EXCLUSIONS: readonly { rule: string; test: (relPath) => boolean }[]` (choice 3);
- `ownerOf(relPath, declared?): { domain: Domain | null; basis }`;
- `scanRoots(sql, { roots, trigger, store, now? }): Promise<ScanResult>`, where `ScanResult = { scanId, counts, failures: { path, error }[] }`.

- [ ] **Step 1: Red test** on a temp fixture root (built in the test; nothing touches the real checkout):
  - **Counts:**
    - a fixture tree has 7 eligible files (2 under `records/`, 1 under `agents/` with RECORDS frontmatter, 1 under `docs/`, 1 PNG, 1 oversize text file, 1 unreadable file with its mode set to 000);
    - it also has `.env`, `.env.example`, `node_modules/x.js`, `.git/HEAD`, `.vault/abc`, `id_rsa` and `a.bak`;
    - the scan gives eligible 7, indexed 6, failed 1, and excluded counted per rule;
    - no excluded name appears anywhere in the result or the DB.
  - **Ownership:** the agent file → RECORDS (`frontmatter`), `records/x.ts` → RECORDS (`domain-path`), `docs/y.md` → null (`shared`).
  - **Binary and oversize files:** the PNG and the oversize file have a sha256 and `text_indexed = false`.
  - **Symlinks:** one pointing outside the root is not followed; it is counted as excluded (`symlink-escape`), not indexed. A symlink inside the root is indexed once, under its real path.
  - **Rescans:**
    - an unchanged file keeps its row and `first_scan_id`;
    - a modified file gets its new sha256;
    - a renamed file leaves the old path `missing` with a new row for the new path (same bytes, two identities: no merge by content);
    - a deleted file becomes `missing`.
  - **The Vault:** a Vault source whose bytes are in the store → `present`; one whose bytes were deleted → `missing`. Both are counted.
  - **Scan runs:** the run is sealed `success` with the counts. A scan whose DB write fails is sealed `error` with the message.
- [ ] **Step 2: Run, see it fail. Commit the red test.**
- [ ] **Step 3: Implement.**
  - **The walk:** `readdir` with `withFileTypes`. It never follows a directory symlink; a file symlink is resolved with `realpath` and kept only inside the root.
  - **Hashing:** only when size or mtime changed, or on `--full`.
  - **Writes:** one transaction per scan, as `xyp_indexer`. The run row is opened first and sealed on every path.
- [ ] **Step 4:** tests, typecheck. **Commit:** `AOS-04 C1: the file index scan (scope, exclusions, ownership, checksums, symlink safety, the Vault check)`.

### Task 3: What files declare

**Files:** create `knowledge/knowledge-graph/refs.ts`, `knowledge/knowledge-graph/declared.ts` and `tests/aos-04/index-refs.test.ts`; modify the root `package.json` (`typescript-api` → `npm:typescript@5.9.3`, pinned).

**Interfaces:**
- `importsOf(source): { specifier; line }[]` for `.ts`, `.tsx`, `.js` and `.mjs` files;
- `resolveImport(fromPath, specifier, exists): string | { unresolved: reason } | null`:
  - a relative specifier resolves as written, then with `.ts`, `.tsx`, `.js`, `/index.ts` and `/index.tsx`, because `apps/web` imports without extensions, as Next resolves;
  - null for `node:` built-ins and bare packages: they are not repository files, so neither edge nor diagnostic;
- `markdownLinksOf(md): { target; line }[]`;
- `declaredOf(relPath, text): { nodes; edges }` for agent files, workflow files and `docs/ARCHITECTURE.md`.

- [ ] **Step 1: Red test:**
  - **Imports:**
    - `import x from './a.ts'`, `import type { T } from '../b.ts'`, `export * from './c.ts'`, `await import('./d.ts')` and `typeof import('./e.ts')` each resolve with the right line;
    - a `.tsx` file with JSX lists its imports, and `import { x } from '../ui'` resolves to `../ui.tsx`;
    - `import('./' + name)` (not a literal) gives no edge (it names no file);
    - `node:fs` and `postgres` give nothing;
    - an import inside a string or comment is ignored;
    - a missing target is a diagnostic naming the specifier and line.
  - **Markdown:**
    - `[x](../ARCHITECTURE.md#f42)` resolves to the file (anchor kept in `detail`);
    - links inside fenced code and inline code are ignored;
    - `http(s):` and `mailto:` links are ignored;
    - a missing target is a diagnostic;
    - a bare mention of `ARCHITECTURE.md` in prose creates no edge (the "false title match" case).
  - **Agents:** an agent file gives `agent:<name>`, owned by its frontmatter domain, `defined_by` its file.
  - **Workflows:**
    - a workflow file gives the workflow node, one step node per step, `part_of` edges, `step_uses_agent` edges on the `agent:` line, and `depends_on` edges on the `dependsOn` line;
    - an unknown agent is a diagnostic.
  - **Decisions:**
    - `docs/ARCHITECTURE.md` gives `decision:F1` … `decision:F<n>` with each heading's line and a per-section sha256;
    - the fixture's F-numbers are read, not assumed.
  - **Real repository cross-check** (read-only): every `agents/*.agent.md` parsed here equals `loadAgents(agents)` by name and domain, and every `*.workflow.yaml` parses. The index agrees with the registry.
- [ ] **Step 2: Run, see it fail. Commit the red test.**
- [ ] **Step 3: Implement.**
  - **Imports:** `preProcessFile(src, true, true)` from `typescript-api`; each import's line is counted from its offset in the untouched source.
  - **Wiring:** `scan.ts` calls `declaredOf` for text files whose checksum changed, and replaces that file's `index_nodes`/`index_edges` in the scan's transaction.
- [ ] **Step 4:** tests, typecheck. **Commit:** `AOS-04 C1: declared entities and references (imports, Markdown links, agents, workflow steps, decisions) with diagnostics`.

### Task 4: The CLI and the boot scan

**Files:** create `knowledge/knowledge-graph/cli.ts`; modify the root `package.json` (`"index": "node knowledge/knowledge-graph/cli.ts"`) and `apps/web/instrumentation-node.ts`.

- **Commands:**
  - `pnpm index scan [--full]` prints the counts, the failures (paths) and the excluded counts per rule (no names);
  - `pnpm index status` prints the last scan (time, trigger, status, counts) and the diagnostics count.
- **Boot:** after the research sweep, `instrumentation-node.ts` starts a scan (trigger `boot`) without awaiting it. A failure is logged and `/login` still serves, as the sweep does.
- [ ] **Test:** `tests/aos-04/index-cli.test.ts` runs `scan` then `status` against a fixture root (red first) and checks the printed counts equal the DB's.
- [ ] **Commit:** `AOS-04 C1: pnpm index scan | status; the web server scans at boot`.

### Task 5: The projection

**Files:** create `knowledge/knowledge-graph/projection.ts`, `apps/web/server/graph-loaders.ts` and `apps/web/server/graph.test.ts`; modify `apps/web/lib/server.ts` (the `graphLoaders` door).

**Interfaces** (all as `xyp_web`, read-only):
- `listNodes(sql, { domain?, kind?, lens?, page, perPage = 50 }): { nodes; total; page; asOf }`;
- `nodeDetail(sql, id): { node; outgoing; incoming; inherited; history; diagnostics } | null`, where each edge comes with `{ relation, other, provenance, revision, verification }` and `inherited` is a finding's brief targets, labelled "Inherited from brief";
- `neighbourhood(sql, id): { center; nodes; edges }` (one hop, actual edges only);
- `coverage(sql): { scope; lastScan; counts; diagnostics; vault }`;
- `lensGroups(sql, 'creative'): { key; label; query; count; memberIds }[]`: the §13.2 groups over the same IDs, under the real `module:x3lius-music-system`:
  - Songs;
  - Lyrics (`x3lius.lyrics/*` lineages);
  - Styles (style-recipe lineages);
  - Meta Tags (meta-tag-set lineages);
  - Research (briefs with a song or lineage target);
  - Workflows (RECORDS-owned workflows).
  Each group's `query` is the filter text shown to the owner.
- `href(node)`: the destination column of the entity table.

- [ ] **Step 1: Red test** (fixture DB with a scanned fixture root, plus rows made through the existing ops):
  - **Every kind:** each kind in the entity table appears with all required fields. A Vault file is `backing: file`, an ingested source is `record`, and a domain is `configuration`.
  - **Chains:**
    - brief → run → evidence → research source → source, each hop an edge with its FK or row as provenance;
    - finding → evidence via `research_finding_evidence`;
    - the finding's targets are only in `inherited`, labelled "Inherited from brief".
  - **Links and runs:**
    - song → lineage `linked_to` with the `song_links` row; after the retraction it's gone from `outgoing` and present in `history`;
    - a workflow run whose `spec_sha256` differs from the scanned spec shows `verification: "ran an earlier revision"`.
  - **Filters and lenses:**
    - `domain=RECORDS` keeps only RECORDS-owned nodes and never removes nodes from the other filters' totals;
    - Shared files are listed under a "Shared/Unassigned" filter;
    - the creative lens's groups count and list only real members, with the same IDs as the system lens (no duplicates).
  - **Coverage:** `coverage` equals the last scan's counts.
  - **Empty workspace:** `listNodes` shows the six domains and the fixture's files, and no other node.
- [ ] **Step 2: Run, see it fail. Commit the red test.**
- [ ] **Step 3: Implement** over the Task 1 views. `projection.ts` holds the SQL; `graph-loaders.ts` wraps it in `asWeb` and adds `href`.
- [ ] **Step 4:** tests, typecheck. **Commit:** `AOS-04 C1: the graph projection (list, node detail with Why connected?, neighbourhood, coverage, creative lens)`.

### Task 6: Global search (§16)

**Files:** create `knowledge/knowledge-graph/search.ts`; extend `graph.test.ts`.

- **Interface:** `searchIndex(sql, q, { perGroup = 8 }): { groups: { kind; label; total; hits: { id; title; domain; path; revision; href }[] }[]; asOf }`.
  - A case-insensitive substring match on title and path, with `%`, `_` and `\` escaped.
  - It searches the whole index, not a rendered subset.
- [ ] **Red test:**
  - a fixture file that sorts after the first 50 list rows is found by its name;
  - results are grouped by kind with totals;
  - `%` finds only titles containing `%`;
  - an excluded file's name finds nothing;
  - no match returns `groups: []`, which the page shows as the empty state.
- [ ] **Commit(s):** red, then `AOS-04 C1: global search over the whole index, grouped by type`.

### Task 7: The repository-file viewer (§15.2 file safety)

**Files:** create `apps/web/server/graph-files.ts` and its test; create `apps/web/app/index/files/[id]/page.tsx` and `apps/web/app/index/files/[id]/raw/route.ts`.

- **Interface:** `openIndexedFile(sql, root, id, { maxBytes = 262_144 }): { ok: true; file; text?; truncated } | { ok: false; reason: 'not-found' | 'changed' | 'escaped' | 'unreadable' }`.
  - `id` must be a UUID, or the result is `not-found`.
  - The server builds the path from the DB row; then `realpath` must stay under the root's `realpath`.
  - The checksum must match (else `changed`, choice 5).
- [ ] **Red test:**
  - `../../etc/passwd`, `/etc/passwd`, `C:\Windows\win.ini`, `\\server\share\x` and a random UUID all give `not-found`;
  - a row whose file was swapped for a symlink to `/etc/passwd` after the scan gives `escaped` and no bytes;
  - a modified file gives `changed` with both checksums;
  - a text file over the cap is truncated at a line boundary and says so;
  - `<script>` in a file comes back as text; the page renders it as text (React escaping, asserted in the smoke).
- [ ] **Implement:**
  - **The page:** path, owner and basis, checksum, size, MIME, indexed time, the preview in `<pre>`, and incoming/outgoing edges from `nodeDetail`.
  - **The raw route:** the Vault raw route's headers (`nosniff`, the sandbox CSP), `text/plain; charset=utf-8` for text, and images inline.
- [ ] **Commit(s):** red, then `AOS-04 C1: the safe repository-file viewer (opaque ids, root and symlink checks, checksum revalidation)`.

### Task 8: The UI (§13.1–13.2, §16)

**Files:** modify `apps/web/app/page.tsx`, `app/shell/nav.tsx` and `app/layout.tsx` (the search field); create `app/graph-ui.tsx`, `app/search/page.tsx`, `app/node/page.tsx` and `app/system/page.tsx`.

- **Command `/`:** below the metric strip, a **Graph** panel in List view (C2 adds the sphere and the Graph/List switch here).
  - **Header:** the lens switch (System / Creative, as links), the active domain filter, and the coverage line ("N entities in the index · last scan <time> · Details").
  - **Rows:** kind, title, domain chip (colour + label + icon), backing word (File / Record / Configuration), availability word. Paginated with GET params.
  - **Creative lens:** the six groups, each labelled with its type, count and filter text; opening a group lists its real members.
- **Inspector:** `/?node=<id>` replaces the right rail's pulse and activity (§13.1) with:
  - title, kind and status;
  - domain and exact source (path and line, or table and id), revision and as-of time;
  - the source preview, or a link to it;
  - outgoing and incoming connections, each with its relation word and a **Why connected?** disclosure that states the provenance exactly;
  - inherited targets, link history and diagnostics;
  - actions: open the destination; open the full node page (`/node?id=`, with "Back to graph").
  Below `lg` it renders under the list (the drawer layout from Plan B).
- **Left rail:** a "Domains" section with the six domains plus "Shared/Unassigned", each a link to `/?domain=…` (colour + label + icon, `aria-current` when active). A new primary item, **System** (`/system`).
- **Top bar:** the search field becomes "Search everything" (`/search?q=`). The Vault page keeps its own search.
- **`/search`:** results grouped by type with domain, path and revision. A result links to `/?node=<id>`, which loads the node's neighbourhood before focusing it (§16). No match is an explicit empty state.
- **`/system`:**
  - index scope (roots), last scan, eligible/indexed/failed counts, excluded counts per rule, the Vault check;
  - failures (paths) and diagnostics (file, line, specifier);
  - a **Rescan** button: an owner server action that runs a scan with trigger `owner` and shows the new scan's counts.
- [ ] **Test:** Task 10's smoke. The loaders behind every panel are unit-tested in Tasks 5–7.
- [ ] **Commit:** `AOS-04 UI: the Graph list, domain filters, lenses and inspector on Command; search everything; the System page`.

### Task 9: Saved vs Indexed (§15.2 item 5)

**Files:** modify `apps/web/server/ops.ts` and `app/vault/files/[id]/page.tsx`; extend `apps/web/server/loaders.test.ts`.

- **Two states on a Vault file's page:** "Saved" (the source row exists) and "Indexed for search" (`vault_embeddings` has the file for the current model).
- **Index now:** an owner action that runs `embedPending` (as `research-ops` already does after a promotion). On failure the page reads "Saved; indexing failed: <error>" and offers Retry.
- **Graph and name search** see the file as soon as it is saved, because they read `sources` live. The page says so, rather than implying the semantic index is the only index.
- [ ] **Red test:**
  - `fileDetail` reports `indexed: false` before `embedPending` and `true` after;
  - `indexFileOp` with an embedder seam that throws returns `{ ok: false, error }` and leaves the file saved.
- [ ] **Commit(s):** red, then `AOS-04 C1: Saved vs Indexed on Vault files, with Index now and Retry`.

### Task 10: The browser journey

**Files:** modify `apps/web/e2e/smoke.ts`.

- Every existing line stays.
- New checks:
  - **Scan:** `pnpm index scan` runs before the server starts, and `/system` shows the same eligible/indexed counts as `index_scans`;
  - **Search:** `/search?q=instrumentation-node` finds `apps/web/instrumentation-node.ts` (a file far past the first list page); opening it shows its checksum and preview;
  - **Imports:** in the inspector for `file:repo/apps/web/instrumentation-node.ts`, the "Why connected?" disclosure on its `imports` edge to `apps/web/lib/server.ts` names line 1;
  - **Workflows:** `workflow:retrieve-and-summarize` shows its steps, `step_uses_agent` → `agent:extractive-summarizer`, and `depends_on` `retrieve`;
  - **Links:** the journey's song → lineage link shows as `linked_to` with its row; after the journey unlinks it, it's in history, not in connections;
  - **Research chain:** the journey's run: brief → run → evidence → source, and the finding's inherited target labelled "Inherited from brief";
  - **Filters and lenses:** `/?domain=RECORDS` lists no CORE node; the creative lens shows the Songs group with the journey's song count;
  - **Viewer safety:** `/index/files/not-a-uuid` gives 404; `apps/web/app/layout.tsx`, which contains `<script>`, renders as text in the viewer (no script element inside the preview);
  - **390 px:** `/`, `/search`, `/system`, `/node?id=…` and `/index/files/<id>` have no horizontal page scroll;
  - **Screenshots:** `/` with the inspector open at 1440×900 and 390×844.
- [ ] **Commit:** `AOS-04: web:smoke drives the graph index (coverage, search past page one, Why connected?, chains, lenses, viewer safety)`.

### Task 11: Proof, docs, handoff

- `docs/proofs/AOS-04-graph-index.txt`:
  - the real repository's scan (counts per rule, the failures, the diagnostics count and a sample);
  - the entity counts per kind and domain;
  - three traced chains (an import, a workflow dependency, brief → source);
  - the viewer's refusals;
  - the gates.
- **ARCHITECTURE:**
  - **F46** "The graph and file index (AOS-04 Plan C1)": S1–S4 and this plan's seven choices, one line each; the relation vocabulary.
  - **F47** (open): tools as entities; `.env.example` handling; extra roots; Windows case and junction checks (this host is Linux, so they are tested by string rules only); suggested relations; the sphere, motion, answers and performance (C2).
- `SCHEMA.md` (Task 1), the AOS-04 handoff (a Plan C1 section), README.
- Run every gate and paste the summaries into the proof. **Commit:** `AOS-04 proof and docs: the graph and file index (F46 decided, F47 open)`.

## Out of scope: Plan C2 (outline; planned after C1 ships)

- **The sphere** (S2, §15.1, §18):
  - an in-house SVG renderer over C1's `graph_nodes`/`graph_edges`;
  - stable domain sectors and deterministic positions seeded by entity id;
  - screen-space labels, invisible 44 px hit areas, the XYP3RN hub from configuration;
  - overview budgets of 250 entities and 500 edges, with aggregates that disclose their members;
  - the Graph/List switch on Command.
- **Motion** (§18): hover, focus and selection timings; camera focus; "Pause motion"; reduced motion; stopping when the tab is hidden.
- **The command bar** (S4, §16): the answer from `retrieve-and-summarize`, with citations resolved to node IDs and the one / 2–3 / 4+ source focus rules. An unresolved citation is a warning, never a guessed node. With no source, it says the evidence is insufficient.
- **Performance** (§18): 60/30 fps, INP, LCP and CLS, measured and documented with device, dataset and method.

## §21 checklist rows this plan closes

- **Source reality:** a real repository file, a Vault file, an agent, a workflow, a song and a research finding, each opened to its exact source and revision; File vs Record labels.
- **Coverage:** eligible, indexed and failed reconciled on a controlled root; search past the first page; Shared, excluded, missing and unreadable files; nothing fabricated in an empty workspace.
- **Connections:** a workflow step dependency, a song-to-lineage link and brief → evidence → source, each with its exact provenance; the false title match; the unresolved diagnostic; the retraction.
- **Ownership:** six domains from taxonomy; X3LIUS under Records; the lenses sharing IDs; groups disclosing members.
- **File safety:** every refusal in Task 7.
- **Freshness:** Saved vs Indexed; "Saved; indexing failed"; a scan failure sealed and shown.
- **Accessibility:** keyboard search → inspect → source; the list as the sphere's equivalent (C2 keeps them in sync).
- **Still open for C2:** Visual (sphere), Answers, the rest of Accessibility/performance (graph/list parity with the sphere, the WebGL-loss question, which S2 removes, and the measured numbers).
