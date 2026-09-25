# AOS-02 — Command Center + catalog: implementation plan

Design: [AOS-02-design.md](AOS-02-design.md). Red tests first: each step's tests are committed failing, then turned green.

## Order

1. **Red DB tests** `tests/aos-02/command-db.test.ts` (§4), then:
   - migration `20260925150000_command_center` + rollback;
   - a round trip on the local DB;
   - the Phase 1 FK snapshot updated for the new FKs.
2. **Vault-audio tracks** (§4.6, §5):
   - red tests;
   - `register_track`, `read_catalog`, `records-catalog-lookup`, the Rights check and `register-track.workflow.yaml`;
   - the Phase 13 suite stays green.
3. **Catalog operations and tasks** (§5):
   - red `catalog-agents.test.ts`;
   - the new `catalog.write` tools and `records-catalog` operations;
   - `task.write` (code + doc) and `records-tasks`.
4. **Export** (§7): the new tables in `knowledge/vault-io` (closure seeds and children); the AOS-01 export tests stay green.
5. **The gate** (§8): red `idea-to-release.test.ts`, then whatever it exposes.
6. **UI** (§6):
   - red loader/ops tests;
   - the screens `/`, `/releases`, `/releases/[id]`, `/people` and `/tasks`, plus the song workspace additions;
   - `pnpm web:smoke` extended.
7. **Proof** `docs/proofs/AOS-02-command-center.txt`: the tests, the gate journey, the browser smoke run, the gates.
8. **Docs:**
   - SCHEMA, AGENT_CLASSES (`task.write`), ARCHITECTURE (F38 decided, F39 open);
   - `docs/handoffs/AOS-02.md`;
   - the README.

## Gates before each push

`pnpm typecheck`, `pnpm test` (the full suite), `pnpm agents:validate`, a migration round-trip, and `pnpm web:build`.
