import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeSnapshotDigest,
  DawBrainError,
  type DawAudioClip,
  type DawAutomationLane,
  type DawBus,
  type DawChannel,
  type DawMarker,
  type DawMidiClip,
  type DawMixerChannel,
  type DawObservationProvenance,
  type DawPluginInstance,
  type DawRegion,
  type DawRoutingConnection,
  type DawStateSnapshot,
  type DawTrack,
} from '../../daw-brain/index.ts';
import type {
  RppEnvelopeEntry,
  RppFxEntry,
  RppMediaItemEntry,
  RppParsedProject,
  RppSendEntry,
  RppTrackEntry,
} from './types.ts';

export const MAX_RPP_FILE_BYTES = 32 * 1024 * 1024;

const readRppChecked = (filePath: string): { readonly text: string; readonly sha256: string } => {
  const lst = fs.lstatSync(filePath);
  if (lst.isSymbolicLink()) {
    throw new DawBrainError('DAW_PERMISSION_DENIED', `SECURITY: Refusing symlink .rpp project path "${filePath}"`);
  }
  const st = fs.statSync(filePath);
  if (!st.isFile()) {
    throw new DawBrainError('DAW_INVALID_COMMAND', `INVALID_PROJECT_FILE: "${filePath}" is not a regular file`);
  }
  if (st.size > MAX_RPP_FILE_BYTES) {
    throw new DawBrainError(
      'DAW_INVALID_COMMAND',
      `INVALID_PROJECT_FILE: .rpp file exceeds max safe size (${st.size} > ${MAX_RPP_FILE_BYTES} bytes)`,
    );
  }
  const buf = fs.readFileSync(filePath);
  return {
    text: buf.toString('utf8'),
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
};

const linearToDb = (vol: number): number | null => {
  if (!Number.isFinite(vol) || vol <= 0) return null;
  return Number((20 * Math.log10(vol)).toFixed(2));
};

const tokenizeRppLine = (line: string): readonly string[] => {
  const tokens: string[] = [];
  let cur = '';
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
        tokens.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
};

const classifyFxFormat = (rawType: string, rawName: string): RppFxEntry['format'] => {
  const upper = `${rawType} ${rawName}`.toUpperCase();
  if (upper.includes('VST3')) return 'VST3';
  if (upper.includes('VST')) return 'VST2';
  if (upper.includes('CLAP')) return 'CLAP';
  if (upper.includes('JS')) return 'JS';
  return 'UNKNOWN';
};

/**
 * Safety barrier banning unattended blind binary/text .rpp file overwrites outside REAPER Main_SaveProject.
 */
export const assertRppMutationBlocked = (projectPath: string): never => {
  throw new DawBrainError(
    'DAW_CAPABILITY_UNSUPPORTED',
    `UNSUPPORTED: OS3 direct .rpp file mutation blocked for "${projectPath}"; project saves must go through REAPER Main_SaveProject API cleanly.`,
  );
};

/**
 * Read-only parser for plain-text REAPER `.rpp` project trees.
 * Guarantees SHA-256 identity preservation before & after parsing and marks embedded VST preset binary blobs opaque.
 */
export const inspectRppProjectFile = (filePath: string): RppParsedProject => {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new DawBrainError('DAW_INVALID_COMMAND', `INVALID_PROJECT_FILE: .rpp file not found at "${resolved}"`);
  }
  if (!resolved.toLowerCase().endsWith('.rpp')) {
    throw new DawBrainError('DAW_INVALID_COMMAND', `INVALID_PROJECT_FILE: expected .rpp extension for "${resolved}"`);
  }

  const { text, sha256: sha256BeforeRead } = readRppChecked(resolved);
  const lines = text.split(/\r?\n/);

  const firstNonEmpty = lines.find((l) => l.trim().length > 0)?.trim() ?? '';
  if (!firstNonEmpty.startsWith('<REAPER_PROJECT')) {
    throw new DawBrainError(
      'DAW_INVALID_COMMAND',
      `INVALID_PROJECT_FILE: "${resolved}" lacks <REAPER_PROJECT root block`,
    );
  }

  const warnings: string[] = [];
  const rootToks = tokenizeRppLine(firstNonEmpty.slice(1));
  const reaperVersion = rootToks[2] ?? null;
  let sampleRate: number | null = null;
  let tempoNum: number | null = null;
  let sigNum = 4;
  let sigDen = 4;
  let masterVol = 1.0;
  let renderOutputFile: string | null = null;

  const tracks: RppTrackEntry[] = [];
  const markers: {
    readonly id: number;
    readonly name: string;
    readonly positionSec: number;
    readonly isRegion: boolean;
    readonly regionEndSec?: number | undefined;
  }[] = [];

  const stack: string[] = [];
  let currentTrack: {
    guid: string;
    name: string;
    volumeLinear: number;
    pan: number;
    muted: boolean;
    soloed: boolean;
    armed: boolean;
    sendsToMaster: boolean;
    isFolderParent: boolean;
    fxChain: RppFxEntry[];
    receives: RppSendEntry[];
    envelopes: RppEnvelopeEntry[];
    items: RppMediaItemEntry[];
  } | null = null;
  let currentFx: {
    slotIndex: number;
    name: string;
    format: RppFxEntry['format'];
    bypassed: boolean;
    offline: boolean;
    hasOpaqueBinaryChunk: boolean;
  } | null = null;
  let pendingBypass: [boolean, boolean] = [false, false];
  let currentItem: {
    name: string;
    startSec: number;
    lengthSec: number;
    gainLinear: number;
    muted: boolean;
    kind: RppMediaItemEntry['kind'];
    sourcePath: string | null;
  } | null = null;
  let currentEnv: {
    targetName: string;
    armed: boolean;
    points: { positionSec: number; value: number; shape: number }[];
  } | null = null;
  let currentRegionStart: Map<number, { name: string; pos: number }> = new Map();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (trimmed === '>') {
      const popped = stack.pop();
      if (popped === 'PARMENV' && currentEnv && currentTrack) {
        currentTrack.envelopes.push({
          targetName: currentEnv.targetName,
          armed: currentEnv.armed,
          points: currentEnv.points,
        });
        currentEnv = null;
      } else if (popped === 'FX_NODE' && currentFx && currentTrack) {
        currentTrack.fxChain.push({ ...currentFx });
        currentFx = null;
      } else if (popped === 'ITEM' && currentItem && currentTrack) {
        currentTrack.items.push({ ...currentItem });
        currentItem = null;
      } else if (popped === 'TRACK' && currentTrack) {
        const trackIdx = tracks.length;
        const resolvedReceives = currentTrack.receives.map((r) => ({
          ...r,
          targetTrackIndex: trackIdx,
        }));
        tracks.push({
          index: trackIdx,
          guid: currentTrack.guid,
          name: currentTrack.name || `Track ${trackIdx + 1}`,
          volumeLinear: currentTrack.volumeLinear,
          volumeDb: linearToDb(currentTrack.volumeLinear),
          pan: currentTrack.pan,
          muted: currentTrack.muted,
          soloed: currentTrack.soloed,
          armed: currentTrack.armed,
          sendsToMaster: currentTrack.sendsToMaster,
          isFolderParent: currentTrack.isFolderParent,
          fxChain: currentTrack.fxChain,
          receives: resolvedReceives,
          envelopes: currentTrack.envelopes,
          items: currentTrack.items,
        });
        currentTrack = null;
      }
      continue;
    }

    if (trimmed.startsWith('<')) {
      const toks = tokenizeRppLine(trimmed.slice(1));
      const tag = toks[0] ?? 'BLOCK';

      if (tag === 'TRACK') {
        stack.push('TRACK');
        currentTrack = {
          guid: toks[1] ?? `track-guid-${tracks.length}`,
          name: '',
          volumeLinear: 1.0,
          pan: 0.0,
          muted: false,
          soloed: false,
          armed: false,
          sendsToMaster: true,
          isFolderParent: false,
          fxChain: [],
          receives: [],
          envelopes: [],
          items: [],
        };
      } else if (tag === 'FXCHAIN') {
        stack.push('FXCHAIN');
        pendingBypass = [false, false];
      } else if ((tag === 'VST' || tag === 'CLAP' || tag === 'JS' || tag === 'AU') && stack.includes('FXCHAIN')) {
        stack.push('FX_NODE');
        const fxName = toks[1] ?? `${tag} Plugin`;
        currentFx = {
          slotIndex: currentTrack?.fxChain.length ?? 0,
          name: fxName,
          format: classifyFxFormat(tag, fxName),
          bypassed: pendingBypass[0],
          offline: pendingBypass[1],
          hasOpaqueBinaryChunk: false,
        };
        pendingBypass = [false, false];
      } else if (tag === 'ITEM' && currentTrack) {
        stack.push('ITEM');
        currentItem = {
          name: 'Media Item',
          startSec: 0,
          lengthSec: 1,
          gainLinear: 1.0,
          muted: false,
          kind: 'unknown',
          sourcePath: null,
        };
      } else if (tag === 'SOURCE' && currentItem) {
        stack.push('SOURCE');
        const srcKind = (toks[1] ?? '').toUpperCase();
        currentItem.kind = srcKind === 'MIDI' ? 'midi' : srcKind === 'WAVE' || srcKind === 'FLAC' || srcKind === 'MP3' ? 'audio' : 'unknown';
      } else if ((tag === 'PARMENV' || tag === 'VOLENV2' || tag === 'VOLENV' || tag === 'PANENV2') && currentTrack) {
        stack.push('PARMENV');
        currentEnv = {
          targetName: tag === 'PARMENV' ? (toks[1] ?? 'ParamEnvelope') : tag,
          armed: true,
          points: [],
        };
      } else {
        stack.push(tag);
      }
      continue;
    }

    const toks = tokenizeRppLine(trimmed);
    const key = toks[0] ?? '';

    if (stack[stack.length - 1] === 'FX_NODE' && currentFx) {
      // Base64 opaque VST/CLAP chunk lines inside <VST ...>
      if (/^[A-Za-z0-9+/=]{16,}$/.test(trimmed)) {
        if (!currentFx.hasOpaqueBinaryChunk) {
          currentFx.hasOpaqueBinaryChunk = true;
          warnings.push(`Plugin "${currentFx.name}" preset state chunk is Base64-opaque in offline .rpp parse`);
        }
      }
      continue;
    }

    if (stack.length === 1 && stack[0] === 'REAPER_PROJECT') {
      if (key === 'TEMPO') {
        const bpm = Number.parseFloat(toks[1] ?? '');
        if (Number.isFinite(bpm) && bpm > 0) tempoNum = bpm;
        const num = Number.parseInt(toks[2] ?? '', 10);
        const den = Number.parseInt(toks[3] ?? '', 10);
        if (Number.isFinite(num) && num > 0) sigNum = num;
        if (Number.isFinite(den) && den > 0) sigDen = den;
      } else if (key === 'SAMPLERATE') {
        const sr = Number.parseInt(toks[1] ?? '', 10);
        if (Number.isFinite(sr) && sr > 0) sampleRate = sr;
      } else if (key === 'MASTER_VOLUME') {
        const v = Number.parseFloat(toks[1] ?? '');
        if (Number.isFinite(v)) masterVol = v;
      } else if (key === 'RENDER_FILE') {
        renderOutputFile = toks[1] ?? null;
      } else if (key === 'MARKER') {
        const id = Number.parseInt(toks[1] ?? '0', 10);
        const pos = Number.parseFloat(toks[2] ?? '0');
        const name = toks[3] ?? `Marker ${id}`;
        const flags = Number.parseInt(toks[4] ?? '0', 10);
        const isRegion = (flags & 1) === 1;
        if (isRegion) {
          const prev = currentRegionStart.get(id);
          if (!prev) {
            currentRegionStart.set(id, { name, pos });
          } else {
            markers.push({ id, name: prev.name || name, positionSec: prev.pos, isRegion: true, regionEndSec: pos });
            currentRegionStart.delete(id);
          }
        } else {
          markers.push({ id, name, positionSec: pos, isRegion: false });
        }
      }
      continue;
    }

    if (stack[stack.length - 1] === 'FXCHAIN' && key === 'BYPASS') {
      pendingBypass = [toks[1] === '1', toks[2] === '1'];
      continue;
    }

    if (stack[stack.length - 1] === 'PARMENV' && currentEnv && key === 'PT') {
      currentEnv.points.push({
        positionSec: Number.parseFloat(toks[1] ?? '0') || 0,
        value: Number.parseFloat(toks[2] ?? '0') || 0,
        shape: Number.parseInt(toks[3] ?? '0', 10) || 0,
      });
      continue;
    }

    if (stack[stack.length - 1] === 'SOURCE' && currentItem && key === 'FILE') {
      currentItem.sourcePath = toks[1] ?? null;
      continue;
    }

    if (stack[stack.length - 1] === 'ITEM' && currentItem) {
      if (key === 'POSITION') currentItem.startSec = Number.parseFloat(toks[1] ?? '0') || 0;
      else if (key === 'LENGTH') currentItem.lengthSec = Number.parseFloat(toks[1] ?? '0') || 0;
      else if (key === 'VOLPAN') currentItem.gainLinear = Number.parseFloat(toks[1] ?? '1') || 1;
      else if (key === 'MUTE') currentItem.muted = toks[1] === '1';
      else if (key === 'NAME') currentItem.name = toks[1] ?? currentItem.name;
      continue;
    }

    if (currentTrack) {
      if (key === 'NAME') {
        currentTrack.name = toks[1] ?? '';
      } else if (key === 'VOLPAN') {
        currentTrack.volumeLinear = Number.parseFloat(toks[1] ?? '1') || 0;
        currentTrack.pan = Number.parseFloat(toks[2] ?? '0') || 0;
      } else if (key === 'MUTESOLO') {
        currentTrack.muted = toks[1] === '1';
        currentTrack.soloed = (Number.parseInt(toks[2] ?? '0', 10) || 0) > 0;
      } else if (key === 'REC') {
        currentTrack.armed = toks[1] === '1';
      } else if (key === 'MAINSEND') {
        currentTrack.sendsToMaster = toks[1] !== '0';
      } else if (key === 'ISBUS') {
        currentTrack.isFolderParent = toks[1] === '1';
      } else if (key === 'AUXRECV') {
        const srcIdx = Number.parseInt(toks[1] ?? '-1', 10);
        const mode = Number.parseInt(toks[2] ?? '0', 10);
        const vol = Number.parseFloat(toks[3] ?? '1') || 0;
        const pan = Number.parseFloat(toks[4] ?? '0') || 0;
        const mute = toks[5] === '1';
        const dstCh = Number.parseInt(toks[9] ?? '0', 10);
        if (srcIdx >= 0) {
          currentTrack.receives.push({
            sourceTrackIndex: srcIdx,
            targetTrackIndex: tracks.length,
            enabled: !mute,
            volumeLinear: vol,
            volumeDb: linearToDb(vol),
            pan,
            preFader: mode === 1 || mode === 3,
            sidechainChannel: dstCh >= 2 ? dstCh : null,
          });
        }
      }
    }
  }

  const sha256AfterRead = readRppChecked(resolved).sha256;
  const projectName = path.basename(resolved, path.extname(resolved));

  return {
    projectPath: resolved,
    projectName,
    sha256BeforeRead,
    sha256AfterRead,
    reaperVersion,
    sampleRate,
    tempoBpm:
      tempoNum !== null
        ? { status: 'available', value: tempoNum }
        : { status: 'unknown', reason: 'TEMPO line omitted in .rpp header' },
    timeSignature: { status: 'available', value: { numerator: sigNum, denominator: sigDen } },
    masterVolumeLinear: masterVol,
    masterVolumeDb: linearToDb(masterVol),
    tracks,
    markers,
    renderOutputFile,
    project: {
      projectId: `rpp-${sha256BeforeRead.slice(0, 12)}`,
      name: projectName,
      format: '.rpp',
      projectPath: resolved,
      savedSha256: sha256BeforeRead,
      lastSavedAt: fs.statSync(resolved).mtime.toISOString(),
      editionRequirement: null,
      tempo: tempoNum !== null ? { bpm: tempoNum, freshness: 'saved' } : null,
      timeSignature: { numerator: sigNum, denominator: sigDen },
    },
    warnings,
  };
};

