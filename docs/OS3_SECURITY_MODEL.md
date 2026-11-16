# XYP3RN OS 3.0 + DAW Brain — Security & Safety Model (Phase 02 Freeze)

**Status:** Phase 02 Architecture Freeze  
**Baseline:** [SECURITY_MODEL.md](os3/architecture/SECURITY_MODEL.md) · Master Engineering Rules #5–#15

---

## 1. Core Security Principles

1. **Deny-by-Default Capability Authorization:** Every OS3 agent tool (`ToolRegistry`) and every DAW Brain action (`DawCapabilityRegistry`) denies by default unless explicitly mapped to an allowed actor class AND permitted by active session lease.
2. **Default Mode = Read-Only `observe`:** All DAW connections and JARVIS inspectors boot strictly in read-only observation mode.
3. **Human Approval Gate (`F35 D2`):** No AI agent may ever approve its own canonical Vault write, rights split change, or destructive/high-risk DAW mutation.
4. **Loopback Isolation (`127.0.0.1`):** Local HTTP/SSE services (`:8077` Gateway, future unified Audio/TRACE endpoints, internal loopMIDI bridge processes) bind exclusively to loopback and reject foreign `Host`/`Origin`/`Referer` headers.
5. **Physical Safety & Undoability for Audio Output:** Mutating live audio routing or plugin gains requires bounded numerical clamping, `beforeState` snapshotting, and post-execution verification.

---

## 2. Complete Capability-Permission Enforcement Matrix

### A. OS3 Kernel Capabilities (`core/tool-registry/capabilities.ts`, `VERIFIED` + Phase 02 Extensions)
- Existing 23 capabilities remain enforced (`canonical.write`, `approval.decide`, `audit.write` stay strictly `[]` — never usable by any agent).
- New DAW capabilities added cleanly under `CAPABILITIES` with single-class separation (`Rule: one capability -> explicit agent classes`):

| Capability | Allowed Agent Class(es) | Security & Safety Guard |
|---|---|---|
| `daw.observe` | `Knowledge`, `Research`, `Planning`, `Creative`, `Critic`, `Governance` | Read-only host polling & `.flp`/`.rpp` SHA-verified reads. |
| `daw.analyze` | `Research`, `Knowledge`, `Critic` | DSP/TRACE WAV computation & rubric checking. Zero DAW actuation. |
| `daw.propose` | `Planning`, `Creative`, `Revision` | Generates candidate patch objects & Obsidian drafts cleanly (`no-overwrite`). |
| `daw.prepare` | `Execution` | Runs pre-flight host target check + delta clamps + `beforeState` readback. Still zero live write. |
| `daw.execute` | `Execution` (and Operator UI directly) | Blocked unless ALL 4 pass: active TTL `execute` lease + human/policy `approved` ID + safety clamps pass + `beforeState` saved. |
| `daw.approve` | **`[]` (No Agent Class — Human Only)** | Recorded immutably in SQLite `pending_approvals`. |
| `daw.rollback` | `Execution` + Human Operator | Restores recorded `beforeState` map cleanly inside `daw_command_journal`. |

---

## 3. DAW Audio & Action Safety Guardrails (Anti-Clipping / Anti-Corruption)

1. **Pre-Execution Live Target Verification:** Before sending any parameter or mixer write, `DawCommandGateway` verifies the target `(trackIndex, slotIndex, pluginName, paramIndex)` matches the live host snapshot captured within `< 5s`. If the user manually moved or deleted a plugin in FL Studio, the patch aborts cleanly with `DAW_TARGET_DRIFT`.
2. **Gain & Level Clamps (`Hard Non-Bypassable Floor/Ceiling`):**
   - Mixer fader upward step cap per command: **`+3.0 dB` max delta** (`maxFaderLinear <= 1.0` unity unless target explicitly flagged `allowOverUnity: true` by human approval).
   - Limiter/Maximizer output ceiling target floor: rejects automated ceiling writes above **`-0.1 dBTP`**.
   - Normalized plugin param `[0.0, 1.0]` step cap per unapproved tweak: rejected if input outside `[0.0, 1.0]` or NaN.
   - Transport tempo bounds: clamped to `[20, 300] BPM`.
3. **Host Sandbox Integrity (FL Studio 2025):**
   - Embedded `device_XYP3RNBrain.py` runs strictly inside FL's Python sandbox with **zero `os`/`subprocess`/`socket`/`open()` hacks**.
   - External virtual MIDI (`loopMIDI`) SysEx packets include: `XYP3RN Manufacturer Prefix` (`0x7D` non-commercial experimental SysEx ID + sub-ID), message version, monotonic sequence ID, command opcode, 7-bit packed payload, and **CRC-16 checksum** — malformed or un-authenticated packets are discarded and logged.
   - Because FL Studio's `.flp` is proprietary binary, **zero binary `.flp` write tools exist** in OS3 (strict `READ_ONLY` on `.flp` files).
4. **Files & Vault Escape Protection:**
   - Audio renders (`FL64.exe /R`) write exclusively to a dedicated staging folder inside an operator-configured workspace/Vault `_attachments/` or temp directory validated via `path-guard` (blocking `..`, NTFS junctions, symlink escapes, and executable extensions).

---

## 4. Network, Authentication & Secret Hygiene

- **HTTP Gateway (`127.0.0.1:8077`):** Host allowlist (`127.0.0.1`, `localhost`), CORS `Access-Control-Allow-Private-Network: true`, optional `XYP_GATEWAY_TOKEN` constant-time Bearer enforcement across ALL `/api/*` (including new `/api/daw/*` routes; only `/api/health` remains public-on-loopback status probe).
- **Zero Secrets on Disk or in MIDI Streams:** API keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `XYP_GATEWAY_TOKEN`) stay in `process.env` only, never sent across SysEx, never logged into `daw_command_journal` or Obsidian notes (`StructuredLogger.redactSecrets()`).
- **Whole-OS / Vault Jarvis Acceptance Gate:** Enforced via existing `readAccepted` & `askBeforeChange` request flags before inspecting OS files or mutating notes.
