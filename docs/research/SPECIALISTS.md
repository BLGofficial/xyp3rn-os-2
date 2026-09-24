# Research Specialists (Phase 6B)

Generated from each specialist's `## Scope` section by `pnpm specialists:table`. Do not edit by hand: `tests/phase-06b` fails if this file drifts from the agent files.

No-overlap rule, checked by test: a defining keyword (weight 3) belongs to exactly one specialist, and no pair shares enough keyword weight to reach the selection threshold on shared terms alone.

| # | Specialist | Scope (one sentence) | Defining keywords (weight 3) | Supporting keywords |
|---|---|---|---|---|
| 1 | `ai-vocal-systems-researcher` | Gathers evidence on how AI music models render sung and rapped vocals — timbre, register and delivery — per model version. | vocal | timbre (2), baritone (2), register (2), falsetto (2), rap delivery (2), singer (2) |
| 2 | `artist-identity-researcher` | Gathers evidence on keeping an artist's sonic identity — signature voice character and sound — consistent across AI generations, anchored on X3LIUS. | artist identity, sonic identity, x3lius, dark baritone | signature sound (2), consistency (1) |
| 3 | `benchmark-scoring-methodology-researcher` | Gathers evidence on quantitative scoring for generated music — metrics, rubrics, reference datasets and their known biases. | benchmark, metric, rubric, clap score | scoring (2), score (2), dataset (2), fad (2) |
| 4 | `brand-persona-consistency-researcher` | Gathers evidence on keeping the non-sonic persona consistent — lyrical voice, visual identity, narrative and public persona — across AI-generated output. | persona, brand | visual identity (2), cover art (2), narrative (2), aesthetic (2), brutalism (2) |
| 5 | `composition-arrangement-researcher` | Gathers evidence on how AI models handle composition and arrangement — chord progressions, instrumentation, layering and dynamics — per model version. | arrangement, composition | chord (2), progression (2), instrumentation (2), melody (2), 808 (2), layering (2) |
| 6 | `evaluation-researcher` | Gathers evidence on how to judge whether one generation or method is better than another — listening criteria, A/B judgment protocols and reviewer agreement. | evaluation, evaluate, best current method, listening test | best (2), better (2), a/b (2), quality (2) |
| 7 | `frontier-tool-scanner-researcher` | Scans for newly released or announced AI music and audio tools not yet covered by another specialist, recording what each claims to do. | frontier, emerging, new tool | announced (2), beta (2), launch (2) |
| 8 | `genre-style-researcher` | Gathers evidence on how genre and style descriptors such as dark melodic trap are interpreted, blended and weighted by AI music models, per model version. | genre, subgenre | trap (2), drill (2), style blend (2), dark melodic (2), bpm (2), tempo (2) |
| 9 | `lyrics-rhyme-systems-researcher` | Gathers evidence on how lyrics, rhyme schemes, flow and bilingual Bulgarian/English lines are rendered and pronounced by AI models, per model version. | lyric, rhyme, bulgarian | flow (2), syllable (2), bars (2), bilingual (2), pronunciation (2) |
| 10 | `mix-master-ai-tooling-researcher` | Gathers evidence on AI-assisted mixing and mastering tools and their measurable effect on loudness, tonal balance and stereo image, per tool version. | mastering, mixing, lufs | loudness (2), stereo width (2), tonal balance (2), limiter (2) |
| 11 | `model-version-changelog-researcher` | Tracks official changelogs and release notes of the AI music and voice tools already in the stack, recording what changed in each model version. | changelog, release note | new version (2), model update (2), deprecated (2) |
| 12 | `negative-prompt-failure-mode-researcher` | Gathers evidence on how generations fail (artefacts, genre drift, lyric mangling) and which exclusions or negative prompts prevent each failure, per model version. | failure mode, negative prompt | artefact (2), artifact (2), glitch (2), drift (2), mangled (2), exclude (2) |
| 13 | `prompt-engineering-researcher` | Gathers evidence on prompting techniques that reliably steer AI music generation — ordering, emphasis, specificity and control phrasing — per model version. | prompt engineering | controlling (2), control (2), steer (2), steering (2), phrasing (2), emphasis (2), method (1), technique (1) |
| 14 | `prompt-formula-template-researcher` | Gathers evidence on reusable prompt structures (formulas, templates, slot orders) and which variants outperform others per model version. | prompt formula, prompt template | template (2), formula (2), slot order (2) |
| 15 | `release-strategy-platform-algo-researcher` | Gathers evidence on distribution and platform-algorithm behaviour — release timing, playlisting, short-form video and recommendation signals — for released tracks. | release strategy, algorithm | playlist (2), streaming (2), tiktok (2), spotify (2), release timing (2), distribution (2) |
| 16 | `rights-licensing-researcher` | Gathers evidence on the licensing terms, ownership rules and commercial-use rights attached to AI-generated music and voice models, per platform and plan. | license, licensing, copyright, commercial use | ownership (2), terms of service (2), royalty (2) |
| 17 | `songwriting-structure-researcher` | Gathers evidence on song structure in AI-generated tracks — section order, hook placement, song length and how section tags are followed — per model version. | song structure, songwriting | hook (2), chorus (2), verse (2), bridge (2), section tag (2), intro (1), outro (1) |
| 18 | `suno-researcher` | Gathers evidence on how Suno's generation models interpret style prompts, lyrics formatting and meta-tags, recorded per Suno model version. | suno | meta-tag (2), style prompt (2), lyrics formatting (2), custom mode (2) |
| 19 | `udio-alt-platform-researcher` | Gathers evidence on Udio and other non-Suno music-generation platforms, recorded per platform and model version. | udio, stable audio, musicgen, riffusion | alternative platform (2), alt-platform (2) |
| 20 | `voice-cloning-researcher` | Gathers evidence on voice-conversion tooling (RVC, Applio) — training-data needs, model settings and artefacts — per tool version. | rvc, applio, voice cloning, voice conversion | voice model (2), pitch extraction (2), index rate (2) |

## Adjacent pairs: where the line is

| Specialist | Specialist | Split |
|---|---|---|
| `ai-vocal-systems-researcher` | `artist-identity-researcher` | how models render vocals in general vs keeping one artist's signature consistent |
| `artist-identity-researcher` | `brand-persona-consistency-researcher` | sonic identity vs non-sonic persona (visuals, narrative, public voice) |
| `evaluation-researcher` | `benchmark-scoring-methodology-researcher` | human judgment protocols vs quantitative metrics and datasets |
| `model-version-changelog-researcher` | `frontier-tool-scanner-researcher` | new versions of tools already in the stack vs tools not yet in it |
| `prompt-engineering-researcher` | `prompt-formula-template-researcher` | individual steering techniques vs whole reusable templates |
| `songwriting-structure-researcher` | `lyrics-rhyme-systems-researcher` | section structure and hook placement vs lyric content, rhyme and pronunciation |
| `suno-researcher` | `udio-alt-platform-researcher` | Suno only vs every other generation platform |
| `genre-style-researcher` | `composition-arrangement-researcher` | descriptor interpretation vs harmonic and instrumental content |
