# XYP3RN DAW Brain — Evaluation Benchmark Report (Phase 18)

- **Report ID:** `eval-fe260c40` (`xyp3rn.daw-eval/v1`)
- **Generated At:** `2026-11-21T05:01:08.063Z`
- **Overall Verdict:** **PASS** (22/22 passed, accuracy=100.0%)

## Category Summary vs Pre-Registered Baseline Thresholds

| Category | Passed / Total | Accuracy | Min Baseline | Max Failures | Meets Baseline |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `daw_detection_accuracy` | 5 / 5 | 100.0% | 100.0% | 0 | PASS |
| `state_observation_accuracy` | 5 / 5 | 100.0% | 95.0% | 0 | PASS |
| `session_model_completeness` | 1 / 1 | 100.0% | 100.0% | 0 | PASS |
| `plugin_identification_accuracy` | 1 / 1 | 100.0% | 95.0% | 0 | PASS |
| `parameter_interpretation_accuracy` | 1 / 1 | 100.0% | 95.0% | 0 | PASS |
| `audio_analysis_accuracy` | 2 / 2 | 100.0% | 95.0% | 0 | PASS |
| `routing_interpretation_accuracy` | 1 / 1 | 100.0% | 95.0% | 0 | PASS |
| `agent_recommendation_quality` | 1 / 1 | 100.0% | 90.0% | 0 | PASS |
| `command_validation_correctness` | 1 / 1 | 100.0% | 100.0% | 0 | PASS |
| `execution_reliability` | 3 / 3 | 100.0% | 100.0% | 0 | PASS |
| `recovery_behavior` | 1 / 1 | 100.0% | 100.0% | 0 | PASS |

## Detailed Case Results

| Case ID | Category | Result | Confidence | Provenance Dataset | Error / Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `det-online-fakedawadapter` | `daw_detection_accuracy` | PASS | 1.00 | `adapter-FakeDawAdapter` (`synthetic_fixture`) | Verified |
| `det-online-flstudio2025adapter` | `daw_detection_accuracy` | PASS | 1.00 | `adapter-FlStudio2025Adapter` (`synthetic_fixture`) | Verified |
| `det-online-reaperadapter` | `daw_detection_accuracy` | PASS | 1.00 | `adapter-ReaperAdapter` (`synthetic_fixture`) | Verified |
| `det-offline-realworkstationreaperprobe` | `daw_detection_accuracy` | PASS | 1.00 | `offline-RealWorkstationReaperProbe` (`synthetic_fixture`) | Verified |
| `det-offline-realworkstationflstudioprobe` | `daw_detection_accuracy` | PASS | 1.00 | `offline-RealWorkstationFlStudioProbe` (`synthetic_fixture`) | Verified |
| `obs-fakedawadapter` | `state_observation_accuracy` | PASS | 1.00 | `obs-FakeDawAdapter` (`manual_ground_truth`) | Verified |
| `obs-flstudio2025adapter` | `state_observation_accuracy` | PASS | 1.00 | `obs-FlStudio2025Adapter` (`manual_ground_truth`) | Verified |
| `obs-reaperadapter` | `state_observation_accuracy` | PASS | 1.00 | `obs-ReaperAdapter` (`manual_ground_truth`) | Verified |
| `proj-fxt-rpp-ground-truth` | `state_observation_accuracy` | PASS | 1.00 | `fxt-rpp-ground-truth` (`user_approved_project`) | Verified |
| `proj-workstation-approved-project-1` | `state_observation_accuracy` | PASS | 1.00 | `workstation-approved-project-1` (`user_approved_project`) | Verified |
| `sess-model-7-states` | `session_model_completeness` | PASS | 1.00 | `session-model-invariant` (`manual_ground_truth`) | Verified |
| `plug-ident-producer-compat` | `plugin_identification_accuracy` | PASS | 1.00 | `ctrl-plugin-orphan-set` (`controlled_plugin_config`) | Verified |
| `param-interp-bounds-and-flags` | `parameter_interpretation_accuracy` | PASS | 1.00 | `ctrl-param-bounds` (`controlled_plugin_config`) | Verified |
| `audio-ref-1khz-analytical` | `audio_analysis_accuracy` | PASS | 1.00 | `ref-audio-1khz-minus6db` (`reference_audio_wav`) | Verified |
| `audio-clip-mud-pass-phase` | `audio_analysis_accuracy` | PASS | 1.00 | `fxt-aud-clip` (`reference_audio_wav`) | Verified |
| `routing-orphan-and-chain-graph` | `routing_interpretation_accuracy` | PASS | 1.00 | `ctrl-orphan-routing` (`synthetic_fixture`) | Verified |
| `agent-team-routing-and-grounding` | `agent_recommendation_quality` | PASS | 1.00 | `agent-contract-matrix` (`manual_ground_truth`) | Verified |
| `cmd-validation-safety-and-policy` | `command_validation_correctness` | PASS | 1.00 | `gateway-validation-suite` (`manual_ground_truth`) | Verified |
| `exec-rel-fakedawadapter` | `execution_reliability` | PASS | 1.00 | `exec-rel-FakeDawAdapter` (`manual_ground_truth`) | Verified |
| `exec-rel-flstudio2025adapter` | `execution_reliability` | PASS | 1.00 | `exec-rel-FlStudio2025Adapter` (`manual_ground_truth`) | Verified |
| `exec-rel-reaperadapter` | `execution_reliability` | PASS | 1.00 | `exec-rel-ReaperAdapter` (`manual_ground_truth`) | Verified |
| `rec-rollback-and-timeout-comp` | `recovery_behavior` | PASS | 1.00 | `recovery-fault-injection` (`synthetic_fixture`) | Verified |