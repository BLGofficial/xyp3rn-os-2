# AOS-03 — Studio mode and Suno-ready workflows: implementation plan

Design: [AOS-03-design.md](AOS-03-design.md). Red tests first: each step's tests are committed failing, then turned green.

## Order

1. **Red DB tests** `tests/aos-03/studio-db.test.ts` (§4.2), then:
   - migration `20260925160000_studio` + rollback;
   - a round trip on the local DB;
   - `tests/helpers/package-fixture.ts`, and the fixtures that inserted bare formula submissions moved onto it;
   - the Phase 1 FK snapshot updated.
2. **Schemas and the studio editor** (§4.1, §5):
   - red tests;
   - the three schemas;
   - `renderWithTags` and `defaultTagSet`;
   - `x3lius-studio-editor`.
3. **The package** (§5):
   - red tests;
   - `x3lius-suno-package`;
   - `build-suno-package.workflow.yaml`;
   - optional inputs in the engine and `register-track`.
4. **The submitter** (§5):
   - red tests;
   - package-only submit with the readiness check;
   - Vault takes;
   - `rate_take` and `feedback.write` (code and doc);
   - the Phase 9 submit tests moved to packages.
5. **Export** (§7): `take_ratings`, the new closure rules, and the import order. The AOS-01 and AOS-02 export tests stay green.
6. **The gate** (§8): red `idea-to-take.test.ts`, then whatever it exposes.
7. **The package export:** `packageExport`, and `pnpm studio export`.
8. **UI** (§6):
   - red loader/ops tests;
   - `/studio`, the recipe, tag set and package pages, and the song workspace's Studio section;
   - `pnpm web:smoke` extended.
9. **Proof** `docs/proofs/AOS-03-studio.txt`: the tests, the gate journey via the CLIs, the browser smoke run, the gates.
10. **Docs:**
    - SCHEMA, AGENT_CLASSES (`feedback.write`), ARCHITECTURE (F40 decided, F41 open);
    - `docs/handoffs/AOS-03.md`;
    - the README.

## Gates before each push

`pnpm typecheck`, `pnpm test` (the full suite), `pnpm agents:validate`, a migration round-trip, and `pnpm web:build`.
