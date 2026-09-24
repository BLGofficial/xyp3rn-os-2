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
pnpm test        # vitest: phase proofs + unit tests (DB tests use throwaway databases)
pnpm typecheck   # tsc --noEmit
```

Schema and access model: [docs/SCHEMA.md](docs/SCHEMA.md).

## Build status

- [x] Phase 0: Foundation / Contracts
- [x] Phase 1: Supabase canonical data model
- [ ] Phase 2: Knowledge ingestion + normalization