/**
 * Converts a parsed read-only `.rpp` project into a `DawStateSnapshot` (`saved` / offline tier)
 * clearly distinguishing saved `.rpp` metadata from live ReaScript observations.
 */
export const buildSnapshotFromRpp = (
  parsed: RppParsedProject,
  sessionId: string,
): DawStateSnapshot => {
  const bpm = parsed.tempoBpm.status === 'available' ? parsed.tempoBpm.value : 120;
  const sig = parsed.timeSignature.status === 'available' ? parsed.timeSignature.value : { numerator: 4, denominator: 4 };
  const prov: DawObservationProvenance = {
    observedAt: new Date().toISOString(),
    dawId: parsed.project.projectId,
    adapterId: 'reaper',
    hostVersion: parsed.reaperVersion ?? 'unknown',
    sourceEvidence: `.rpp saved tree (${parsed.sha256BeforeRead.slice(0, 12)})`,
    freshness: 'saved',
  };

  const dawTracks: DawTrack[] = [
    {
      id: 'reaper:track:master',
      index: -1,
      name: 'Master',
      kind: 'master',
      color: null,
      muted: false,
      soloed: false,
      armed: false,
      mixerChannelId: 'reaper:mixer:master',
    },
    ...parsed.tracks.map((t) => ({
      id: `reaper:track:${t.index}`,
      index: t.index,
      name: t.name,
      kind: (t.isFolderParent ? 'folder' : t.items.some((i) => i.kind === 'midi') ? 'midi' : 'audio') as DawTrack['kind'],
      color: null,
      muted: t.muted,
      soloed: t.soloed,
      armed: t.armed,
      mixerChannelId: `reaper:mixer:${t.index}`,
    })),
  ];

  const channels: DawChannel[] = parsed.tracks.map((t) => ({
    id: `reaper:chan:${t.index}`,
    index: t.index,
    name: t.name,
    kind: t.items.some((i) => i.kind === 'audio') ? 'audio_clip' : 'generator',
    targetMixerChannelId: `reaper:mixer:${t.index}`,
    muted: t.muted,
    soloed: t.soloed,
    volumeNormalized: Math.min(1, t.volumeLinear),
    panNormalized: t.pan,
  }));

  const plugins: DawPluginInstance[] = [];
  const mixerChannels: DawMixerChannel[] = [
    {
      id: 'reaper:mixer:master',
      index: -1,
      name: 'Master',
      isMaster: true,
      volumeNormalized: Math.min(1, parsed.masterVolumeLinear),
      volumeDb: parsed.masterVolumeDb,
      panNormalized: 0,
      muted: false,
      soloed: false,
      stereoSeparation: null,
      peakDb: null,
      pluginSlots: [],
    },
    ...parsed.tracks.map((t) => {
      const slotPlugs: DawPluginInstance[] = t.fxChain.map((fx) => {
        const inst: DawPluginInstance = {
          id: `reaper:fx:${t.index}:${fx.slotIndex}`,
          slotIndex: fx.slotIndex,
          containerId: `reaper:mixer:${t.index}`,
          name: fx.name,
          vendor: null,
          format: fx.format === 'VST3' || fx.format === 'VST2' || fx.format === 'CLAP' ? fx.format : fx.format === 'JS' ? 'NATIVE' : 'UNKNOWN',
          bypassed: fx.bypassed,
          mixLevel: null,
          editionCompatible: 'verified',
          parameterCount: 0,
          parameters: {
            status: 'unavailable',
            reason: fx.hasOpaqueBinaryChunk
              ? 'VST/CLAP internal Base64 state chunk is binary-opaque in .rpp; live ReaScript required for live parameter enumeration'
              : 'No parameter automation values present in offline .rpp snapshot',
          },
        };
        plugins.push(inst);
        return inst;
      });
      return {
        id: `reaper:mixer:${t.index}`,
        index: t.index,
        name: t.name,
        isMaster: false,
        volumeNormalized: Math.min(1, t.volumeLinear),
        volumeDb: t.volumeDb,
        panNormalized: t.pan,
        muted: t.muted,
        soloed: t.soloed,
        stereoSeparation: null,
        peakDb: null,
        pluginSlots: slotPlugs,
      };
    }),
  ];

  const routing: DawRoutingConnection[] = [];
  for (const t of parsed.tracks) {
    if (t.sendsToMaster) {
      routing.push({
        id: `reaper:route:${t.index}->master`,
        sourceId: `reaper:mixer:${t.index}`,
        targetId: 'reaper:mixer:master',
        sendNormalized: 1,
        sendDb: 0,
        enabled: true,
        preFader: false,
        sidechain: false,
      });
    }
    for (const r of t.receives) {
      routing.push({
        id: `reaper:route:${r.sourceTrackIndex}->${r.targetTrackIndex}`,
        sourceId: `reaper:mixer:${r.sourceTrackIndex}`,
        targetId: `reaper:mixer:${r.targetTrackIndex}`,
        sendNormalized: Math.min(1, r.volumeLinear),
        sendDb: r.volumeDb,
        enabled: r.enabled,
        preFader: r.preFader,
        sidechain: (r.sidechainChannel ?? 0) >= 2,
      });
    }
  }

  const buses: DawBus[] = [
    {
      id: 'reaper:mixer:master',
      mixerChannelId: 'reaper:mixer:master',
      name: 'Master',
      role: 'master',
      sourceIds: parsed.tracks.filter((t) => t.sendsToMaster).map((t) => `reaper:mixer:${t.index}`),
      destinationId: null,
    },
    ...parsed.tracks
      .filter((t) => t.isFolderParent || t.receives.length > 0)
      .map((t) => ({
        id: `reaper:mixer:${t.index}`,
        mixerChannelId: `reaper:mixer:${t.index}`,
        name: t.name,
        role: (t.receives.length > 0 ? 'submix' : 'aux') as DawBus['role'],
        sourceIds: t.receives.map((r) => `reaper:mixer:${r.sourceTrackIndex}`),
        destinationId: t.sendsToMaster ? 'reaper:mixer:master' : null,
      })),
  ];

  const secToBeats = (sec: number) => Number(((sec * bpm) / 60).toFixed(3));
  const audioClips: DawAudioClip[] = [];
  const midiClips: DawMidiClip[] = [];
  const automationLanes: DawAutomationLane[] = [];

  for (const t of parsed.tracks) {
    for (let idx = 0; idx < t.items.length; idx += 1) {
      const it = t.items[idx]!;
      if (it.kind === 'midi') {
        midiClips.push({
          id: `reaper:midi:${t.index}:${idx}`,
          name: it.name,
          trackId: `reaper:track:${t.index}`,
          channelId: `reaper:chan:${t.index}`,
          patternId: null,
          startBeats: secToBeats(it.startSec),
          lengthBeats: secToBeats(it.lengthSec),
          noteCount: null,
        });
      } else {
        audioClips.push({
          id: `reaper:audio:${t.index}:${idx}`,
          name: it.name,
          trackId: `reaper:track:${t.index}`,
          sourcePath: it.sourcePath,
          startBeats: secToBeats(it.startSec),
          lengthBeats: secToBeats(it.lengthSec),
          gainDb: linearToDb(it.gainLinear),
          muted: it.muted,
        });
      }
    }
    for (let eIdx = 0; eIdx < t.envelopes.length; eIdx += 1) {
      const env = t.envelopes[eIdx]!;
      automationLanes.push({
        id: `reaper:env:${t.index}:${eIdx}`,
        targetRef: `reaper:track:${t.index}`,
        parameterName: env.targetName,
        enabled: env.armed,
        points: {
          status: 'available',
          value: env.points.map((pt) => ({
            positionBeats: secToBeats(pt.positionSec),
            valueNormalized: Math.max(0, Math.min(1, pt.value)),
            curve: 'linear',
          })),
        },
      });
    }
  }

  const dawMarkers: DawMarker[] = parsed.markers
    .filter((m) => !m.isRegion)
    .map((m) => ({
      id: `reaper:marker:${m.id}`,
      name: m.name,
      positionBeats: secToBeats(m.positionSec),
      kind: 'marker',
    }));

  const dawRegions: DawRegion[] = parsed.markers
    .filter((m) => m.isRegion)
    .map((m) => ({
      id: `reaper:region:${m.id}`,
      name: m.name,
      startBeats: secToBeats(m.positionSec),
      endBeats: secToBeats(m.regionEndSec ?? m.positionSec),
      color: null,
    }));

  const base: DawStateSnapshot = {
    snapshotId: `rppsnap-${parsed.sha256BeforeRead.slice(0, 8)}`,
    sessionId,
    freshness: 'saved',
    provenance: prov,
    transport: {
      playing: false,
      paused: false,
      recording: false,
      loopEnabled: false,
      songPositionBeats: 0,
      songPositionSeconds: 0,
      tempo: { bpm, freshness: 'saved' },
      timeSignature: sig,
      provenance: prov,
    },
    tracks: { status: 'available', value: dawTracks },
    channels: { status: 'available', value: channels },
    mixerChannels: { status: 'available', value: mixerChannels },
    buses: { status: 'available', value: buses },
    routing: { status: 'available', value: routing },
    plugins: { status: 'available', value: plugins },
    automationLanes: { status: 'available', value: automationLanes },
    audioClips: { status: 'available', value: audioClips },
    midiClips: { status: 'available', value: midiClips },
    markers: { status: 'available', value: dawMarkers },
    regions: { status: 'available', value: dawRegions },
    stateDigest: '',
  };

  return {
    ...base,
    stateDigest: computeSnapshotDigest(base),
  };
};
