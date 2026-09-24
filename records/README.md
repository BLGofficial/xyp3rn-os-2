# records/ — RECORDS

X3LIUS Music System (Phases 7–12) + Records ops (Phase 13). Contract: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#records--xyp3rn-records).

## x3lius/ — X3LIUS Music System (Phase 7)

- `music-system.manifest.yaml`: the parent module and its ten sub-domains. This first-party data is admitted through the Promotion Gate (`pnpm ingest --file … --origin first_party`).
- `music-system.ts`: loads the manifest and selects sub-domains for a request by each stub's `## Scope` keywords.
- `entrypoint.ts`: the RECORDS entrypoint (`pnpm ask`). It runs the selected sub-domain stubs through the Workflow Engine; when nothing matches it asks for clarification.
- `subdomain-stub.ts`: the handler shared by the ten `agents/x3lius-*.agent.md` stubs. It has no creative logic and returns the Context Engine scoped to its own module.
- **Propagation:** a candidate tagged `x3lius-<sub-domain>` is placed by the gate in that module, which puts it on the sub-domain's context path.

