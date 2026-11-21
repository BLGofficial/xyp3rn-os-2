/**
 * Deterministic PCM WAV encoders for Audio Brain evaluation fixtures (`FXT-AUD-CLIP`,
 * `FXT-AUD-MUD`, `FXT-AUD-PASS`) and MIR/stereo verification without committing large binary WAVs.
 */

export const encodeWavPcm16 = (
  channels: readonly Float32Array[],
  sampleRateHz = 44_100,
): Buffer => {
  const numChannels = channels.length;
  const frameCount = channels[0]?.length ?? 0;
  const dataBytes = frameCount * numChannels * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRateHz, 24);
  buf.writeUInt32LE(sampleRateHz * numChannels * 2, 28);
  buf.writeUInt16LE(numChannels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  let pos = 44;
  for (let i = 0; i < frameCount; i += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      const clamped = Math.max(-1, Math.min(1, channels[ch]![i] ?? 0));
      const intVal = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, intVal)), pos);
      pos += 2;
    }
  }
  return buf;
};

export const encodeWavFloat32 = (
  channels: readonly Float32Array[],
  sampleRateHz = 44_100,
): Buffer => {
  const numChannels = channels.length;
  const frameCount = channels[0]?.length ?? 0;
  const dataBytes = frameCount * numChannels * 4;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRateHz, 24);
  buf.writeUInt32LE(sampleRateHz * numChannels * 4, 28);
  buf.writeUInt16LE(numChannels * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  let pos = 44;
  for (let i = 0; i < frameCount; i += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      buf.writeFloatLE(channels[ch]![i] ?? 0, pos);
      pos += 4;
    }
  }
  return buf;
};

export const buildClippedFixtureWav = (durationSec = 2.0, sampleRateHz = 44_100): Buffer => {
  const n = Math.round(durationSec * sampleRateHz);
  const chL = new Float32Array(n);
  const chR = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    // Hard-clipped +1.35 amplitude driven sine -> sample peak hits +/-1.0 (0 dBFS) & intersample overs
    const raw = Math.sin((2 * Math.PI * 1000 * i) / sampleRateHz) * 1.35;
    const hard = Math.max(-1, Math.min(1, raw));
    chL[i] = hard;
    chR[i] = hard;
  }
  return encodeWavPcm16([chL, chR], sampleRateHz);
};

export const buildMudFixtureWav = (durationSec = 2.5, sampleRateHz = 44_100): Buffer => {
  const n = Math.round(durationSec * sampleRateHz);
  const chL = new Float32Array(n);
  const chR = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRateHz;
    // Heavy 300 Hz low-mid hump (+10 dB over 1.2 kHz mid & high)
    const mud = 0.36 * Math.sin(2 * Math.PI * 300 * t);
    const mid = 0.08 * Math.sin(2 * Math.PI * 1200 * t);
    const top = 0.04 * Math.sin(2 * Math.PI * 6500 * t);
    chL[i] = mud + mid + top;
    chR[i] = mud + mid + top;
  }
  return encodeWavPcm16([chL, chR], sampleRateHz);
};

export const buildBalancedPassFixtureWav = (durationSec = 3.0, sampleRateHz = 44_100): Buffer => {
  const n = Math.round(durationSec * sampleRateHz);
  const chL = new Float32Array(n);
  const chR = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRateHz;
    // Mono tight 45 Hz sub + wide subtle stereo mids/air with periodic punch transients (~9 dB crest factor, <= -1.2 dBTP, ~ -8.8 LUFS)
    const beatPhase = (t * 2) % 1;
    const env = beatPhase < 0.15 ? 1.0 : 0.42;
    const subMono = 0.32 * Math.sin(2 * Math.PI * 45 * t);
    const body = 0.18 * Math.sin(2 * Math.PI * 180 * t);
    const presence = 0.08 * Math.sin(2 * Math.PI * 3000 * t);
    const airL = 0.05 * Math.sin(2 * Math.PI * 8000 * t + 0.15);
    const airR = 0.05 * Math.sin(2 * Math.PI * 8000 * t - 0.15);
    chL[i] = env * (subMono + body + presence + airL);
    chR[i] = env * (subMono + body + presence + airR);
  }
  return encodeWavPcm16([chL, chR], sampleRateHz);
};
