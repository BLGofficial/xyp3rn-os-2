# XYP3RN DAW Agent Team (Phase 15)

Specialized DAW production agent roster integrated with OS3 Agent/Tool Registries, Session Intelligence, Plugin Brain, Audio Brain, Context Engine, X3LIUS Music records, and the DAW Command Gateway (`core/daw-brain/agents/`).

---

## 1. Roster Consolidation & Non-Redundancy Architecture

The 15 proposed candidates were audited against verified OS3 / FL Studio 2025 capabilities and consolidated cleanly into **12 distinct single-class agents**:

| Agent ID | Class | Domain | Consolidated From / Owned Responsibility | Allowed Runtime Tools |
| :--- | :--- | :--- | :--- | :--- |
| `daw-operator` | `Execution` | `TECH` | DAW Operator (#1): solely executes prepared, human-approved, lease-backed commands via `DawCommandGateway` | `daw_host_compatibility_audit`, `daw_session_analyze`, `daw_gateway_prepare`, `daw_gateway_execute`, `daw_gateway_rollback` |
| `daw-session-analyst` | `Knowledge` | `TECH` | Consolidates Session Analyst (#2) + Arrangement Analyst (#3) — FL Studio 2025 lacks timeline clip/marker scripting, so structural & accessible arrangement metadata stay unified | `daw_session_analyze`, `daw_context_retrieve`, `daw_host_compatibility_audit` |
| `daw-routing-specialist` | `Planning` | `TECH` | Routing Specialist (#11): signal-flow graph analysis, orphan/disconnected bus repairs, parallel/sidechain architecture | `daw_session_analyze`, `daw_plugin_brain_query`, `daw_context_retrieve` |
| `daw-mixing-engineer` | `Creative` | `RECORDS` | Mixing Engineer (#4): mix-stage headroom (`-6 dBTP` target), low-mid masking carve, track balance | `daw_session_analyze`, `daw_plugin_brain_query`, `daw_audio_brain_analyze`, `daw_context_retrieve` |
| `daw-mastering-engineer` | `Creative` | `RECORDS` | Mastering Engineer (#5): Master Bus limiter placement, `-1.0 dBTP` ceiling, `-9.5..-7.5 LUFS` target, LRA & translation | `daw_session_analyze`, `daw_plugin_brain_query`, `daw_audio_brain_analyze`, `daw_context_retrieve` |
| `daw-vocal-engineer` | `Creative` | `RECORDS` | Vocal Production Engineer (#6): X3LIUS Vocal DNA, baritone chains, Producer Edition pitch-correction compatibility | `daw_session_analyze`, `daw_plugin_brain_query`, `daw_audio_brain_analyze`, `daw_context_retrieve` |
| `daw-plugin-specialist` | `Research` | `TECH` | Consolidates Sound Design Specialist (#7) + Plugin Specialist (#8) — host APIs do not support autonomous synth patch creation, so VST3/native discovery, selection & chain design share one specialist | `daw_plugin_brain_query`, `daw_host_compatibility_audit`, `daw_context_retrieve` |
| `daw-dsp-engineer` | `Research` | `TECH` | DSP Engineer (#9): BS.1770 LUFS, 4x true peak, FFT spectral flatness, stereo/phase acoustics, clipping & noise diagnostics | `daw_audio_brain_analyze`, `daw_context_retrieve` |
| `daw-audio-quality-analyst` | `Critic` | `TECH` | Consolidates Audio Quality Analyst (#10) + Critical Listening Analyst (#14) — both serve as `Critic` evaluators over `AudioBrain` + `mix-rubric.yaml` | `daw_audio_brain_analyze`, `daw_session_analyze`, `daw_context_retrieve` |
| `daw-workflow-planner` | `Planning` | `CORE` | Production Workflow Planner (#12): sequences analyze -> recommend -> prepare -> execute_with_approval DAGs | `daw_session_analyze`, `daw_plugin_brain_query`, `daw_audio_brain_analyze`, `daw_host_compatibility_audit`, `daw_context_retrieve` |
| `daw-music-theory-analyst` | `Research` | `RECORDS` | Music Theory Analyst (#13): probabilistic MIR key/chroma/tempo/sections grounded against X3LIUS songs | `daw_audio_brain_analyze`, `daw_session_analyze`, `daw_context_retrieve` |
| `daw-compatibility-analyst` | `Governance` | `TECH` | DAW Compatibility Analyst (#15): enforces version bounds (`degraded_read_only`), Producer Edition exclusions & host prerequisites | `daw_host_compatibility_audit`, `daw_plugin_brain_query`, `daw_session_analyze`, `daw_context_retrieve` |

---

## 2. Execution Modes & Safety Controls

- Every call to `DawAgentTeam.runTask()` defaults to **`analyze`** (strictly read-only).
- **`recommend`**: Synthesizes non-mutating advice & manual operator actions from grounded diagnostics.
- **`prepare`** & **`execute_with_approval`**: Permitted **only** for `daw-operator` (`Execution`), rejecting any other agent class (`DAW_PERMISSION_DENIED`) with escalation to `daw-operator`, requiring `prepareId`, human `approvalId`, active `daw_session_leases` TTL lease, and Command Gateway safety/capability verification.
