# XYP3RN DAW Brain — Evaluation Engine & Production Workflows (Phase 18)

Measurable cross-subsystem evaluation harness (`core/daw-brain/evaluation/`) and 10 canonical `xyp3rn.workflow/v3` DAW production workflows (`core/daw-brain/workflows/`).

---

## 1. 11 Evaluation Categories & Pre-Registered Baseline Thresholds

Every evaluation run checks all 11 dimensions against fixed `DEFAULT_DAW_BASELINE_THRESHOLDS` without post-hoc threshold tuning or masking failed cases:

| Evaluation Category | Min Accuracy | Max Failures | Verified Ground Truth Scope |
| :--- | :--- | :--- | :--- |
| `daw_detection_accuracy` | `100.0%` | `0` | Online vs offline/uninstalled host reachability truthfulness |
| `state_observation_accuracy` | `95.0%` | `0` | Tempo BPM, mixer channel availability, saved `.flp`/`.rpp` SHA-256 & container truth |
| `session_model_completeness` | `100.0%` | `0` | All 7 states (`observed`, `cached`, `stale`, `proposed`, `applied`, `saved`, `unknownFields`) & live drift |
| `plugin_identification_accuracy` | `95.0%` | `0` | Controlled VST3/native profiles, role tagging & Producer Edition exclusions (`Harmor`) |
| `parameter_interpretation_accuracy` | `95.0%` | `0` | `[0.0, 1.0]` clamping, writable metadata & out-of-range refusal |
| `audio_analysis_accuracy` | `95.0%` | `0` | Analytical `1000 Hz -6.02 dBFS` sine, clipped, low-mid mud, balanced pass, & `L=-R` phase inversion |
| `routing_interpretation_accuracy` | `95.0%` | `0` | `DawRoutingGraph` master sinks, signal-flow edges, dead-end buses & isolated orphan insert detection |
| `agent_recommendation_quality` | `90.0%` | `0` | Deterministic specialist routing, analyze-by-default isolation & evidence-grounded advice |
| `command_validation_correctness` | `100.0%` | `0` | Zero tolerance for unsafe gain, Master `>0 dBFS`, non-allowlisted, mismatched project, or wrong class |
| `execution_reliability` | `100.0%` | `0` | Dry-run fidelity, human approval gate, postcondition readback & duplicate idempotency blocking |
| `recovery_behavior` | `100.0%` | `0` | Exact `beforeState` rollback & timeout partial-mutation compensating rollback recovery |

Every `DawEvaluationCaseResult` records `caseId`, `provenance` (`datasetId`, `sourceKind`, `sha256`, `manuallyVerifiedBy`, `verifiedAt`), `expectedOutput`, `actualOutput`, `error`, `confidence`, `evidence`, `passed`, and `limitations`. If any category breaches its baseline, `overallPassed` evaluates strictly to `false`.

---

## 2. 10 Canonical DAW Production Workflows (`xyp3rn.workflow/v3`)

| Workflow Name | Domain | Purpose |
| :--- | :--- | :--- |
| `daw-session-audit` | `TECH` | Host compatibility check, Session Intelligence analysis, & Vault context linking |
| `daw-vocal-session-prep` | `RECORDS` | Vocal session inventory, Producer-safe `vocal_chain` recipe & X3LIUS Vocal DNA context |
| `daw-vocal-chain-analysis` | `RECORDS` | Actual FX chain role analysis, session roles, & optional conditional WAV audio check |
| `daw-mixing-prep` | `RECORDS` | Routing/orphan bus audit paired with live FX chain verification |
| `daw-mix-diagnostics` | `RECORDS` | Mix-stage AudioBrain diagnostics, FX chain audit, & Quality Analyst session check |
| `daw-mastering-readiness` | `RECORDS` | Master bounce LUFS/true-peak verdict, `master_bus` guidance, & unsaved drift audit |
| `daw-plugin-chain-eval` | `TECH` | Live host capabilities, actual chain analysis, & optional single-plugin compatibility lookup |
| `daw-routing-audit` | `TECH` | Routing graph construction, orphan/disconnected source detection & bus context |
| `daw-audio-quality-report` | `TECH` | DSP feature extraction paired with independent Critic quality verdict |
| `daw-project-consistency-audit` | `CORE` | Compatibility gate + live-vs-saved drift, naming & project consistency analysis |
