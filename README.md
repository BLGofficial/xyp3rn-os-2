# XYP3RN Agentic OS 2

A six-domain agent operating system: CORE, KNOWLEDGE, RESEARCH_INTELLIGENCE, RECORDS (X3LIUS Music System), TECH, GOVERNANCE. It is built phase by phase following `XYP3RN_Agentic_OS_Build_Sequence.pdf` (Phase 0 → 17).

- Architecture and invariants: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Agent classes and the capability matrix: [docs/AGENT_CLASSES.md](docs/AGENT_CLASSES.md)
- Naming: [docs/NAMING.md](docs/NAMING.md)
- Agent file template: [agents/_template.agent.md](agents/_template.agent.md)
- Phase handoffs: [docs/handoffs/](docs/handoffs/)

## Develop

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm db:setup    # local Postgres 16 + pgvector + emulated Supabase roles (Debian/Ubuntu; idempotent)
pnpm db:up       # apply migrations
pnpm ingest --file XYP3RN_Agentic_OS_Build_Sequence.pdf --origin first_party   # Phase 2 ingestion
pnpm embed       # Phase 3: gte-small embeddings (model downloads to .local-models/ on first use)
pnpm context "your question"   # ranked, traceable context bundle
pnpm agents:validate            # Agent Registry: validate agents/*.agent.md
pnpm dispatch health-check '{"ping":"xyp"}'   # run an agent end to end, print its agent_runs row
pnpm route "your request"       # domain routing decision with evidence
pnpm ask "your request"         # front door: route → plan → run the domain entrypoint (research, X3LIUS sub-domains)
pnpm ingest --file records/x3lius/music-system.manifest.yaml --origin first_party   # Phase 7: X3LIUS module + 10 sub-domains via the gate
pnpm research <cmd> '<json>'    # 6C engines by hand: observation, cite, finding, candidate, eligibility, resolve, experiment:*
pnpm gate run <candidateId>     # 6D Promotion Gate: the nine-step state machine, the only canonical writer
pnpm gate queue                 # pending human approvals with the gate's reasons
pnpm gate decide <approvalId> approve|reject "<approver>" "<reason>"   # operator decision, then re-run the gate
pnpm workflow core/workflows/retrieve-and-summarize.workflow.yaml '{"query":"..."}'
pnpm test        # vitest: phase proofs + unit tests (DB tests use throwaway databases)
pnpm typecheck   # tsc --noEmit
```

Schema and access model: [docs/SCHEMA.md](docs/SCHEMA.md).

## Build status

- [x] Phase 0: Foundation / Contracts
- [x] Phase 1: Supabase canonical data model
- [x] Phase 2: Knowledge ingestion + normalization
- [x] Phase 3: Retrieval / context engine
- [x] Phase 4: Agent runtime + registry (4A–4E)
- [x] Phase 5: Workflow / orchestration engine
- [ ] Phase 6: AI Music Research Intelligence (6A–6D)
