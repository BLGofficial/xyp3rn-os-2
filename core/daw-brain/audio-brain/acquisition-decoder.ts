import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateTraceAnalysis, type TraceAnalysis } from '../../../tech/trace/analysis.ts';
import { DawBrainError } from '../types.ts';
import type { AudioAcquisitionRecord, AudioInputSourceKind, DecodedAudioBuffer } from './types.ts';

/**
 * Explicitly rejects attempts to read internal live FL Studio ASIO/Mixer PCM memory
 * without an exported WAV or verified DAW stream.
 */
export const assertNoUnsupportedDawAudioTap = (sourceDescription: string): never => {
  throw new DawBrainError(
    'DAW_CAPABILITY_UNSUPPORTED',
    `FL Studio Producer Edition does not expose direct live internal mixer PCM buffers (${sourceDescription}); supply an exported/rendered WAV file, TRACE payload, or verified PCM stream.`,
    { capabilityId: 'daw.audio.pcm_tap', sourceDescription },
  );
};

export const MAX_AUDIO_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_WAV_FRAME_COUNT = 16_000_000;
export const MIN_WAV_SAMPLE_RATE = 8_000;
export const MAX_WAV_SAMPLE_RATE = 384_000;

/**
 * Stage 1 (Audio Acquisition): Strictly read-only file acquisition with regular-file verification,
 * bounded file size limit, symlink escape protection, and pre/post-read consistency validation.
 */
export const acquireWavFileReadOnly = (
  filePath: string,
  sourceKind: Extract<AudioInputSourceKind, 'user_file' | 'approved_render'> = 'user_file',
  options: { readonly maxBytes?: number | undefined; readonly allowSymlinks?: boolean | undefined } = {},
): { readonly bytes: Buffer; readonly acquisition: AudioAcquisitionRecord } => {
  if (!filePath || !filePath.trim() || filePath.includes('\0')) {
    throw new DawBrainError('DAW_INVALID_COMMAND', 'INVALID_AUDIO_PATH: audio file path must be non-empty without NUL bytes');
  }
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new DawBrainError('DAW_INVALID_COMMAND', `Audio file not found: "${absPath}"`, {
      code: 'AUDIO_FILE_NOT_FOUND',
    });
  }

  const lst = fs.lstatSync(absPath);
  if (lst.isSymbolicLink() && !options.allowSymlinks) {
    throw new DawBrainError('DAW_PERMISSION_DENIED', `Audio acquisition rejected symlink path: "${absPath}"`);
  }

  const maxBytes = Math.max(1024, options.maxBytes ?? MAX_AUDIO_FILE_BYTES);
  const fd = fs.openSync(absPath, 'r');
  let bytes: Buffer;
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) {
      throw new DawBrainError('DAW_INVALID_COMMAND', `Audio path is not a regular file: "${absPath}"`);
    }
    if (fst.size > maxBytes) {
      throw new DawBrainError(
        'DAW_INVALID_COMMAND',
        `AUDIO_FILE_TOO_LARGE: "${absPath}" is ${fst.size} bytes (max ${maxBytes} bytes)`,
      );
    }
    bytes = fs.readFileSync(fd);
    const postSt = fs.fstatSync(fd);
    if (postSt.size !== fst.size || postSt.mtimeMs !== fst.mtimeMs || bytes.length !== fst.size) {
      throw new DawBrainError(
        'DAW_TARGET_DRIFT',
        `Input audio file "${absPath}" changed concurrently while reading`,
      );
    }
  } finally {
    fs.closeSync(fd);
  }

  const sha256BeforeRead = createHash('sha256').update(bytes).digest('hex');
  const sha256AfterRead = sha256BeforeRead;

  return {
    bytes,
    acquisition: {
      sourceKind,
      label: path.basename(absPath),
      filePath: absPath,
      streamId: null,
      sha256BeforeRead,
      sha256AfterRead,
      byteSize: bytes.length,
      acquiredAt: new Date().toISOString(),
      readOnlyVerified: true,
      provenance: `read-only:${sourceKind}:${absPath}`,
    },
  };
};

