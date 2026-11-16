# XYP3RN OS 3.0 + DAW Brain — Architecture & Data Topology Diagrams (Phase 02 Freeze)

**Status:** Phase 02 Architecture Freeze

---

## 1. Master System Topology (OS3 + DAW Brain + Hosts)

```mermaid
flowchart TB
  subgraph UI["UI-xyp3rn (127.0.0.1:3000 · Next.js 14)"]
    Map["3D Constellation Map\n(MapScreen, BrainCore, SectorTree)"]
    Dash["Operator Dashboards\n(System, Agents, Workflows, Approvals, Records)"]
    Chart["Vault Knowledge Topology\n(KnowledgeGraphView)"]
    JarvisUI["Jarvis Console & WebGL Orb\n(JarvisView, X3liusPlayer, AudioExtractor)"]
    DawUI["DAW & Studio Panels (Phase 07)\n(5-Tier State, Plugin Matrix, Audio Brain)"]
  end

  subgraph GW["OS3 HTTP / SSE Gateway (127.0.0.1:8077)"]
    Api["Rest & SSE Router\n(Host/Origin Allowlist + Bearer Token)"]
    UiQ["UI Query Projections & Audio Reverse-Eng"]
  end

  subgraph Kernel["OS3 Orchestration & Knowledge Kernel"]
    Jarvis["JARVIS Core & Inspector"]
    Orch["Task Orchestrator & Workflow Engine"]
    AReg["Agent Registry (04_AGENTS/)"]
    TReg["Tool Registry (Capabilities Matrix)"]
    Ctx["Context Engine (Hybrid + Cache)"]
    LLM["Model Gateway (OpenRouter / Anthropic / Groq)"]
    RI["Research Intelligence (20 Specialists)"]
    Rec["X3LIUS Records & Catalog Engine"]
  end

  subgraph DawBrain["Vendor-Agnostic DAW Brain (core/daw-brain/)"]
    DawCore["DAW Core & 5-Tier Session Model"]
    CapReg["DAW Capability Registry (Default: observe)"]
    CmdGw["DAW Command Gateway\n(Clamps, Snapshot, Approval Check)"]
    PBrain["Plugin Brain (Edition + Semantic Map)"]
    ABrain["Audio Brain (TRACE + Mix Rubric + DSP)"]
    ProdInt["Production Intelligence & Eval Engine"]
  end

  subgraph Infra["Core Authorities & Event Spine"]
    Bus["OS3 Event Bus & Audit Engine"]
    PGate["Promotion Gate (Human-Only Approval)"]
    VE["Vault Engine (Sole Vault Writer + CAS)"]
    SQL["WAL SQLite Runtime (core/sqlite)"]
  end

  subgraph External["External Local Targets"]
    Vault[("Obsidian Vault + .vault/ + .vault-revisions/")]
    FLBridge["FL Studio 2025 Adapter\n(loopMIDI SysEx + FL64 /R + Read-Only .flp)"]
    ReaperBridge["REAPER Adapter (Validation Target)\n(.rpp + OSC / ReaScript)"]
    VSTDir[("Workstation VST3 / VST2 Dirs")]
  end

  UI <-->|"HTTP / SSE (127.0.0.1:8077)"| Api
  Api --> UiQ
  Api --> Jarvis
  Api --> DawCore
  Jarvis --> Orch
  Jarvis --> Ctx
  Orch --> AReg
  Orch --> TReg
  Orch --> LLM
  TReg --> RI
  TReg --> Rec
  TReg --> CapReg
  DawCore --> CapReg
  DawCore --> CmdGw
  DawCore --> PBrain
  DawCore --> ABrain
  DawCore --> ProdInt
  CmdGw --> Bus
  RI --> VE
  Rec --> VE
  PGate --> VE
  Bus --> SQL
  Bus --> Api
  PBrain -.->|"Read-Only Scan"| VSTDir
  VE <-->|"Atomic FS + Revisions"| Vault
  CmdGw -->|"DawAdapter SDK"| FLBridge
  CmdGw -->|"DawAdapter SDK"| ReaperBridge
```

---

## 2. Five-Tier DAW Session State & Storage Separation

```mermaid
flowchart LR
  LiveDAW["Running DAW Host\n(FL Studio 2025 RAM)"] -->|"Read-Only Poll (observe)"| T1["1. liveObserved\n(RAM Snapshot)"]
  T1 -->|"TTL Snapshot Cache"| T2["2. cached\n(SQLite daw_sessions · stale=true offline)"]
  DiskProj[("Project File on Disk\n(.flp / .rpp)")] -->|"Read-Only Hash + Parse"| T3["3. savedProject\n(Disk SHA-256 Truth)"]
  ABrain2["Audio Brain & Production Intel"] -->|"Propose (Zero Effect)"| T4["4. proposedModifications\n(Draft Patches in Queue)"]
  T4 -->|"Prepare + Clamps + Human Approve"| Gate["DAW Command Gateway"]
  Gate -->|"Execute on Host RAM"| LiveDAW
  Gate -->|"Immutable Receipt\n(unsavedToDisk=true)"| T5["5. appliedModifications\n(SQLite daw_command_journal)"]

  T1 ---|"Diff Engine"| Drift{"Live == Saved?"}
  T3 --- Drift
  Drift -->|"Mismatch"| Warn["Flag hasUnsavedLiveChanges = true\n(Warn before CLI /R Render!)"]
```

---

## 3. Security & Capability Escalation Gate Flow

```mermaid
flowchart TD
  Req["Incoming DAW / Vault Action Request"] --> AuthN{"Loopback Allowlist &\nOptional Token Valid?"}
  AuthN -->|No| Reject403["401/403 Denied + Audit Event"]
  AuthN -->|Yes| Mode{"Required Permission Tier?"}
  Mode -->|"observe / analyze"| ReadPath["Allowed by Default\n(Zero Mutation)"]
  Mode -->|"propose / prepare"| DryRun["Validate Host Capabilities & Targets\nApply Safety Clamps & Read beforeState"]
  DryRun -->|"UNSUPPORTED Capability"| Unsup["501 DAW_CAPABILITY_UNSUPPORTED\nEmit Manual Operator Guide"]
  DryRun -->|"Clamp Failed / Drift"| SafeErr["409/422 Abort Pre-Dispatch\nZero Host Messages Sent"]
  DryRun -->|"Prepared Validated Patch"| Approval{"Human Approved &\nActive execute Lease?"}
  Approval -->|No| Pending["403 PENDING_HUMAN_APPROVAL\nQueued in pending_approvals"]
  Approval -->|Yes| Exec["Execute via Adapter + Readback Verify\nLog daw_command_journal + Emit Event"]
```
