# XYP3RN DAW Brain — Execution Sequence Diagrams (Phase 02 Freeze)

**Status:** Phase 02 Architecture Freeze

---

## 1. Read-Only Live Observation (`FL Studio 2025` via Virtual MIDI Loopback)

```mermaid
sequenceDiagram
  autonumber
  participant UI as UI-xyp3rn (:3000)
  participant GW as OS3 Gateway (:8077)
  participant Core as DAW Core & Observer
  participant Bridge as Node/Python loopMIDI Bridge
  participant FL as FL Studio 2025\n(device_XYP3RNBrain.py)

  UI->>GW: GET /api/daw/sessions/sess-1/state
  GW->>Core: refreshSession("sess-1") [perm=observe]
  Core->>Bridge: requestSnapshot(SysEx PING + POLL_MIXER)
  Bridge->>FL: Virtual MIDI Out (SysEx CRC-16 frame)
  FL->>FL: Query transport, mixer, plugins (read-only API)
  FL-->>Bridge: device.midiOutSysex(packed tracks + loaded plugin names)
  Bridge-->>Core: DawObservedSnapshot (ts, transport, tracks[], plugins[])
  Core->>Core: Update liveObserved + compare vs savedProject SHA-256
  Core-->>GW: DawSessionStateContainer (hasUnsavedLiveChanges flag)
  GW-->>UI: 200 OK JSON (Distinct live vs cached vs saved state)
```

---

## 2. Audio Brain -> Bounded Mix Patch -> Human Approval -> Execute -> Evaluate & Rollback

```mermaid
sequenceDiagram
  autonumber
  participant Op as Operator / UI-xyp3rn
  participant AB as Audio Brain\n(TRACE + Mix Rubric)
  participant PI as Production Intel &\nPlugin Brain
  participant CG as DAW Command Gateway\n(Clamps + Journal)
  participant DB as SQLite\n(pending_approvals)
  participant FL as FL Studio 2025 Bridge

  Op->>AB: POST /api/audio-brain/analyze (render.wav, stage="master")
  AB-->>Op: trace.report/v1 ("sub too high +2.4dB; ceiling -0.4dBTP -> lower target")
  Op->>PI: POST /api/daw/sessions/sess-1/propose (diagnostics)
  PI->>PI: Resolve loaded plugin semantic params (Pro-Q3 LowShelf gain)
  PI-->>Op: proposedModifications [cmd: plugin.param_write -2.2 dB]
  Op->>CG: POST /prepare { proposalId }
  CG->>FL: Read current param value (beforeState = 0.62)
  CG->>CG: Check delta <= 3.0 dB & target not drifted
  CG->>DB: Insert pending_approvals (status='pending', itemType='daw_patch')
  CG-->>Op: PreparedDawPatch (awaiting human approval)
  Op->>DB: POST /api/approvals/decide (decision='approved')
  Op->>CG: POST /execute { patchId, approvalId }
  CG->>FL: SysEx SET_PLUGIN_PARAM (slot=2, param=14, val=0.49)
  FL-->>CG: Readback verify (param=0.49 confirmed)
  CG->>DB: Append immutable daw_command_journal (before=0.62, after=0.49)
  alt Post-Evaluation Detects Regression
    Op->>CG: POST /rollback { receiptId }
    CG->>FL: SysEx SET_PLUGIN_PARAM (val=0.62 from beforeState)
  end
```

---

## 3. Unsupported Capability Handling (Rule: Report Unsupported, Never Simulate)

```mermaid
sequenceDiagram
  autonumber
  participant Agent as daw-mix-planner
  participant Cap as DAW Capability Registry
  participant FL as FL Studio 2025 Adapter
  participant UI as UI-xyp3rn / Operator

  Agent->>Cap: Request capability "daw.plugin.load_remove" (FabFilter Pro-Q 3 on Bus 4)
  Cap->>FL: Check DawAdapterManifest["daw.plugin.load_remove"]
  FL-->>Cap: UNSUPPORTED (FL MIDI API lacks dynamic plugin insert)
  Cap-->>Agent: Error DAW_CAPABILITY_UNSUPPORTED + Manual Guidance Metadata
  Agent->>UI: Emit ProductionPlan with manualOperatorSteps:\n["1. Open Mixer Insert 4 in FL Studio", "2. Load FabFilter Pro-Q 3", "3. Re-poll Live Session"]
```

---

## 4. Headless Master Render (`FL64.exe /R`) & TRACE Rubric Verification Loop

```mermaid
sequenceDiagram
  autonumber
  participant Op as Operator / Workflow Engine
  participant SM as DAW Session Model
  participant FLCLI as FL64.exe CLI (/R /Ewav)
  participant AB as Audio Brain & Eval Engine
  participant Vault as Vault Engine (09_X3LIUS_MUSIC)

  Op->>SM: Check savedProject state
  alt liveObserved != savedProject (Unsaved RAM edits)
    SM-->>Op: Warn: Unsaved FL edits exist! Save Ctrl+S in FL Studio before render.
  else Clean saved checkpoint on disk
    Op->>FLCLI: Execute FL64.exe /R /Ewav "project.flp"
    FLCLI-->>Op: Writes bounce_master.wav (SHA-256 hashed)
    Op->>AB: Analyze bounce_master.wav vs mix-rubric.yaml
    AB-->>Op: EvaluationVerdict (LUFS=-8.3, TruePeak=-1.1 dBTP, Crest=6.8 dB -> PASS)
    Op->>Vault: Save session diagnostic summary (.md, non-canonical)
  end
```

---

## 5. Multi-DAW Architecture Portability Validation (REAPER Adapter Target)

```mermaid
sequenceDiagram
  autonumber
  participant Core as DAW Core & Workflow (daw-mix-assist-patch)
  participant Cap as Capability Registry
  participant Reaper as REAPER Adapter (.rpp + OSC)

  Core->>Cap: Check "daw.plugin.load_remove" on adapter="reaper"
  Cap->>Reaper: Query manifest
  Reaper-->>Cap: SUPPORTED (TrackFX_AddByName + .rpp chunk model)
  Cap-->>Core: Authorized (after lease + approval)
  Core->>Reaper: prepareCommand -> executePrepared (identical DawCommand DTO!)
  Reaper-->>Core: DawExecutionReceipt (Proves DAW Core has 0 FL Studio coupling)
```