export const acquireVerifiedPcmStream = (input: {
  readonly streamId: string;
  readonly label: string;
  readonly sampleRateHz: number;
  readonly channelData: readonly Float32Array[];
}): { readonly decoded: DecodedAudioBuffer; readonly acquisition: AudioAcquisitionRecord } => {
  if (input.sampleRateHz <= 0 || input.channelData.length === 0 || (input.channelData[0]?.length ?? 0) === 0) {
    throw new DawBrainError('DAW_INVALID_COMMAND', 'Verified DAW audio stream must carry non-empty samples and sampleRateHz > 0');
  }
  const channels = (input.channelData.length >= 2 ? 2 : 1) as 1 | 2;
  const sliced = input.channelData.slice(0, channels);
  const frameCount = sliced[0]!.length;

  const hasher = createHash('sha256');
  for (const ch of sliced) {
    hasher.update(Buffer.from(ch.buffer, ch.byteOffset, ch.byteLength));
  }
  const sha256 = hasher.digest('hex');

  return {
    decoded: {
      sampleRateHz: input.sampleRateHz,
      channels,
      channelLayout: channels === 2 ? 'stereo' : 'mono',
      bitDepth: 32,
      encoding: 'stream_float',
      frameCount,
      durationSec: frameCount / input.sampleRateHz,
      channelData: sliced,
      sha256,
    },
    acquisition: {
      sourceKind: 'verified_daw_stream',
      label: input.label,
      filePath: null,
      streamId: input.streamId,
      sha256BeforeRead: sha256,
      sha256AfterRead: sha256,
      byteSize: frameCount * channels * 4,
      acquiredAt: new Date().toISOString(),
      readOnlyVerified: true,
      provenance: `stream:verified_daw_stream:${input.streamId}`,
    },
  };
};

export const acquireExternalTraceAnalysis = (
  raw: unknown,
  label?: string,
): { readonly trace: TraceAnalysis; readonly acquisition: AudioAcquisitionRecord } => {
  const issues = validateTraceAnalysis(raw);
  if (issues.length > 0) {
    throw new DawBrainError('DAW_INVALID_COMMAND', `Invalid external trace.analysis/v1 payload: ${issues.join('; ')}`);
  }
  const trace = raw as TraceAnalysis;
  const sha256 = createHash('sha256').update(JSON.stringify(trace)).digest('hex');
  return {
    trace,
    acquisition: {
      sourceKind: 'exported_analysis',
      label: label ?? trace.subject.label,
      filePath: null,
      streamId: null,
      sha256BeforeRead: sha256,
      sha256AfterRead: sha256,
      byteSize: null,
      acquiredAt: new Date().toISOString(),
      readOnlyVerified: true,
      provenance: `exported_analysis:${trace.producer.tool}@${trace.producer.version}`,
    },
  };
};

/**
 * Stage 2 (Audio Decoding): Pure binary RIFF/WAVE decoder supporting PCM 8/16/24/32-bit
 * and IEEE float 32-bit (including `WAVE_FORMAT_EXTENSIBLE` 65534).
 */
