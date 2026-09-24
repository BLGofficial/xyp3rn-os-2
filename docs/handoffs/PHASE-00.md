HANDOFF — Phase 0 complete

- **Built:** a six-domain repo scaffold (`core/ knowledge/ research-intelligence/ records/ tech/ governance/` plus `docs/ agents/ supabase/ tests/`). The contracts are `docs/ARCHITECTURE.md`, `docs/AGENT_CLASSES.md` (8 classes plus a capability matrix), `docs/NAMING.md` and `agents/_template.agent.md`. `core/contracts/taxonomy.ts` holds the domain ids, dirs and colors plus the class ids, and `tests/phase-00/contracts.test.ts` (48 assertions) keeps the docs and the constant from drifting apart. Stack: TypeScript on Node 22 (native type stripping, `.ts` imports, no build), vitest, pnpm.
- **Key decisions:** the user chose four points:
  - local Postgres 16 + pgvector as `{{SUPABASE_PROJECT}}` for now;
  - domain directories at the repo root;
  - a temporary Phase 2 bootstrap canonical write through `xyp_ingest_bootstrap`, revoked in 6D (F1);
  - the Promotion Gate owned by the Knowledge Layer (F2).

  The capability matrix gives `canonical.write`, `approval.decide` and `audit.write` to no agent class.
- **Deviations from spec:** the root has more than the six domain directories, because `docs/`, `agents/`, `supabase/` and `tests/` are shared infrastructure. The Knowledge Layer has 7 sub-components, not 6, because the gate is placed there (F11). Research Intelligence reserves 6 components, not 8 (F6). The template's frontmatter has no `subdomain` key yet: Phases 7 and 14 add it as an explicit contract change, because the registry rejects unknown keys.
- **Open flags:**
  - F3, F4, F5, F6, F8, F9, F11 are proposed and stand unless overridden.
  - F7: least-privilege DB roles, to be finalized in Phase 1.
  - F10: hybrid-class agents, to be decided in Phases 11 and 13.
  - F13: confirm the 20-specialist roster before 6B.
- **Next phase needs:**
  - the table list and FK chain in `docs/ARCHITECTURE.md` (Knowledge section, F1, F7, F9);
  - migration and rollback naming in `docs/NAMING.md` (`supabase/migrations/…sql` + `supabase/rollbacks/…down.sql`);
  - the `xyp_*` role names in F7;
  - the first `sources` seed row: the uploaded `XYP3RN_Agentic_OS_Build_Sequence.pdf` at the repo root.
