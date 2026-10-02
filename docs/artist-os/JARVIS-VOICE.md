# Prompt 02 — Studio voice capture

Studio uses the existing owner session and Vault curator. Text and reviewed transcripts pass through `validateCapture` and `saveCapture`; each save creates a `xyp-studio-capture/v1` document tagged `draft`, `studio-capture`, and the chosen intent. The six intents are lyric fragment, song idea, task, style request, meta-tag request, and general note. They never dispatch an action described inside the text. No parent/approved-record target is accepted.

Voice input is sent only after Finish; recording pauses do not submit. Cancel discards the pending recording/request and preserves editor text. Capture is bounded to five minutes and 10 MiB. Request permission comes from an explicit Start action. The owner sees and can edit the transcript before confirming a save. Speech output is explicit, muted on demand, and limited to a selection or draft of at most 600 characters.

## Server configuration

Pass these variables to the web server environment or the gitignored `apps/web/.env.local`, which Next loads. Nothing loads a root `.env` for the OS CLI. Keep API keys server-side, never in a `NEXT_PUBLIC_*` variable or browser field.

```dotenv
XYP_WHISPER_URL=http://127.0.0.1:9000/v1/audio/transcriptions
XYP_WHISPER_MODEL=<exact configured model ID>
XYP_WHISPER_LANGUAGES=en,bg
# XYP_WHISPER_API_KEY=<server-side key if required>
XYP_KOKORO_URL=http://127.0.0.1:8880/v1/audio/speech
XYP_KOKORO_MODEL=<exact configured model ID>
XYP_KOKORO_VOICE=<exact configured voice ID>
XYP_KOKORO_LANGUAGES=<comma-separated languages verified for this voice>
# XYP_KOKORO_API_KEY=<server-side key if required>
```

These URLs are configuration examples, not provisioned services. Missing model, URL, language list or Kokoro voice leaves that adapter unconfigured. Only HTTPS or loopback HTTP is accepted; redirects are refused. Do not declare Bulgarian output unless the configured Kokoro service/voice supports it. Unsupported read-back stays disabled while Bulgarian text/transcription remains usable through its configured adapter.

Whisper compatibility: multipart transcription with `file`, `model`, source `language`, and `response_format=verbose_json`. It never calls a translation endpoint. Contract reference: [OpenAI transcription API](https://developers.openai.com/api/reference/cli/resources/audio/subresources/transcriptions/methods/create). Kokoro compatibility: configured model/voice and plain `input`, returning WAV from `/v1/audio/speech`; see [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI). No new provider dependency or hosted service is installed.

## Provenance and boundaries

The server signs the original transcript, declared source language, optional service-reported language, audio SHA-256, model ID and UTC transcription timestamp. The receipt expires after one hour and is bound to the current owner-session secret. Saving verifies it and records whether the owner edited the transcript. Missing detected language remains unknown. Raw microphone audio stays transient; its bytes are not automatically uploaded to the Vault.

The saved file contains the original transcript and the reviewed draft. It is an immutable owner document, not canonical knowledge or an approved lyric/style/tag version. Repeating an identical save yields identical bytes so the existing Vault checksum deduplication can reuse its source. The database supplies the source creation timestamp. A returned source ID, checksum and agent run IDs form the save receipt; the UI never says saved before receiving it.

Speech endpoints recheck the session, require same-origin writes, cap streamed bodies, sanitize provider failures, set no-store headers, and limit the single owner's requests to 20/minute per process. No source-provided instruction can change the endpoint, model, voice or permissions. This limiter is local-process scope, not a distributed deployment guarantee.

## Verification and outstanding live acceptance

This checkout reuses the neighboring AOS-04 worktree's Prompt 02 implementation with the operator's Wispr Flow preference. Wispr is external focused-field dictation; Studio cannot start, pause or inspect it. Select `Wispr Flow` after dictating to record owner-declared provenance. Typed input is the default. Optional browser recording appears only when a Whisper-compatible adapter is configured. Cancelling discards retained recording bytes; retry preserves the original recording language.

2026-10-01: 28 focused tests passed, including real migrated-database saves, original-byte reopening, English/Bulgarian metadata, Wispr provenance, duplicate retry and refusal of approved targets. Both typechecks passed. The local Kokoro service returned valid WAV with model `kokoro`, voice `af_bella`; browser read-back reached `Read-back finished`. Browser checks also verified mute, Bulgarian text and review reset after editing. Local preview config enables English read-back only; Bulgarian output stays unavailable.

Remaining acceptance: real English/Bulgarian dictation using Wispr, microphone pause/resume/denial and cancellation with a configured Whisper adapter, and playback permission denial. Adapter tests use labeled audio fixtures; they do not establish real transcription accuracy. Prompt 02 remains pending these live checks. See `../handoffs/JARVIS-02.md` for the continuation point.
