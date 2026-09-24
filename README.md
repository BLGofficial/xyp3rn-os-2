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
# Cloud sessions: scripts/session-start.sh (SessionStart hook in .claude/settings.json) runs the
# setup below automatically — DB, migrations, guide + X3LIUS manifest ingest, embeddings.
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
pnpm dispatch x3lius-lyrics '{"request":"..."}'   # Phase 8 Creative agent (also x3lius-songwriting, x3lius-composition); needs the key for its model's provider
pnpm workflow records/x3lius/song-to-suno.workflow.yaml '{"request":"...","sunoModel":"v5"}'   # Phase 9: brief → Suno-ready prompt artifact
pnpm dispatch suno-submitter '{"submit":{"formulaArtifactId":"<id>","adapter":"manual"}}'       # Phase 9: submit (manual | sunoapi); then {"capture":{...}}
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
- [x] Phase 6: AI Music Research Intelligence (6A–6D; the 20 specialists still need an LLM program to run)
- [x] Phase 7: X3LIUS Music Intelligence (module + ten sub-domains, scoped context path)
- [x] Phase 8: Songwriting + Lyrics agents, plus Composition (F15). Live verse produced with Nemotron via OpenRouter ([handoff](docs/handoffs/PHASE-08.md))
- [x] Phase 9: Suno Generation System, plus Genre/Style (F15). Live brief-to-Suno-prompt produced with Nemotron via OpenRouter: whole-song lyrics against the structure, hook in every chorus; no Suno take yet ([handoff](docs/handoffs/PHASE-09.md))
- [~] Phase 10: Vocal / Artist DNA. Built and proven on a fixture; waiting on the operator's real Vocal DNA values ([handoff](docs/handoffs/PHASE-10.md))
- [ ] Phase 11: Production / Mix / Master
- [~] Phase 12: Critic + Revision System. Built and proven on the FAKE model (both loop proofs, 6C scoring through the Critic); not run live yet, no model key ([handoff](docs/handoffs/PHASE-12.md))
- [ ] Phase 13: XYP3RN Records
- [ ] Phase 14: XYP3RN Tech
- [ ] Phase 15: Legal / Governance
- [ ] Phase 16: UI / Observability / Graph View / Command Center (16A–16D)
- [ ] Phase 17: End-to-End Validation