export const decodeWavBuffer = (
  buffer: Buffer,
  options: { readonly maxFrames?: number | undefined } = {},
): DecodedAudioBuffer => {
  if (buffer.length < 44) {
    throw new DawBrainError('DAW_INVALID_COMMAND', `INVALID_AUDIO_FILE: WAV buffer too short (${buffer.length} bytes)`);
  }
  if (buffer.length > MAX_AUDIO_FILE_BYTES) {
    throw new DawBrainError('DAW_INVALID_COMMAND', `INVALID_AUDIO_FILE: WAV buffer exceeds max byte limit (${buffer.length})`);
  }
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new DawBrainError('DAW_INVALID_COMMAND', 'INVALID_AUDIO_FILE: missing RIFF/WAVE header');
  }

  let audioFormat: number | null = null;
  let numChannels: number | null = null;
  let sampleRateHz: number | null = null;
  let bitsPerSample: number | null = null;
  let dataStart = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const boundedChunkSize = Math.min(chunkSize, buffer.length - bodyStart);

    if (chunkId === 'fmt ' && bodyStart + 16 <= buffer.length) {
      audioFormat = buffer.readUInt16LE(bodyStart);
      numChannels = buffer.readUInt16LE(bodyStart + 2);
      sampleRateHz = buffer.readUInt32LE(bodyStart + 4);
      bitsPerSample = buffer.readUInt16LE(bodyStart + 14);
      if (audioFormat === 0xfffe && chunkSize >= 40 && bodyStart + 26 <= buffer.length) {
        // WAVE_FORMAT_EXTENSIBLE SubFormat first 2 bytes
        audioFormat = buffer.readUInt16LE(bodyStart + 24);
      }
    } else if (chunkId === 'data') {
      dataStart = bodyStart;
      dataSize = boundedChunkSize;
      break;
    }

    const padded = boundedChunkSize + (boundedChunkSize % 2);
    const nextOffset = bodyStart + padded;
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) {
      throw new DawBrainError('DAW_INVALID_COMMAND', 'INVALID_AUDIO_FILE: malformed RIFF chunk offset progression');
    }
    offset = nextOffset;
  }

  if (
    audioFormat === null ||
    numChannels === null ||
    sampleRateHz === null ||
    bitsPerSample === null ||
    dataStart < 0
  ) {
    throw new DawBrainError('DAW_INVALID_COMMAND', 'INVALID_AUDIO_FILE: missing fmt or data chunk in WAV');
  }
  if (!Number.isFinite(sampleRateHz) || sampleRateHz < MIN_WAV_SAMPLE_RATE || sampleRateHz > MAX_WAV_SAMPLE_RATE) {
    throw new DawBrainError(
      'DAW_INVALID_COMMAND',
      `INVALID_AUDIO_FILE: WAV sample rate ${sampleRateHz} Hz outside safe bounds [${MIN_WAV_SAMPLE_RATE}, ${MAX_WAV_SAMPLE_RATE}]`,
    );
  }
  if (numChannels !== 1 && numChannels !== 2) {
    throw new DawBrainError('DAW_CAPABILITY_UNSUPPORTED', `Unsupported WAV channel count (${numChannels}; mono or stereo required)`);
  }
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new DawBrainError('DAW_CAPABILITY_UNSUPPORTED', `Unsupported WAV encoding formatTag=${audioFormat} (PCM or IEEE float required)`);
  }

  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  const blockAlign = bytesPerSample * numChannels;
  if (blockAlign <= 0 || dataSize < blockAlign) {
    throw new DawBrainError('DAW_INVALID_COMMAND', 'INVALID_AUDIO_FILE: WAV data chunk contains zero audio frames');
  }

  const maxFrames = Math.max(1, options.maxFrames ?? MAX_WAV_FRAME_COUNT);
  const frameCount = Math.floor(dataSize / blockAlign);
  if (frameCount > maxFrames) {
    throw new DawBrainError(
      'DAW_INVALID_COMMAND',
      `AUDIO_FRAME_LIMIT_EXCEEDED: WAV has ${frameCount} frames (max ${maxFrames})`,
    );
  }
  const channelData: Float32Array[] = Array.from({ length: numChannels }, () => new Float32Array(frameCount));

  let encoding: DecodedAudioBuffer['encoding'];
  if (audioFormat === 3 && bitsPerSample === 32) encoding = 'ieee_float32';
  else if (audioFormat === 1 && bitsPerSample === 8) encoding = 'pcm_int8';
  else if (audioFormat === 1 && bitsPerSample === 16) encoding = 'pcm_int16';
  else if (audioFormat === 1 && bitsPerSample === 24) encoding = 'pcm_int24';
  else if (audioFormat === 1 && bitsPerSample === 32) encoding = 'pcm_int32';
  else {
    throw new DawBrainError('DAW_CAPABILITY_UNSUPPORTED', `Unsupported bitDepth=${bitsPerSample} for formatTag=${audioFormat}`);
  }

  for (let i = 0; i < frameCount; i += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      const pos = dataStart + i * blockAlign + ch * bytesPerSample;
      let sample = 0;
      if (encoding === 'ieee_float32') {
        sample = buffer.readFloatLE(pos);
      } else if (encoding === 'pcm_int8') {
        sample = ((buffer[pos] ?? 128) - 128) / 128;
      } else if (encoding === 'pcm_int16') {
        sample = buffer.readInt16LE(pos) / 32768;
      } else if (encoding === 'pcm_int24') {
        let val = buffer[pos]! | (buffer[pos + 1]! << 8) | (buffer[pos + 2]! << 16);
        if ((val & 0x800000) !== 0) val |= ~0xffffff;
        sample = val / 8388608;
      } else {
        sample = buffer.readInt32LE(pos) / 2147483648;
      }
      channelData[ch]![i] = sample;
    }
  }

  return {
    sampleRateHz,
    channels: numChannels as 1 | 2,
    channelLayout: numChannels === 2 ? 'stereo' : 'mono',
    bitDepth: bitsPerSample,
    encoding,
    frameCount,
    durationSec: frameCount / sampleRateHz,
    channelData,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
};
