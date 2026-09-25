# records/ — RECORDS

X3LIUS Music System (Phases 7–12) + Records ops (Phase 13). Contract: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#records--xyp3rn-records).

## x3lius/ — X3LIUS Music System (Phase 7)

- `music-system.manifest.yaml`: the parent module and its ten sub-domains. This first-party data is admitted through the Promotion Gate (`pnpm ingest --file … --origin first_party`).
- `music-system.ts`: loads the manifest and selects sub-domains for a request by each stub's `## Scope` keywords.
- `entrypoint.ts`: the RECORDS entrypoint (`pnpm ask`). It runs the selected sub-domain stubs through the Workflow Engine; when nothing matches it asks for clarification.
- `subdomain-stub.ts`: the handler shared by the ten `agents/x3lius-*.agent.md` stubs. It has no creative logic and returns the Context Engine scoped to its own module.
- **Propagation:** a candidate tagged `x3lius-<sub-domain>` is placed by the gate in that module, which puts it on the sub-domain's context path.

## ops/ — Records ops (Phase 13)

The catalog, rights splits and the release calendar: `releases`, `tracks` and `rights_splits` (migration `20260925110000_records_ops`). The DB rules are:

- each split set sums to exactly 100 at commit;
- `payee: null` is the explicit unassigned share;
- a release can't be scheduled with an unassigned share or without a passing Rights run.

Files:

- `tools.ts`: the six tools, each under its own DB role.
  - `resolve_take` and `read_catalog` (`catalog.read`, `xyp_runtime`);
  - `register_track`, `write_splits` and `assign_codes` (`catalog.write`, `xyp_catalog`);
  - `schedule_release` (`catalog.write`, `xyp_release_calendar`).
- `catalog/lookup.ts` (`records-catalog-lookup`, Knowledge) resolves a take's chain into a fully specified registration. `catalog/catalog.ts` (`records-catalog`, Execution) performs it, and writes split sets and codes. This is the F10 split.
- `rights-splits/check.ts` (`records-rights-splits`, Governance) runs four rules, each reported. A `flag` is a successful run whose flags are data.
- `release-calendar/calendar.ts` (`records-release-calendar`, Execution) handles scheduling only, and only on a pass for the same release.
- `ops-hint.ts`: `pnpm ask` answers a Records ops request with these commands. Ops run on ids, dates and percentages, never on free text.
- `../workflows/register-track.workflow.yaml` runs lookup → catalog. `../workflows/schedule-release.workflow.yaml` runs rights → calendar.
