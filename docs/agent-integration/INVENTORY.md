# Agent inventory ? 2026-10-03

Generated from both registries and byte comparison. See [audit snapshot](audit-snapshot.json) for SHA-256, model, tool and source-contract details. The template is excluded from agent counts.

| Source agent | Class | Comparison | Migration disposition |
|---|---|---|---|
| ai-vocal-systems-researcher | Research | model-only | Keep target model; preserve scope |
| artist-identity-researcher | Research | model-only | Keep target model; preserve scope |
| benchmark-scoring-methodology-researcher | Research | model-only | Keep target model; preserve scope |
| brand-persona-consistency-researcher | Research | model-only | Keep target model; preserve scope |
| composition-arrangement-researcher | Research | model-only | Keep target model; preserve scope |
| context-retriever | Knowledge | identical | Keep target; prove runtime path |
| evaluation-researcher | Research | model-only | Keep target model; preserve scope |
| extractive-summarizer | Knowledge | identical | Keep target; prove runtime path |
| frontier-tool-scanner-researcher | Research | model-only | Keep target model; preserve scope |
| genre-style-researcher | Research | model-only | Keep target model; preserve scope |
| governance-legal | Governance | source-only | Port dependencies and adapt before enabling |
| governance-rights-conflict | Governance | source-only | Port dependencies and adapt before enabling |
| health-check | Execution | identical | Keep target; prove runtime path |
| lyrics-rhyme-systems-researcher | Research | model-only | Keep target model; preserve scope |
| mix-master-ai-tooling-researcher | Research | model-only | Keep target model; preserve scope |
| model-version-changelog-researcher | Research | model-only | Keep target model; preserve scope |
| negative-prompt-failure-mode-researcher | Research | model-only | Keep target model; preserve scope |
| prompt-engineering-researcher | Research | model-only | Keep target model; preserve scope |
| prompt-formula-template-researcher | Research | model-only | Keep target model; preserve scope |
| records-catalog | Execution | contract-drift | Keep target contract; verify source intent |
| records-release-calendar | Execution | contract-drift | Keep target contract; verify source intent |
| records-rights-splits | Governance | contract-drift | Keep target contract; verify source intent |
| release-strategy-platform-algo-researcher | Research | model-only | Keep target model; preserve scope |
| research-orchestrator | Planning | identical | Keep target; prove runtime path |
| rights-licensing-researcher | Research | model-only | Keep target model; preserve scope |
| songwriting-structure-researcher | Research | model-only | Keep target model; preserve scope |
| suno-researcher | Research | model-only | Keep target model; preserve scope |
| suno-submitter | Execution | contract-drift | Keep target contract; verify source intent |
| tech-r-and-d | Planning | contract-drift | Keep target contract; verify source intent |
| udio-alt-platform-researcher | Research | model-only | Keep target model; preserve scope |
| voice-cloning-researcher | Research | model-only | Keep target model; preserve scope |
| x3lius-arrangement | Creative | identical | Keep target; prove runtime path |
| x3lius-composition | Creative | identical | Keep target; prove runtime path |
| x3lius-evaluation | Critic | identical | Keep target; prove runtime path |
| x3lius-genre-style | Creative | identical | Keep target; prove runtime path |
| x3lius-lyrics | Creative | identical | Keep target; prove runtime path |
| x3lius-mix-master | Creative | identical | Keep target; prove runtime path |
| x3lius-production | Creative | identical | Keep target; prove runtime path |
| x3lius-revision | Revision | identical | Keep target; prove runtime path |
| x3lius-rvc-post | Execution | identical | Keep target; prove runtime path |
| x3lius-songwriting | Creative | identical | Keep target; prove runtime path |
| x3lius-suno | Creative | identical | Keep target; prove runtime path |
| x3lius-vocal-dna | Knowledge | identical | Keep target; prove runtime path |

## Target-only agents: preserve all 10

- `records-catalog-lookup` (Knowledge)
- `records-songs` (Execution)
- `records-tasks` (Execution)
- `tech-ai-systems` (Knowledge)
- `tech-audio-tools` (Execution)
- `tech-products` (Knowledge)
- `vault-curator` (Execution)
- `x3lius-lyric-editor` (Creative)
- `x3lius-studio-editor` (Creative)
- `x3lius-suno-package` (Creative)

`tech-products` and `tech-ai-systems` have manifest stub handlers. Preserve that truthful status; this integration does not require building their future features.
