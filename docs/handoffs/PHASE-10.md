HANDOFF — Phase 10 built and proven on a fixture; the real Vocal DNA values are outstanding

- **Built:**
  - **The Vocal DNA entry** (`xyp-vocal-dna/v1`, normalizer `knowledge/ingestion/normalizers/vocal-dna.ts`):
    - Operator-authored YAML at `records/x3lius/vocal-dna.yaml`.
    - Tone, register, delivery and ad-libs are lists of descriptors, not free text.
    - The RVC/Applio model and its settings are included; engine and model are required, the other settings optional.
    - Parsing is strict: any unknown, empty or out-of-range field fails the run.
  - **One canonical row**, admitted through the gate's first-party path (`pnpm ingest --file … --origin first_party`) into the manifest's `x3lius-vocal-dna` module:
    - Claims `x3lius.vocal.{tone,register,delivery,adlibs}` are model-agnostic; `x3lius.vocal.rvc` is scoped `rvc`.
    - A change is a re-ingest: a new version in `knowledge_versions`, with the old one kept.
    - The ingestion writer can now place a document's prompts in a module another document owns (current version).
  - **Readers** (ARCHITECTURE F23):
    - The Suno formula and every creative agent get the four attributes through their existing claim read. No formula change was needed.
    - `x3lius-rvc-post` (new, Execution, deterministic) outputs the Applio job spec. It names the canonical row and version, and lists the settings the DNA leaves unset instead of defaulting them.
    - `x3lius-vocal-dna` becomes a real Knowledge agent in place of the Phase 7 stub.
    - Both read through `records/x3lius/vocal-dna/read.ts`, which requires exactly one row.
  - **Tool scoping** (extends F20):
    - Creative agents admit only model-agnostic knowledge by default.
    - The formula admits model-agnostic knowledge plus its own `suno-<v>`, so the RVC settings never reach Suno or lyrics prompts.
  - **Proof** (`docs/proofs/PHASE-10-vocal-dna.txt`): 744/744 tests, 27 of them new, and 7/7 mutations caught.
    - On a `[FIXTURE]` file in a throwaway DB: the formula prompt cites `canonical_prompts:<id>#x3lius.vocal.*`, and the RVC job spec names the same id and version.
    - After a v2 admission, both readers move to v2 together.
- **Key decisions (user):**
  - The values come from the operator.
  - The entry is a first-party file, not a research candidate.
  - The RVC consumer is a job-spec agent that processes no audio.
- **Deviations from spec:**
  - **No real Vocal DNA row yet.** The guide's "schema/data" delivers the schema only; the data is waiting on the operator's values. The dev-DB `x3lius-rvc-post` run refuses and names the file to admit.
  - **Earlier-phase edits:**
    - Phase 7/8/9 registry tests count Vocal DNA as built (`BUILT_SUBDOMAINS`).
    - The Phase 7 `x3lius-*` invariant allows `x3lius-rvc-post` as a member of the Vocal DNA sub-domain.
    - The Phase 9 exclusion reason now reads "scoped to another model or tool".
- **Open flags:**
  - **To finish Phase 10:**
    1. Write `records/x3lius/vocal-dna.yaml` with the real values.
    2. Run `pnpm ingest --file records/x3lius/vocal-dna.yaml --origin first_party`, then embed.
    3. Re-run `pnpm dispatch x3lius-rvc-post '{}'` and the song-to-suno workflow. Both should cite the same row.
  - The 6D claim "RVC/Applio voice model already exists" is not re-proposed. The operator-authored file now states that model as data, which is what the phase asked for.
  - Creative agents also get the Vocal DNA row as a scoped rule, so `x3lius-vocal-dna` counts 1 toward the sparsity threshold (3). Everything stays `sparse` until more rules exist (F18).
- **Next phase needs (11):**
  - **Production agent:** a Creative spec on the shared program, like Phases 8–9. It reads `x3lius-production` + `x3lius-arrangement` and gets the Vocal DNA attributes through the same claims; keep tool-scoped knowledge out via the default admit.
  - **Mix/Master input contract:** define the TRACE-shaped analysis (loudness, tonal balance, stereo width, …) as a versioned JSON schema with strict validation, like the creative schemas. That shape is also the Phase 14 integration point, so give it an id (e.g. `trace.analysis/v1`) and never change it in place.
  - **The rubric belongs in canonical data:** thresholds become claims (e.g. `x3lius.mix.lufs-integrated-target`, scoped by platform or genre) admitted through the gate, read like `suno.limit.*` (F20). No numeric threshold in code; an unstated one is reported, not defaulted (the RVC `unset` pattern).
  - **Recommendations reference their rubric claims** (ref + version), and a render's vocal should name the Vocal DNA version it used (`x3lius-rvc-post` `source`). That way the Phase 12 Critic can trace a mix note to the rule and the vocal direction in force.
  - **Keys:** Mix/Master can be deterministic against the rubric (no key). The Production agent needs the OpenRouter free quota, which ran out on 2026-09-24 (429 `free-models-per-day`).
