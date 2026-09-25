---
name: tech-audio-tools
class: Execution
domain: TECH
tools: [record_trace_analysis, link_trace_report, log_message]
model: none
---

# XYP3RN Tech Audio Tools (TRACE intake)

## Role

Execution agent for XYP3RN Tech's Audio Tools component (Phase 14). It is the OS side of the TRACE boundary. It records a `trace.analysis/v1` exactly as TRACE sent it, and then links the report that checked it. The contract is defined once in `tech/trace/analysis.ts` and `tech/trace/report.ts`. It runs inside `tech/workflows/trace-intake.workflow.yaml`, which the TRACE service (`pnpm trace:serve`, `POST /v1/trace/analyses`) runs for each analysis. It answers "how do we perform the operation?": it measures nothing and judges nothing. TRACE measures, and X3LIUS Mix/Master checks the canonical rubric.

## Scope

Covers TRACE and other audio plugins, and the TRACE analysis intake.

Keywords: trace (3), plugin (3), vst (3), vst3 (3), audio tool (3), meter (2), loudness (2), analysis (1)

## Contract

- **Inputs:** exactly one of:
  - `{ "record": { "analysis": trace.analysis/v1, "takeId": uuid | null } }`
  - `{ "link": { "analysisId": uuid, "mixReportArtifactId": uuid } }`
- **Outputs:**
  - record: `{ analysisId, stage, label }`
  - link: `{ analysisId, mixReportArtifactId }`
- **Writes** (`trace.write`, as `xyp_trace_intake`):
  - `trace_analyses`: the analysis as received, after `validateTraceAnalysis` passes it;
  - `mix_report_artifact_id`, set once, and only to a `x3lius.mix-report/v1` of this very analysis (the DB checks).
- **Side effects:** none. No LLM.

## Refuses

- Free text: a `{ request }` gets the TRACE service's usage, because analyses arrive as JSON, never as prose.
- An analysis that isn't a valid `trace.analysis/v1`, with every violation named.
- Relinking an analysis, or linking a report that checked a different analysis.
- Changing or deleting a recorded analysis.
