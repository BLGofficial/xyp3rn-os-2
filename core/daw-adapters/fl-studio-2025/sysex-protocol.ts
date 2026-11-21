import { DawBrainError } from '../../daw-brain/index.ts';
import type { FlSysExMessageType } from './types.ts';

export const SYSEX_START = 0xf0;
export const SYSEX_END = 0xf7;
export const SYSEX_NON_COMMERCIAL_MFR_ID = 0x7d;
export const SYSEX_MAGIC_X = 0x58; // 'X'
export const SYSEX_MAGIC_Y = 0x59; // 'Y'
export const SYSEX_PROTOCOL_VERSION = 0x01;
export const DEFAULT_SYSEX_MAX_RAW_CHUNK_BYTES = 192;

export type DecodedSysExFrame = {
  readonly protocolVersion: number;
  readonly msgType: FlSysExMessageType;
  readonly seq: number;
  readonly chunkIndex: number;
  readonly chunkTotal: number;
  readonly payloadBytes: Uint8Array;
};

/**
 * CRC-16/CCITT-FALSE over header bytes + payload bytes so corrupted MIDI packets
 * fail loudly with CRC mismatch instead of silently passing torn telemetry.
 */
export const computeCrc16 = (bytes: Uint8Array): number => {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= (bytes[i] ?? 0) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
};

/**
 * Packs arbitrary 8-bit data into strict 7-bit MIDI data bytes (all bytes < 0x80).
 * Groups every 7 input bytes into 8 output bytes: `[msbs_0..6, low7_0..low7_6]`.
 */
export const encode7BitBytes = (input: Uint8Array): Uint8Array => {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 7) {
    const sliceLen = Math.min(7, input.length - i);
    let msbs = 0;
    const lowBytes: number[] = [];
    for (let j = 0; j < sliceLen; j += 1) {
      const b = input[i + j] ?? 0;
      if ((b & 0x80) !== 0) {
        msbs |= 1 << j;
      }
      lowBytes.push(b & 0x7f);
    }
    out.push(msbs & 0x7f, ...lowBytes);
  }
  return Uint8Array.from(out);
};

