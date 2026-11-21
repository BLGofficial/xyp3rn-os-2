import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DawBrainError,
  type DawAvailability,
  type DawProject,
  type DawTimeSignature,
} from '../../daw-brain/index.ts';
import type { FlpParsedProject } from './types.ts';

const cleanText = (buf: Buffer, forceUtf8 = false): string => {
  if (buf.length === 0) return '';
  if (forceUtf8) return buf.toString('utf8').replace(/\0+$/g, '').trim();
  const hasInteriorOddNul =
    buf.length >= 2 &&
    buf.length % 2 === 0 &&
    (buf[1] === 0 || buf.subarray(0, buf.length - 1).some((b, idx) => idx % 2 === 1 && b === 0));
  const decoded = hasInteriorOddNul ? buf.toString('utf16le') : buf.toString('utf8');
  return decoded.replace(/\0+$/g, '').trim();
};

const uniqueNonEmpty = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const trimmed = v.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
};

const isPrintableName = (s: string): boolean => {
  if (!s) return false;
  // Filter obvious binary structs emitted under shared FLdt string tags
  let controlCount = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if ((code < 32 && code !== 9) || code === 0xfffd) {
      controlCount += 1;
    }
  }
  return controlCount === 0;
};

/**
 * Strictly forbidden in Phase 11 & OS3 safety architecture: writing `.flp` binaries
 * can corrupt proprietary FL 25/26 chunks. Fails BEFORE touching any file descriptor.
 */
export const assertFlpMutationBlocked = (targetPath: string, reason = 'Binary .flp mutation is permanently UNSUPPORTED by OS3 safety policy'): never => {
  throw new DawBrainError('DAW_CAPABILITY_UNSUPPORTED', `${reason} (target: ${targetPath})`, {
    capabilityId: 'daw.project.flp_write',
    targetPath,
  });
};

/**
 * Read-only `.flp` container inspector supporting FL Studio 2024/2025/2026 project files.
 * Hashes SHA-256 pre- and post-read, verifies `FLhd` + `FLdt` chunks, extracts verifiable
 * string/header metadata, and explicitly flags obfuscated/unknown scalar values as `unknown`
 * without guessing plausible fake values.
 */
