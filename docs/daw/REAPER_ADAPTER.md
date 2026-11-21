# XYP3RN REAPER Adapter (`core/daw-adapters/reaper/`)

Phase 17 vendor-isolated DAW adapter for Cockos REAPER, validating cross-DAW portability of the OS3 Universal DAW Brain (`core/daw-brain/`).

---

## 1. Installed Host Inspection Truth (Windows 11 Workstation)

Direct non-destructive inspection of this Windows 11 host via `DefaultReaperHostProbe`:
- `C:\Program Files\REAPER (x64)\` exists containing leftover `.png` UI theme icon assets only — **`reaper.exe` is NOT installed** (`exists: false`).
- `%APPDATA%\REAPER\` (`reaper.ini`, `Scripts\`, `OSC\`) does not exist.
- Zero live `reaper.exe` processes running; zero `.rpp` project files found on user profile.
- Accordingly, `ReaperAdapter.discover()` reports `reachable: false` and `connect()` fails closed cleanly with `DAW_HOST_OFFLINE` + exact remediation telemetry until REAPER (`>= 6.0`, target `7.x`) and the ReaScript bridge are installed on the host.

---

## 2. Verified Architecture & Modules

| Module | Responsibility |
| :--- | :--- |
| `types.ts` | REAPER capability matrix (`REAPER_CAPABILITIES` / `buildReaperCapabilities`), `.rpp` parsed types, ReaScript snapshot/track/FX/send/envelope/item/marker schemas |
| `host-probe.ts` | `DefaultReaperHostProbe` inspecting `reaper.exe`, leftover PNG dir warning, `%APPDATA%\REAPER\reaper.ini`, `xyp3rn_reaper_bridge.lua`, VST3/VST2 dirs, and `.rpp` project discovery |
| `rpp-inspector.ts` | Read-only plain-text `.rpp` tree parser (`TEMPO`, `<TRACK>`, `<AUXRECV>`, `<FXCHAIN>`, `<ITEM>`, `<PARMENV>`, `MARKER` regions/markers) with pre/post SHA-256 verification and `assertRppMutationBlocked()` |
| `reaper-transport.ts` | `HttpReaperBridgeTransport` strictly restricted to `127.0.0.1` HTTP JSON-RPC + `MockReaperBridgeTransport` (`FXT-RPR-01`) for offline/CI conformance & fault injection |
| `reascript/xyp3rn_reaper_bridge.lua` | ReaScript Lua reference bridge querying `GetAppVersion`, `GetProjectStateChangeCount`, `GetPlayState`, `Master_GetTempo`, `CountTracks`, `GetMediaTrackInfo_Value`, `TrackFX_*` |
| `reaper-adapter.ts` | `ReaperAdapter implements DawAdapter` with `discover`, `connect`, `disconnect`, `healthCheck`, `getCapabilities`, `observe`, `subscribe`, `validateCommand`, `execute` |
| `multi-daw-comparison.ts` | Programmatic `buildMultiDawCompatibilityReport()` contrasting REAPER, FL Studio 2025, and `FakeDawAdapter` |
