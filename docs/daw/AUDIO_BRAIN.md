# XYP3RN Audio Brain (Phase 14)

Analysis-only audio DSP, perceptual loudness, spectral balance, stereo phase, and probabilistic Music Information Retrieval (MIR) subsystem (`core/daw-brain/audio-brain/`).

---

## 1. Seven-Stage Separated Pipeline Architecture

| Stage | Module | Responsibility |
| :--- | :--- | :--- |
| 1. **Audio Acquisition** | `acquisition-decoder.ts` | Non-destructive file acquisition (`openSync('r')`, pre/post SHA-256 verification), verified PCM stream intake, external `trace.analysis/v1` intake, and explicit refusal of unsupported internal FL Studio PCM taps (`assertNoUnsupportedDawAudioTap`). |
| 2. **Audio Decoding** | `acquisition-decoder.ts` | Pure RIFF/WAVE binary decoder (`pcm_int8`, `pcm_int16`, `pcm_int24`, `pcm_int32`, `ieee_float32`, `WAVE_FORMAT_EXTENSIBLE`) rejecting corrupt headers (`INVALID_AUDIO_FILE`). |
| 3. **Feature Extraction** | `dsp-analyzer.ts` | Short-window peak/RMS distributions, silence bounds, quiet-frame noise floor, DC offset, clipping counts, and onset/transient energy jumps. |
| 4. **DSP Analysis** | `dsp-interfaces.ts`, `dsp-analyzer.ts` | Reusable `DspConfig` (`sampleRateHz`, `channelLayout`, `bufferSize`, `precision`, `latencySamples`, `window`, `hopSize`, `overlapRatio`, `fftSize`, `normalization`, `tolerances`), 4x oversampled true peak `dBTP`, ITU-R BS.1770 K-weighted LUFS/LRA, windowed FFT spectrum across `TRACE_BANDS`, and full/per-band stereo correlation + width %. Emits schema-valid `trace.analysis/v1`. |
| 5. **Musical Interpretation (MIR)** | `mir-analyzer.ts` | Spectral-flux onset detection, autocorrelation tempo/beat estimation, 12-bin FFT chroma, Krumhansl-Schmuckler key estimation, harmonic/percussive ratio, section segmentation, and source classification — all explicitly labeled `probabilistic: true`. |
| 6. **Diagnostic Reasoning** | `diagnostics-engine.ts` | Evaluates `records/x3lius/mix-rubric.yaml` bounds (`checks` + `unsetMetrics`), sample/true-peak clipping, low-mid mud, sub-bass mono width, negative phase correlation, over-compression, and silent/truncated renders. |
| 7. **Recommendation Generation** | `diagnostics-engine.ts`, `audio-brain.ts` | Generates structured, strictly non-mutating `AudioBrainRecommendation[]` and Markdown reports (`formatMarkdownReport`). |