export const inspectFlpProjectFile = (filePath: string): FlpParsedProject => {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new DawBrainError('DAW_INVALID_COMMAND', `Project file not found: "${absPath}"`, {
      code: 'INVALID_PROJECT_FILE',
      filePath: absPath,
    });
  }

  const stats = fs.statSync(absPath);
  if (!stats.isFile()) {
    throw new DawBrainError('DAW_INVALID_COMMAND', `Project path is not a regular file: "${absPath}"`, {
      code: 'INVALID_PROJECT_FILE',
      filePath: absPath,
    });
  }

  const fd = fs.openSync(absPath, 'r');
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  const sha256BeforeRead = createHash('sha256').update(buffer).digest('hex');

  if (buffer.length < 22) {
    throw new DawBrainError('DAW_INVALID_COMMAND', `INVALID_PROJECT_FILE: "${absPath}" truncated (< 22 bytes)`, {
      code: 'INVALID_PROJECT_FILE',
    });
  }

  const headerMagic = buffer.subarray(0, 4).toString('ascii');
  if (headerMagic !== 'FLhd') {
    throw new DawBrainError('DAW_INVALID_COMMAND', `INVALID_PROJECT_FILE: invalid header magic "${headerMagic}"`, {
      code: 'INVALID_PROJECT_FILE',
    });
  }

  const headerLen = buffer.readUInt32LE(4);
  if (headerLen !== 6 || buffer.length < 14 + headerLen) {
    throw new DawBrainError('DAW_INVALID_COMMAND', `INVALID_PROJECT_FILE: invalid FLhd length ${headerLen}`, {
      code: 'INVALID_PROJECT_FILE',
    });
  }

  const format = buffer.readUInt16LE(8);
  const channelCountHeader = buffer.readUInt16LE(10);
  const ppq = buffer.readUInt16LE(12);

  const dataMagic = buffer.subarray(14, 18).toString('ascii');
  if (dataMagic !== 'FLdt') {
    throw new DawBrainError('DAW_INVALID_COMMAND', `INVALID_PROJECT_FILE: missing FLdt chunk ("${dataMagic}")`, {
      code: 'INVALID_PROJECT_FILE',
    });
  }

  const dtLen = buffer.readUInt32LE(18);
  if (22 + dtLen > buffer.length) {
    throw new DawBrainError(
      'DAW_INVALID_COMMAND',
      `INVALID_PROJECT_FILE: FLdt declared ${dtLen} bytes exceeding file size ${buffer.length}`,
      { code: 'INVALID_PROJECT_FILE' },
    );
  }

  const warnings: string[] = [];
  let flVersion: string | null = null;
  let flBuild: number | null = null;
  let rawBpm66: number | null = null;
  let rawFineTempo156: number | null = null;
  let rawNumerator17: number | null = null;
  let rawDenominator18: number | null = null;
  let arrangementName: string | null = null;
  let projectDataFolder: string | null = null;

  const channelNames: string[] = [];
  const mixerTrackNames: string[] = [];
  const playlistTrackNames: string[] = [];
  const samplePaths: string[] = [];
  const pluginNames: string[] = [];

  let pos = 22;
  const end = 22 + dtLen;

  while (pos < end) {
    const eventId = buffer[pos++];
    if (eventId === undefined) break;

    if (eventId < 64) {
      if (pos + 1 > end) {
        warnings.push(`Truncated 1-byte FLP event ${eventId} at offset ${pos}`);
        break;
      }
      const val = buffer[pos++] ?? 0;
      if (eventId === 17 && rawNumerator17 === null) rawNumerator17 = val;
      if (eventId === 18 && rawDenominator18 === null) rawDenominator18 = val;
    } else if (eventId < 128) {
      if (pos + 2 > end) {
        warnings.push(`Truncated 2-byte FLP event ${eventId} at offset ${pos}`);
        break;
      }
      const val = buffer.readUInt16LE(pos);
      pos += 2;
      if (eventId === 66 && rawBpm66 === null) rawBpm66 = val;
    } else if (eventId < 192) {
      if (pos + 4 > end) {
        warnings.push(`Truncated 4-byte FLP event ${eventId} at offset ${pos}`);
        break;
      }
      const val = buffer.readUInt32LE(pos);
      pos += 4;
      if (eventId === 156 && rawFineTempo156 === null) rawFineTempo156 = val;
      if (eventId === 159 && flBuild === null) flBuild = val;
    } else {
      let dataLen = 0;
      let shift = 0;
      let cont = true;
      while (cont && pos < end) {
        const b = buffer[pos++] ?? 0;
        dataLen |= (b & 0x7f) << shift;
        shift += 7;
        cont = (b & 0x80) !== 0;
        if (shift > 35) {
          throw new DawBrainError('DAW_INVALID_COMMAND', `INVALID_PROJECT_FILE: corrupt varint at offset ${pos}`, {
            code: 'INVALID_PROJECT_FILE',
          });
        }
      }
      if (pos + dataLen > end) {
        warnings.push(`Truncated variable FLP event ${eventId} declaring ${dataLen} bytes at offset ${pos}`);
        break;
      }
      const data = buffer.subarray(pos, pos + dataLen);
      pos += dataLen;

      if (eventId === 199 && flVersion === null) {
        const v = cleanText(data, true);
        if (v) flVersion = v;
      } else if (eventId === 196) {
        const s = cleanText(data);
        if (isPrintableName(s)) samplePaths.push(s);
      } else if (eventId === 201) {
        const p = cleanText(data);
        if (isPrintableName(p)) pluginNames.push(p);
      } else if (eventId === 202 && projectDataFolder === null) {
        const d = cleanText(data);
        if (isPrintableName(d)) projectDataFolder = d;
      } else if (eventId === 203) {
        const c = cleanText(data);
        if (isPrintableName(c)) channelNames.push(c);
      } else if (eventId === 204) {
        const m = cleanText(data);
        if (isPrintableName(m)) mixerTrackNames.push(m);
      } else if (eventId === 239) {
        const pt = cleanText(data);
        if (isPrintableName(pt)) playlistTrackNames.push(pt);
      } else if (eventId === 241 && arrangementName === null) {
        const a = cleanText(data);
        if (isPrintableName(a)) arrangementName = a;
      }
    }
  }

  let tempoBpm: DawAvailability<number>;
  if (rawFineTempo156 !== null && rawFineTempo156 >= 20_000 && rawFineTempo156 <= 300_000) {
    tempoBpm = { status: 'available', value: rawFineTempo156 / 1000 };
  } else if (rawBpm66 !== null && rawBpm66 >= 20 && rawBpm66 <= 300) {
    tempoBpm = { status: 'available', value: rawBpm66 };
  } else {
    tempoBpm = {
      status: 'unknown',
      reason:
        rawFineTempo156 !== null
          ? `FL Studio 25/26 scalar event obfuscation detected (raw tempo token=${rawFineTempo156}); read live BPM via controller script`
          : 'Tempo event absent or using FL Studio 25/26 default/masked scalar encoding; inspect via live controller',
    };
    warnings.push(tempoBpm.reason);
  }

  let timeSignature: DawAvailability<DawTimeSignature>;
  const validDenominators = new Set([1, 2, 4, 8, 16, 32]);
  if (
    rawNumerator17 !== null &&
    rawNumerator17 >= 1 &&
    rawNumerator17 <= 32 &&
    rawDenominator18 !== null &&
    validDenominators.has(rawDenominator18)
  ) {
    timeSignature = {
      status: 'available',
      value: { numerator: rawNumerator17, denominator: rawDenominator18, ppq },
    };
  } else {
    timeSignature = {
      status: 'unknown',
      reason: 'Time signature event absent or obfuscated in FLP stream',
    };
  }

  const sha256AfterRead = createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  if (sha256AfterRead !== sha256BeforeRead) {
    warnings.push('File hash changed during read inspection (external concurrent write detected)');
  }

  const projectName = path.basename(absPath, path.extname(absPath));
  const project: DawProject = {
    projectId: `flp-${sha256BeforeRead.slice(0, 12)}`,
    name: projectName,
    format: '.flp',
    projectPath: absPath,
    savedSha256: sha256BeforeRead,
    lastSavedAt: stats.mtime.toISOString(),
    editionRequirement: 'Producer Edition',
    tempo: tempoBpm.status === 'available' ? { bpm: tempoBpm.value, freshness: 'saved' } : null,
    timeSignature: timeSignature.status === 'available' ? timeSignature.value : null,
  };

  return {
    projectPath: absPath,
    projectName,
    sha256BeforeRead,
    sha256AfterRead,
    format,
    channelCountHeader,
    ppq,
    flVersion,
    flBuild: flBuild !== null && flBuild >= 1000 && flBuild < 100_000 ? flBuild : null,
    tempoBpm,
    timeSignature,
    arrangementName,
    projectDataFolder,
    channelNames: uniqueNonEmpty(channelNames),
    mixerTrackNames: uniqueNonEmpty(mixerTrackNames),
    playlistTrackNames: uniqueNonEmpty(playlistTrackNames),
    samplePaths: uniqueNonEmpty(samplePaths),
    pluginNames: uniqueNonEmpty(pluginNames),
    project,
    warnings,
  };
};
