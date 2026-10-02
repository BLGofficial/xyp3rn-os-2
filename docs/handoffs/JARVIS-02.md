# Jarvis Prompt 02 — Studio capture checkpoint

2026-10-01, checkout `xyp3rn-os-2-engine`, branch `feat/hud-live`.

## Scope and source

Continued the next prompt named by `JARVIS-01.md`: Studio voice capture. The supplied sequence is preserved in `../artist-os/XYP3RN_Artist_OS_Jarvis_Build_Sequence.md`, copied from the neighboring `xyp3rn-os-2-aos04` worktree. Reused that worktree's existing capture UI, validation, speech adapters and HTTP tests, adapting them to this checkout. The operator's earlier Wispr Flow preference remains: external dictation into a focused field, with owner-declared provenance. Browser transcription is optional and requires a configured adapter.

## Implemented

- `/studio` supports typed or Wispr-dictated text, six capture kinds, source language, review before saving and a link to the saved Vault file.
- Both input paths use one validated draft route and the existing Vault curator. Tasks and style/tag requests remain documents; they do not execute commands or modify approved records.
- Optional Whisper-compatible recording supports explicit finish, pause/resume, bounded requests, cancellation, retry with the original recording language and signed transcript provenance.
- Kokoro reads a selected fragment or draft up to 600 characters; stop, mute, unsupported-language and error states remain explicit.
- Studio endpoints require the owner session, same-origin writes, bounded bodies and per-process rate limiting. Provider configuration stays server-side.
- Typed provenance is the default. Wispr is explicitly owner-declared. Cancel discards retained recording bytes.
- No dependency, migration, canonical promotion or provider account added.

## Verification

- 28 focused tests passed across speech, HTTP authorization and real Vault persistence.
- Persistence checks use the isolated `xyp_test_engine_studio_capture` database and temporary Vault: English/Bulgarian content, source language, original bytes, extracted text, provenance, retry deduplication, refused approval fields and no task execution. Tests clean up their fixtures.
- Root and web typechecks passed; production `pnpm web:build` passed; `git diff --check` passed.
- Local Kokoro returned valid WAV (83,440 bytes for the short check). Browser playback completed with `Read-back finished`.
- Browser verified review gating, review reset after text/language changes, mute, preserved Bulgarian text and disabled unsupported read-back. Browser fixture text was not saved to the preview Vault.
- Full repository suite and existing broad `web:smoke` were not run for this checkpoint.

## Preview configuration

`http://127.0.0.1:3100/studio`; gitignored `apps/web/.env.local` retains the existing owner token and the isolated `xyp3rn_engine_preview` database. English read-back uses the local Kokoro service on port 8880, model `kokoro`, voice `af_bella`. The older `postgres` database remains separate. No Whisper endpoint is configured. Secret values are not recorded here.

## Remaining acceptance before Prompt 03

Prompt 02 implementation is present; its live voice gate is still pending. Verify real English and Bulgarian Wispr dictation into Studio and review/save behavior. For the optional browser adapter, configure the intended Whisper-compatible endpoint and verify actual captures, mid-sentence pause/resume, microphone denial, cancellation and retry. Playback permission denial also remains unverified. Unit fixtures do not establish transcription accuracy, and English Kokoro success does not establish Bulgarian voice support.

Next sequence step after those checks: Prompt 03, graph provenance/navigation. Do not report the full voice gate complete on the basis of typed fixtures.