export const decode7BitBytes = (encoded: Uint8Array): Uint8Array => {
  for (let i = 0; i < encoded.length; i += 1) {
    if ((encoded[i] ?? 0) >= 0x80) {
      throw new DawBrainError('DAW_INVALID_COMMAND', `Invalid non-7bit byte at offset ${i}`);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < encoded.length; i += 8) {
    const msbs = encoded[i] ?? 0;
    const groupBytes = Math.min(7, encoded.length - i - 1);
    for (let j = 0; j < groupBytes; j += 1) {
      const low = encoded[i + 1 + j] ?? 0;
      const highBit = (msbs & (1 << j)) !== 0 ? 0x80 : 0;
      out.push(low | highBit);
    }
  }
  return Uint8Array.from(out);
};

/**
 * Verifies Windows/MIDI SysEx safety invariant: must begin with 0xF0, end with 0xF7,
 * match OS3 Non-Commercial header (`7D 58 59`), and have zero interior bytes >= 0x80.
 */
export const assertStrict7BitSysEx = (frame: Uint8Array): void => {
  if (frame.length < 16) {
    throw new DawBrainError('DAW_INVALID_COMMAND', `SysEx frame too short (${frame.length} bytes)`);
  }
  if (frame[0] !== SYSEX_START || frame[frame.length - 1] !== SYSEX_END) {
    throw new DawBrainError('DAW_INVALID_COMMAND', 'SysEx frame missing F0 start or F7 end marker');
  }
  for (let i = 1; i < frame.length - 1; i += 1) {
    if ((frame[i] ?? 0) >= 0x80) {
      throw new DawBrainError('DAW_INVALID_COMMAND', `Illegal MSB=1 byte 0x${frame[i]?.toString(16)} inside SysEx body at index ${i}`);
    }
  }
  if (
    frame[1] !== SYSEX_NON_COMMERCIAL_MFR_ID ||
    frame[2] !== SYSEX_MAGIC_X ||
    frame[3] !== SYSEX_MAGIC_Y
  ) {
    throw new DawBrainError('DAW_INVALID_COMMAND', 'SysEx frame header does not match OS3 XYP3RN manufacturer signature');
  }
};

export const encodeSysExMessage = (
  msgType: FlSysExMessageType,
  seq: number,
  payload: unknown = {},
  maxRawChunkBytes = DEFAULT_SYSEX_MAX_RAW_CHUNK_BYTES,
): readonly Uint8Array[] => {
  const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const chunkSize = Math.max(32, maxRawChunkBytes);
  const chunkTotal = Math.max(1, Math.ceil(jsonBytes.length / chunkSize));
  const seq14 = seq & 0x3fff;
  const frames: Uint8Array[] = [];

  for (let chunkIndex = 0; chunkIndex < chunkTotal; chunkIndex += 1) {
    const start = chunkIndex * chunkSize;
    const rawSlice = jsonBytes.subarray(start, Math.min(jsonBytes.length, start + chunkSize));
    const encodedSlice = encode7BitBytes(rawSlice);

    const headerBody = [
      SYSEX_PROTOCOL_VERSION & 0x7f,
      msgType & 0x7f,
      (seq14 >> 7) & 0x7f,
      seq14 & 0x7f,
      (chunkIndex >> 7) & 0x7f,
      chunkIndex & 0x7f,
      (chunkTotal >> 7) & 0x7f,
      chunkTotal & 0x7f,
    ];

    const crcInput = new Uint8Array(headerBody.length + encodedSlice.length);
    crcInput.set(headerBody, 0);
    crcInput.set(encodedSlice, headerBody.length);
    const crc = computeCrc16(crcInput);

    // 16-bit CRC stored safely across 3 strict 7-bit MIDI bytes
    const crcBytes = [
      (crc >> 14) & 0x03,
      (crc >> 7) & 0x7f,
      crc & 0x7f,
    ];

    const frame = new Uint8Array(4 + headerBody.length + encodedSlice.length + crcBytes.length + 1);
    frame[0] = SYSEX_START;
    frame[1] = SYSEX_NON_COMMERCIAL_MFR_ID;
    frame[2] = SYSEX_MAGIC_X;
    frame[3] = SYSEX_MAGIC_Y;
    frame.set(headerBody, 4);
    frame.set(encodedSlice, 4 + headerBody.length);
    frame.set(crcBytes, 4 + headerBody.length + encodedSlice.length);
    frame[frame.length - 1] = SYSEX_END;

    assertStrict7BitSysEx(frame);
    frames.push(frame);
  }

  return frames;
};

export const decodeSysExFrame = (frame: Uint8Array): DecodedSysExFrame => {
  assertStrict7BitSysEx(frame);
  const bodyEnd = frame.length - 4; // excludes 3 CRC bytes + 0xF7
  const headerAndEncoded = frame.subarray(4, bodyEnd);
  const expectedCrc = computeCrc16(headerAndEncoded);
  const actualCrc =
    (((frame[bodyEnd] ?? 0) & 0x03) << 14) |
    (((frame[bodyEnd + 1] ?? 0) & 0x7f) << 7) |
    ((frame[bodyEnd + 2] ?? 0) & 0x7f);

  if (expectedCrc !== actualCrc) {
    throw new DawBrainError(
      'DAW_INVALID_COMMAND',
      `CRC_MISMATCH on FL Studio SysEx frame (expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)})`,
      { code: 'CRC_MISMATCH', expectedCrc, actualCrc },
    );
  }

  const protocolVersion = frame[4] ?? 0;
  if (protocolVersion !== SYSEX_PROTOCOL_VERSION) {
    throw new DawBrainError(
      'DAW_UNSUPPORTED_HOST_VERSION',
      `Unsupported FL Studio SysEx protocol version ${protocolVersion}`,
    );
  }

  const msgType = (frame[5] ?? 0) as FlSysExMessageType;
  const seq = (((frame[6] ?? 0) & 0x7f) << 7) | ((frame[7] ?? 0) & 0x7f);
  const chunkIndex = (((frame[8] ?? 0) & 0x7f) << 7) | ((frame[9] ?? 0) & 0x7f);
  const chunkTotal = Math.max(1, (((frame[10] ?? 0) & 0x7f) << 7) | ((frame[11] ?? 0) & 0x7f));
  const encodedPayload = frame.subarray(12, bodyEnd);
  const payloadBytes = decode7BitBytes(encodedPayload);

  return {
    protocolVersion,
    msgType,
    seq,
    chunkIndex,
    chunkTotal,
    payloadBytes,
  };
};

/**
 * Reassembles single- or multi-chunk SysEx responses correlated by `(msgType, seq)`.
 */
export class SysExChunkAssembler {
  readonly #buffers = new Map<
    string,
    {
      readonly msgType: FlSysExMessageType;
      readonly seq: number;
      readonly chunkTotal: number;
      readonly chunks: Map<number, Uint8Array>;
      readonly createdAtMs: number;
    }
  >();

  push(frame: Uint8Array): {
    readonly complete: boolean;
    readonly msgType: FlSysExMessageType;
    readonly seq: number;
    readonly json?: unknown;
  } {
    const decoded = decodeSysExFrame(frame);
    const key = `${decoded.msgType}:${decoded.seq}`;

    let entry = this.#buffers.get(key);
    if (!entry || entry.chunkTotal !== decoded.chunkTotal) {
      entry = {
        msgType: decoded.msgType,
        seq: decoded.seq,
        chunkTotal: decoded.chunkTotal,
        chunks: new Map<number, Uint8Array>(),
        createdAtMs: Date.now(),
      };
      this.#buffers.set(key, entry);
    }

    entry.chunks.set(decoded.chunkIndex, decoded.payloadBytes);
    if (entry.chunks.size < entry.chunkTotal) {
      return { complete: false, msgType: decoded.msgType, seq: decoded.seq };
    }

    const ordered: Uint8Array[] = [];
    let totalLen = 0;
    for (let i = 0; i < entry.chunkTotal; i += 1) {
      const part = entry.chunks.get(i);
      if (!part) {
        return { complete: false, msgType: decoded.msgType, seq: decoded.seq };
      }
      ordered.push(part);
      totalLen += part.length;
    }
    this.#buffers.delete(key);

    const joined = Buffer.concat(ordered, totalLen);
    const text = joined.toString('utf8').trim();
    const json = text ? (JSON.parse(text) as unknown) : {};
    return { complete: true, msgType: decoded.msgType, seq: decoded.seq, json };
  }

  pruneExpired(maxAgeMs = 10_000): void {
    const now = Date.now();
    for (const [k, v] of this.#buffers.entries()) {
      if (now - v.createdAtMs > maxAgeMs) {
        this.#buffers.delete(k);
      }
    }
  }
}
