# XYP3RN DAW Command Gateway + Safe Execution (Phase 16)

Controlled, default-deny execution architecture built inside `core/daw-brain/` (`command-policy.ts`, `dry-run-engine.ts`, `daw-command-gateway.ts`, `daw-core.ts`) with opt-in low-risk FL Studio 2025 support (`executionProfile: 'controlled_safe_v1'`).

---

## 1. 11-Stage Command Lifecycle

Every command dispatched through `DawCommandGateway` traverses the ordered lifecycle below:

1. **Request** (`request`) — validates required identifiers (`commandId`, `correlationId`, `sessionId`), cancellation status, and duplicate/in-flight/idempotency uniqueness (`DAW_DUPLICATE_COMMAND`).
2. **Capability Verification** (`capability_verification`) — checks adapter registration, declared support (`SUPPORTED` vs `READ_ONLY` vs `UNSUPPORTED`), and host version compatibility (`DAW_CAPABILITY_UNSUPPORTED`, `DAW_PERMISSION_DENIED`).
3. **Input Validation** (`input_validation`) — enforces command kind-to-capability pairing, parameter schema/types, finite numeric bounds (`deltaDb` in `[-60, +3.0]`, `volumeNormalized` in `[0, 1]`, `panNormalized` in `[-1, 1]`, `bpm` in `[20, 300]`, Master bus `<= 0.0 dBFS`), and adapter target resolution (`DAW_INVALID_COMMAND`, `DAW_SAFETY_VIOLATION`).
4. **Permission & Policy Check** (`permission_check`) — verifies live observation freshness (`DAW_STALE_STATE` / `DAW_HOST_OFFLINE`), project identity (`expectedProjectId`, `expectedProjectPath`, `expectedProjectSha256` -> `DAW_PROJECT_MISMATCH`), `defaultDeny: true` explicit action allowlist (`DAW_ACTION_NOT_ALLOWLISTED`), `Execution` agent class isolation (`DAW_PERMISSION_DENIED`), and active target-scoped TTL lease (`daw_session_leases` -> `DAW_LEASE_REQUIRED`).
5. **Risk Classification** (`risk_classification`) — assigns one of the 5 command classes, computes truthful `rollbackSupported` status, and elevates non-rollback / destructive actions to `human_strong` approval with explicit warnings.
6. **Dry-Run Simulation** (`dry_run`) — `DawDryRunEngine` computes exact `beforeState`, `predictedAfterState`, field-level diffs, and postcondition assertions with zero host side effects.
7. **Approval** (`approval`) — validates independent human operator decision in `pending_approvals` (blocking pending, missing, wrong-target, or self/agent approvals) and requires explicit strong confirmation when `approvalRequirement === 'human_strong'`.
8. **Execution** (`execution`) — single-shot invocation (`0` blind retries) protected by duplicate-in-flight lock, `timeoutMs` timer (`DAW_TIMEOUT`), and `AbortSignal` listener (`DAW_CANCELLED`).
9. **Postcondition Verification** (`postcondition_verification`) — performs mandatory post-write live readback (`adapter.observe()`), updates session digest, and asserts observed values match dry-run expectations (`DAW_POSTCONDITION_FAILED`).
10. **Audit** (`audit`) — records structured `DawExecutionReceipt` objects (`correlationId`, stages reached, diff, timings, recovery) + immutable append-only `daw_command_journal` entries + `DawEventBus` / `runtime_events`.
11. **Recovery or Rollback** (`recovery_or_rollback`) — executes exact `beforeState` rollback only when genuinely supported by the adapter capability (`DAW_ROLLBACK_UNSUPPORTED` otherwise) and triggers automatic compensating readback recovery when commands time out, abort mid-flight, or fail postcondition verification.

---

## 2. Command Classes & Initial Permitted Actions

| Command Class | Approval Requirement | Initial Policy Status | Examples |
| :--- | :--- | :--- | :--- |
| `read_only` | `none` | Allowed (observe/read) | `session.observe`, `daw.mixer.read`, `daw.transport.read` |
| `reversible` | `human_standard` | Initial low-risk allowlist (`INITIAL_PERMITTED_DAW_CAPABILITIES`) | Non-master `daw.mixer.fader_pan_mute`, `daw.transport.control` (play/stop/loop/BPM), `daw.plugin.bypass` |
| `potentially_destructive` | `human_strong` (+ warnings) | Denied by default unless policy opt-in | `daw.mixer.routing_write`, Master bus tweaks, `daw.project.save`, `daw.render.master` |
| `irreversible` | `human_strong` (disallowed) | Permanently blocked (`DAW_ACTION_NOT_ALLOWLISTED`) | `track.create_delete`, `plugin.load_remove`, `automation.edit`, `audio.destructive_process`, `distribution.publish` |
| `unsupported` | N/A | Rejected pre-dispatch (`DAW_CAPABILITY_UNSUPPORTED`) | Undeclared / `UNSUPPORTED` / `READ_ONLY` adapter capabilities |

- `FlStudio2025Adapter` defaults to `executionProfile: 'read_only'` (Phase 11 behavior). Opting into `executionProfile: 'controlled_safe_v1'` enables only bounded `daw.transport.control` (no unattended `recording: true`), `daw.mixer.fader_pan_mute`, and `daw.plugin.bypass` over 7-bit SysEx with CRC-16 and live readback.
