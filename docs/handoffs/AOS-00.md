HANDOFF — Artist OS AOS-00 (baseline) complete; four decisions needed before AOS-01

- **Built:**
  - `docs/artist-os/PLAN.md` holds the operator's Artist OS plan verbatim; it is the source for AOS-00 → AOS-08.
  - `docs/artist-os/AOS-00-baseline.md` holds the deliverables:
    - the current-state map: every plan component, its owner module, and whether it is built, partial or missing, with evidence;
    - 21 numbered gaps, each with an owner and a phase;
    - a dependency map (mermaid) and the implementation order, which is the plan's order plus one prerequisite step;
    - seven places where the plan and the running system disagree;
    - the owner table for every proposed module.
  - `tests/aos-00/single-kernel.test.ts` makes the gate executable. It requires that each of the 15 kernel entry points is defined in one file (its owner), that there is one migrations and one rollbacks directory, and that agent files live only in `agents/`. Both mutations were caught (a parallel `createAgentRegistry`, a second migrations directory).
- **Baseline** (`main` + Phase 14, PR #13): 45 agents, 21 tools, 19 capabilities, 37 tables, 5 workflows, 1012 tests.
  - Built: kernel, knowledge, research engines, the Suno manual path and releases.
  - Missing: songs, file bytes, UI, voice, scheduler, analytics, evaluation cases.
- **Disagreements with the plan** (the §5 numbering):
  - C1: this repo's ids are UUID v4 (`gen_random_uuid()`), not v7.
  - C2: F14 still auto-approves canonical changes, but the plan wants every canonical method change owner-approved.
  - C3: F21 keeps section tags in code, but the plan wants versioned meta-tag sets.
  - C4: old Phases 15–17 overlap this plan.
  - C6: Spotify and Apple Music have no public artist-analytics API, to my knowledge (unverified).
  - C7: the research specialists can't run live.
  - Found while doing this: PR #12 was merged at its Phase 13 head. Phase 14 is re-proposed in PR #13 (rebased, same tree).
- **Decisions** (operator, 2026-09-25; the recommendation each time):
  - D1: keep UUID v4.
  - D2: F14 auto-approval off.
  - D3: old Phases 15–17 absorbed into AOS (the Graph View dropped unless asked).
  - D4: a local content-addressed store (`.vault/<sha256>`) behind one storage interface, with Supabase Storage as a later adapter.
- **Next phase needs (AOS-01):**
  1. D2 implemented, plus G20 (the prerequisite step P, before any AOS-01 table).
  2. The G20 prerequisite migration: `service_role` is read-only on the earlier-phase tables.
  3. Owners: the `songs` table in RECORDS; bytes and ingestion in `knowledge/source-registry` + `knowledge/ingestion`; search in `core/context-engine`; the Vault browser in `apps/web` (Next.js 14).
  4. Export / re-import with links (the AOS-01 gate) builds on `knowledge_versions` and artifact lineages. There is no second store.
