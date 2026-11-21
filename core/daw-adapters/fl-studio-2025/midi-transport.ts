import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DawBrainError } from '../../daw-brain/index.ts';
import {
  assertStrict7BitSysEx,
  decodeSysExFrame,
  encodeSysExMessage,
  SysExChunkAssembler,
} from './sysex-protocol.ts';
import type {
  FlLiveHelloPayload,
  FlLiveParameterInfo,
  FlLiveSnapshotPayload,
  FlSysExMessageType,
} from './types.ts';

export interface FlMidiSysExTransport {
  readonly transportId: string;
  isOpen(): boolean;
  open(options: { readonly inPortName: string; readonly outPortName: string }): Promise<void>;
  close(): Promise<void>;
  request<T = unknown>(
    msgType: FlSysExMessageType,
    expectedReplyType: FlSysExMessageType,
    payload?: unknown,
    timeoutMs?: number,
  ): Promise<T>;
  sendRawSysEx(frame: Uint8Array): Promise<void>;
  onPushMessage(listener: (msg: { readonly msgType: FlSysExMessageType; readonly json: unknown }) => void): () => void;
  onDisconnect(listener: (reason: string) => void): () => void;
}

const WINMM_BRIDGE_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class Os3WinMmBridge {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MIDIINCAPS { public ushort wMid; public ushort wPid; public uint vDriverVersion; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname; public uint dwSupport; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MIDIOUTCAPS { public ushort wMid; public ushort wPid; public uint vDriverVersion; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname; public ushort wTechnology; public ushort wVoices; public ushort wNotes; public ushort wChannelMask; public uint dwSupport; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MIDIHDR {
    public IntPtr lpData;
    public uint dwBufferLength;
    public uint dwBytesRecorded;
    public IntPtr dwUser;
    public uint dwFlags;
    public IntPtr lpNext;
    public IntPtr reserved;
    public uint dwOffset;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 8)]
    public IntPtr[] reservedArray;
  }

  public delegate void MidiInProc(IntPtr hMidiIn, uint wMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2);

  [DllImport("winmm.dll")] public static extern uint midiInGetNumDevs();
  [DllImport("winmm.dll", EntryPoint="midiInGetDevCapsW", CharSet = CharSet.Unicode)] public static extern uint midiInGetDevCaps(UIntPtr uDeviceID, ref MIDIINCAPS lpMidiInCaps, uint cbMidiInCaps);
  [DllImport("winmm.dll")] public static extern uint midiOutGetNumDevs();
  [DllImport("winmm.dll", EntryPoint="midiOutGetDevCapsW", CharSet = CharSet.Unicode)] public static extern uint midiOutGetDevCaps(UIntPtr uDeviceID, ref MIDIOUTCAPS lpMidiOutCaps, uint cbMidiOutCaps);
  [DllImport("winmm.dll")] public static extern uint midiOutOpen(out IntPtr lphMidiOut, uint uDeviceID, IntPtr dwCallback, IntPtr dwInstance, uint dwFlags);
  [DllImport("winmm.dll")] public static extern uint midiOutClose(IntPtr hMidiOut);
  [DllImport("winmm.dll")] public static extern uint midiOutPrepareHeader(IntPtr hMidiOut, IntPtr lpMidiOutHdr, uint cbMidiOutHdr);
  [DllImport("winmm.dll")] public static extern uint midiOutUnprepareHeader(IntPtr hMidiOut, IntPtr lpMidiOutHdr, uint cbMidiOutHdr);
  [DllImport("winmm.dll")] public static extern uint midiOutLongMsg(IntPtr hMidiOut, IntPtr lpMidiOutHdr, uint cbMidiOutHdr);
  [DllImport("winmm.dll")] public static extern uint midiInOpen(out IntPtr lphMidiIn, uint uDeviceID, MidiInProc dwCallback, IntPtr dwInstance, uint dwFlags);
  [DllImport("winmm.dll")] public static extern uint midiInClose(IntPtr hMidiIn);
  [DllImport("winmm.dll")] public static extern uint midiInStart(IntPtr hMidiIn);
  [DllImport("winmm.dll")] public static extern uint midiInStop(IntPtr hMidiIn);
  [DllImport("winmm.dll")] public static extern uint midiInReset(IntPtr hMidiIn);
  [DllImport("winmm.dll")] public static extern uint midiInPrepareHeader(IntPtr hMidiIn, IntPtr lpMidiInHdr, uint cbMidiInHdr);
  [DllImport("winmm.dll")] public static extern uint midiInUnprepareHeader(IntPtr hMidiIn, IntPtr lpMidiInHdr, uint cbMidiInHdr);
  [DllImport("winmm.dll")] public static extern uint midiInAddBuffer(IntPtr hMidiIn, IntPtr lpMidiInHdr, uint cbMidiInHdr);
}
"@
Write-Error "Initialized manually via command args"
`;
void WINMM_BRIDGE_PS;

/**
 * Real Windows 11 WinMM MIDI SysEx bridge driver.
 * Opens configured `loopMIDI` WinMM ports cleanly when present on Windows 11, or
 * fails fast with `DAW_HOST_OFFLINE` + exact remediation when `loopMIDI` is missing.
 */
export class WinMmSysExTransport implements FlMidiSysExTransport {
  readonly transportId = 'winmm-sysex';
  #open = false;
  #seq = 1;
  #proc: ChildProcessWithoutNullStreams | null = null;
  readonly #assembler = new SysExChunkAssembler();
  readonly #pending = new Map<
    string,
    {
      readonly resolve: (val: unknown) => void;
      readonly reject: (err: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #pushListeners = new Set<(msg: { readonly msgType: FlSysExMessageType; readonly json: unknown }) => void>();
  readonly #disconnectListeners = new Set<(reason: string) => void>();

  isOpen(): boolean {
    return this.#open;
  }

  async open(options: { readonly inPortName: string; readonly outPortName: string }): Promise<void> {
    if (this.#open) return;
    if (process.platform !== 'win32') {
      throw new DawBrainError(
        'DAW_HOST_OFFLINE',
        'WinMmSysExTransport requires Windows 11 winmm.dll',
      );
    }

    const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;

public class Os3LiveWinMm {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MIDIINCAPS { public ushort wMid; public ushort wPid; public uint vDriverVersion; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname; public uint dwSupport; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MIDIOUTCAPS { public ushort wMid; public ushort wPid; public uint vDriverVersion; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname; public ushort wTechnology; public ushort wVoices; public ushort wNotes; public ushort wChannelMask; public uint dwSupport; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MIDIHDR {
    public IntPtr lpData; public uint dwBufferLength; public uint dwBytesRecorded;
    public IntPtr dwUser; public uint dwFlags; public IntPtr lpNext; public IntPtr reserved;
    public uint dwOffset;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 8)] public IntPtr[] reservedArray;
  }
  public delegate void MidiInProc(IntPtr hMidiIn, uint wMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2);

  [DllImport("winmm.dll")] public static extern uint midiInGetNumDevs();
  [DllImport("winmm.dll", EntryPoint="midiInGetDevCapsW", CharSet = CharSet.Unicode)] public static extern uint midiInGetDevCaps(UIntPtr id, ref MIDIINCAPS caps, uint sz);
  [DllImport("winmm.dll")] public static extern uint midiOutGetNumDevs();
  [DllImport("winmm.dll", EntryPoint="midiOutGetDevCapsW", CharSet = CharSet.Unicode)] public static extern uint midiOutGetDevCaps(UIntPtr id, ref MIDIOUTCAPS caps, uint sz);
  [DllImport("winmm.dll")] public static extern uint midiOutOpen(out IntPtr hOut, uint id, IntPtr cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")] public static extern uint midiOutClose(IntPtr hOut);
  [DllImport("winmm.dll")] public static extern uint midiOutPrepareHeader(IntPtr hOut, IntPtr hdr, uint sz);
  [DllImport("winmm.dll")] public static extern uint midiOutUnprepareHeader(IntPtr hOut, IntPtr hdr, uint sz);
  [DllImport("winmm.dll")] public static extern uint midiOutLongMsg(IntPtr hOut, IntPtr hdr, uint sz);
  [DllImport("winmm.dll")] public static extern uint midiInOpen(out IntPtr hIn, uint id, MidiInProc cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")] public static extern uint midiInClose(IntPtr hIn);
  [DllImport("winmm.dll")] public static extern uint midiInStart(IntPtr hIn);
  [DllImport("winmm.dll")] public static extern uint midiInStop(IntPtr hIn);
  [DllImport("winmm.dll")] public static extern uint midiInReset(IntPtr hIn);
  [DllImport("winmm.dll")] public static extern uint midiInPrepareHeader(IntPtr hIn, IntPtr hdr, uint sz);
  [DllImport("winmm.dll")] public static extern uint midiInAddBuffer(IntPtr hIn, IntPtr hdr, uint sz);

  private static IntPtr hIn = IntPtr.Zero;
  private static IntPtr hOut = IntPtr.Zero;
  private static bool closing = false;
  private static MidiInProc inDelegate;
  private static readonly BlockingCollection<string> rxQueue = new BlockingCollection<string>();
  private static IntPtr[] rxHdrPtrs = new IntPtr[4];
  private static IntPtr[] rxBufPtrs = new IntPtr[4];
  private const uint CALLBACK_FUNCTION = 0x00030000;
  private const uint MIM_LONGDATA = 0x3C4;
  private const uint BUF_LEN = 4096;

  private static void OnMidiIn(IntPtr hMidiIn, uint wMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2) {
    if (closing || wMsg != MIM_LONGDATA || dwParam1 == IntPtr.Zero) return;
    MIDIHDR hdr = Marshal.PtrToStructure<MIDIHDR>(dwParam1);
    if (hdr.dwBytesRecorded > 0 && hdr.lpData != IntPtr.Zero) {
      byte[] buf = new byte[hdr.dwBytesRecorded];
      Marshal.Copy(hdr.lpData, buf, 0, (int)hdr.dwBytesRecorded);
      rxQueue.Add(BitConverter.ToString(buf).Replace("-", ""));
    }
    if (!closing) midiInAddBuffer(hIn, dwParam1, (uint)Marshal.SizeOf<MIDIHDR>());
  }

  public static string Open(string outNameMatch, string inNameMatch) {
    uint outId = uint.MaxValue, inId = uint.MaxValue;
    for (uint i = 0; i < midiOutGetNumDevs(); i++) {
      var c = new MIDIOUTCAPS();
      if (midiOutGetDevCaps((UIntPtr)i, ref c, (uint)Marshal.SizeOf<MIDIOUTCAPS>()) == 0) {
        if (c.szPname.IndexOf(outNameMatch, StringComparison.OrdinalIgnoreCase) >= 0) { outId = i; break; }
      }
    }
    for (uint i = 0; i < midiInGetNumDevs(); i++) {
      var c = new MIDIINCAPS();
      if (midiInGetDevCaps((UIntPtr)i, ref c, (uint)Marshal.SizeOf<MIDIINCAPS>()) == 0) {
        if (c.szPname.IndexOf(inNameMatch, StringComparison.OrdinalIgnoreCase) >= 0) { inId = i; break; }
      }
    }
    if (outId == uint.MaxValue || inId == uint.MaxValue) {
      return "MISSING_PORTS";
    }
    uint rOut = midiOutOpen(out hOut, outId, IntPtr.Zero, IntPtr.Zero, 0);
    if (rOut != 0) return "OUT_OPEN_ERR_" + rOut;
    inDelegate = new MidiInProc(OnMidiIn);
    uint rIn = midiInOpen(out hIn, inId, inDelegate, IntPtr.Zero, CALLBACK_FUNCTION);
    if (rIn != 0) { midiOutClose(hOut); return "IN_OPEN_ERR_" + rIn; }
    uint hdrSz = (uint)Marshal.SizeOf<MIDIHDR>();
    for (int i = 0; i < 4; i++) {
      rxBufPtrs[i] = Marshal.AllocHGlobal((int)BUF_LEN);
      var hdr = new MIDIHDR { lpData = rxBufPtrs[i], dwBufferLength = BUF_LEN, reservedArray = new IntPtr[8] };
      rxHdrPtrs[i] = Marshal.AllocHGlobal((int)hdrSz);
      Marshal.StructureToPtr(hdr, rxHdrPtrs[i], false);
      midiInPrepareHeader(hIn, rxHdrPtrs[i], hdrSz);
      midiInAddBuffer(hIn, rxHdrPtrs[i], hdrSz);
    }
    midiInStart(hIn);
    return "OK";
  }

  public static void SendHex(string hex) {
    int len = hex.Length / 2;
    byte[] data = new byte[len];
    for (int i = 0; i < len; i++) data[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
    IntPtr buf = Marshal.AllocHGlobal(len);
    Marshal.Copy(data, 0, buf, len);
    uint hdrSz = (uint)Marshal.SizeOf<MIDIHDR>();
    var hdr = new MIDIHDR { lpData = buf, dwBufferLength = (uint)len, dwBytesRecorded = (uint)len, reservedArray = new IntPtr[8] };
    IntPtr pHdr = Marshal.AllocHGlobal((int)hdrSz);
    Marshal.StructureToPtr(hdr, pHdr, false);
    midiOutPrepareHeader(hOut, pHdr, hdrSz);
    midiOutLongMsg(hOut, pHdr, hdrSz);
    midiOutUnprepareHeader(hOut, pHdr, hdrSz);
    Marshal.FreeHGlobal(pHdr);
    Marshal.FreeHGlobal(buf);
  }

  public static string PollRx(int timeoutMs) {
    string s;
    return rxQueue.TryTake(out s, timeoutMs) ? s : null;
  }

  public static void Close() {
    closing = true;
    if (hIn != IntPtr.Zero) { midiInStop(hIn); midiInReset(hIn); midiInClose(hIn); hIn = IntPtr.Zero; }
    if (hOut != IntPtr.Zero) { midiOutClose(hOut); hOut = IntPtr.Zero; }
  }
}
"@
$status = [Os3LiveWinMm]::Open('${options.inPortName.replace(/'/g, "''")}', '${options.outPortName.replace(/'/g, "''")}')
[Console]::Out.WriteLine('STATUS:' + $status)
[Console]::Out.Flush()
if ($status -ne 'OK') { exit 2 }
$inTask = [System.Console]::In.ReadLineAsync()
while ($true) {
  $rx = [Os3LiveWinMm]::PollRx(20)
  if ($rx -ne $null) {
    [Console]::Out.WriteLine('SYSEX:' + $rx)
    [Console]::Out.Flush()
  }
  if ($inTask.IsCompleted) {
    $line = $inTask.Result
    if ($line -eq $null -or $line -eq 'QUIT') { break }
    if ($line.StartsWith('TX:')) {
      [Os3LiveWinMm]::SendHex($line.Substring(3))
    }
    $inTask = [System.Console]::In.ReadLineAsync()
  }
}
[Os3LiveWinMm]::Close()
`;

    await new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        windowsHide: true,
      });
      this.#proc = child;
      let settled = false;
      const rl = createInterface({ input: child.stdout });

      const startupTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.#proc?.kill();
          this.#proc = null;
          reject(new DawBrainError('DAW_TIMEOUT', 'Timed out initializing WinMM MIDI bridge'));
        }
      }, 6_000);

      rl.on('line', (line) => {
        if (line.startsWith('STATUS:')) {
          const st = line.slice(7).trim();
          clearTimeout(startupTimer);
          if (st === 'OK') {
            this.#open = true;
            if (!settled) {
              settled = true;
              resolve();
            }
          } else {
            this.#open = false;
            child.kill();
            this.#proc = null;
            if (!settled) {
              settled = true;
              reject(
                new DawBrainError(
                  'DAW_HOST_OFFLINE',
                  `WinMM loopback ports unavailable (${st}): required ports "${options.inPortName}" and "${options.outPortName}" missing (install loopMIDI)`,
                ),
              );
            }
          }
          return;
        }
        if (line.startsWith('SYSEX:')) {
          const hex = line.slice(6).trim();
          const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
          this.#handleIncomingBytes(bytes);
        }
      });

      child.once('exit', (code) => {
        clearTimeout(startupTimer);
        const wasOpen = this.#open;
        this.#open = false;
        this.#proc = null;
        const err = new DawBrainError('DAW_HOST_OFFLINE', `WinMM MIDI bridge exited (${String(code)})`);
        for (const p of this.#pending.values()) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.#pending.clear();
        if (!settled) {
          settled = true;
          reject(err);
        } else if (wasOpen) {
          for (const cb of this.#disconnectListeners) cb(err.message);
        }
      });
    });
  }

  async close(): Promise<void> {
    if (!this.#open && !this.#proc) return;
    this.#open = false;
    try {
      this.#proc?.stdin.write('QUIT\n');
    } catch {
      // Ignore broken pipe
    }
    this.#proc?.kill();
    this.#proc = null;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new DawBrainError('DAW_HOST_OFFLINE', 'WinMM MIDI port closed'));
    }
    this.#pending.clear();
  }

  async sendRawSysEx(frame: Uint8Array): Promise<void> {
    if (!this.#open || !this.#proc) {
      throw new DawBrainError('DAW_HOST_OFFLINE', 'WinMM MIDI bridge is not open');
    }
    assertStrict7BitSysEx(frame);
    this.#proc.stdin.write(`TX:${Buffer.from(frame).toString('hex')}\n`);
  }

  async request<T = unknown>(
    msgType: FlSysExMessageType,
    expectedReplyType: FlSysExMessageType,
    payload: unknown = {},
    timeoutMs = 2_500,
  ): Promise<T> {
    const seq = this.#seq;
    this.#seq = (this.#seq + 1) & 0x3fff;
    const key = `${expectedReplyType}:${seq}`;

    const frames = encodeSysExMessage(msgType, seq, payload);
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        reject(new DawBrainError('DAW_TIMEOUT', `FL Studio SysEx request timeout after ${timeoutMs}ms (seq=${seq})`));
      }, timeoutMs);
      this.#pending.set(key, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
    });

    for (const f of frames) {
      await this.sendRawSysEx(f);
    }
    return promise;
  }

  onPushMessage(listener: (msg: { readonly msgType: FlSysExMessageType; readonly json: unknown }) => void): () => void {
    this.#pushListeners.add(listener);
    return () => this.#pushListeners.delete(listener);
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  #handleIncomingBytes(frame: Uint8Array): void {
    try {
      const res = this.#assembler.push(frame);
      if (!res.complete) return;
      if (res.msgType === 0x7e || res.msgType === 0x7f) {
        const keyErrMatch = [...this.#pending.entries()].find(([k]) => k.endsWith(`:${res.seq}`));
        if (keyErrMatch) {
          const [k, pending] = keyErrMatch;
          this.#pending.delete(k);
          clearTimeout(pending.timer);
          pending.reject(new DawBrainError('DAW_CAPABILITY_UNSUPPORTED', JSON.stringify(res.json)));
        }
        return;
      }
      const key = `${res.msgType}:${res.seq}`;
      const pending = this.#pending.get(key);
      if (pending) {
        this.#pending.delete(key);
        clearTimeout(pending.timer);
        pending.resolve(res.json);
        return;
      }
      for (const cb of this.#pushListeners) {
        cb({ msgType: res.msgType, json: res.json });
      }
    } catch {
      // Ignore non-OS3 external MIDI SysEx chatter safely
    }
  }
}

export type MockFlMidiOptions = {
  readonly portsPresent?: boolean | undefined;
  readonly latencyMs?: number | undefined;
  readonly corruptNextCrc?: boolean | undefined;
  readonly dropPortOnOpen?: boolean | undefined;
  readonly allowControlledWrites?: boolean | undefined;
  readonly hello?: Partial<FlLiveHelloPayload> | undefined;
  readonly initialSnapshot?: Partial<FlLiveSnapshotPayload> | undefined;
  readonly parameters?: readonly FlLiveParameterInfo[] | undefined;
};

/**
 * Deterministic `FXT-MIDI-01` SysEx loopback fixture simulating wire-level 7-bit SysEx
 * encoding/decoding, chunked >1KB payloads, CRC faults, version mismatches, disconnects, and recovery.
 */
export class MockFlMidiTransport implements FlMidiSysExTransport {
  readonly transportId = 'mock-fl-sysex-fxt-midi-01';
  #open = false;
  #portsPresent: boolean;
  #latencyMs: number;
  #corruptNextCrc: boolean;
  #offline = false;
  #allowControlledWrites: boolean;
  #seq = 1;
  #hello: FlLiveHelloPayload;
  #snapshot: FlLiveSnapshotPayload;
  #parameters: readonly FlLiveParameterInfo[];
  readonly #rxAssembler = new SysExChunkAssembler();
  readonly #txAssembler = new SysExChunkAssembler();
  readonly #pushListeners = new Set<(msg: { readonly msgType: FlSysExMessageType; readonly json: unknown }) => void>();
  readonly #disconnectListeners = new Set<(reason: string) => void>();

  constructor(options: MockFlMidiOptions = {}) {
    this.#portsPresent = options.portsPresent ?? true;
    this.#latencyMs = options.latencyMs ?? 5;
    this.#corruptNextCrc = options.corruptNextCrc ?? false;
    this.#offline = options.dropPortOnOpen ?? false;
    this.#allowControlledWrites = options.allowControlledWrites ?? false;

    this.#hello = {
      hostName: 'FL Studio',
      fullVersionAndEdition: '25.1.6.4997 Producer Edition',
      version: '25.1.6.4997',
      edition: 'Producer Edition',
      apiVersion: 33,
      ppq: 96,
      title: 'COLDINMYEYES.flp',
      scriptVersion: '2025.1.0-readonly',
      readOnly: true,
      ...options.hello,
    };

    this.#snapshot = {
      observedAt: new Date().toISOString(),
      title: this.#hello.title,
      fullVersionAndEdition: this.#hello.fullVersionAndEdition,
      version: this.#hello.version,
      edition: this.#hello.edition,
      apiVersion: this.#hello.apiVersion,
      ppq: this.#hello.ppq,
      playing: false,
      recording: false,
      loopMode: 'song',
      songPosMs: 0,
      songPosBeats: 0,
      tempoBpm: 138,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      channels: [
        {
          index: 0,
          name: '808 Sub',
          channelType: 2,
          targetMixerIndex: 1,
          muted: false,
          soloed: false,
          pluginName: 'FLEX',
          pluginParamCount: 12,
        },
        {
          index: 1,
          name: 'Lead Vocal Clip',
          channelType: 4,
          targetMixerIndex: 2,
          muted: false,
          soloed: false,
          pluginName: null,
          pluginParamCount: null,
        },
      ],
      mixerTracks: [
        {
          index: 0,
          name: 'Master',
          isMaster: true,
          volumeNormalized: 0.8,
          panNormalized: 0,
          muted: false,
          soloed: false,
          peakNormalized: 0.42,
          routesToMaster: null,
          routeTargets: [],
          plugins: [
            { slotIndex: 0, name: 'Fruity Limiter', bypassed: false, mixLevel: 1, paramCount: 20 },
          ],
        },
        {
          index: 1,
          name: 'BASS',
          isMaster: false,
          volumeNormalized: 0.78,
          panNormalized: 0,
          muted: false,
          soloed: false,
          peakNormalized: 0.35,
          routesToMaster: true,
          routeTargets: [0],
          plugins: [
            { slotIndex: 0, name: 'Fruity Parametric EQ 2', bypassed: false, mixLevel: 1, paramCount: 14 },
          ],
        },
        {
          index: 2,
          name: 'LEAD VOX',
          isMaster: false,
          volumeNormalized: 0.82,
          panNormalized: 0,
          muted: false,
          soloed: false,
          peakNormalized: 0.51,
          routesToMaster: true,
          routeTargets: [0, 3],
          plugins: [
            { slotIndex: 0, name: 'FabFilter Pro-Q 3', bypassed: false, mixLevel: 1, paramCount: 32 },
          ],
        },
        {
          index: 3,
          name: 'VOXVERB',
          isMaster: false,
          volumeNormalized: 0.64,
          panNormalized: 0,
          muted: false,
          soloed: false,
          peakNormalized: 0.12,
          routesToMaster: true,
          routeTargets: [0],
          plugins: [
            { slotIndex: 0, name: 'Fruity Reeverb 2', bypassed: false, mixLevel: 1, paramCount: 16 },
          ],
        },
      ],
      playlistTrackCount: 7,
      playlistTrackNames: ['LEAD VOX', 'DRUMS', 'BASS', 'KEYBOARD', 'STRINGS', 'SYNTH', 'OTHER'],
      ...options.initialSnapshot,
    };

    this.#parameters = options.parameters ?? [
      {
        containerKind: 'mixer',
        containerIndex: 2,
        slotIndex: 0,
        pluginName: 'FabFilter Pro-Q 3',
        paramIndex: 0,
        name: 'Band 1 Frequency',
        valueNormalized: 0.41,
        displayValue: '185 Hz',
      },
      {
        containerKind: 'mixer',
        containerIndex: 2,
        slotIndex: 0,
        pluginName: 'FabFilter Pro-Q 3',
        paramIndex: 1,
        name: 'Band 1 Gain',
        valueNormalized: 0.44,
        displayValue: '-3.0 dB',
      },
    ];
  }

  isOpen(): boolean {
    return this.#open && !this.#offline;
  }

  setOffline(offline: boolean, reason = 'Simulated loopMIDI port closed'): void {
    const wasOpen = this.#open && !this.#offline;
    this.#offline = offline;
    if (offline && wasOpen) {
      this.#open = false;
      for (const cb of this.#disconnectListeners) cb(reason);
    }
  }

  setPortsPresent(present: boolean): void {
    this.#portsPresent = present;
  }

  setVersion(version: string, edition = 'Producer Edition'): void {
    this.#hello = {
      ...this.#hello,
      version,
      edition,
      fullVersionAndEdition: `${version} ${edition}`,
    };
    this.#snapshot = {
      ...this.#snapshot,
      version,
      edition,
      fullVersionAndEdition: `${version} ${edition}`,
    };
  }

  injectHostStateChange(patch: Partial<FlLiveSnapshotPayload>, emitDirtyPush = true): void {
    this.#snapshot = {
      ...this.#snapshot,
      ...patch,
      observedAt: new Date().toISOString(),
    };
    if (emitDirtyPush && this.isOpen()) {
      for (const cb of this.#pushListeners) {
        cb({ msgType: 0x20, json: { ...this.#snapshot, dirtyFlags: 4 } });
      }
    }
  }

  injectCorruptNextCrc(): void {
    this.#corruptNextCrc = true;
  }

  async open(options: { readonly inPortName: string; readonly outPortName: string }): Promise<void> {
    if (!this.#portsPresent) {
      throw new DawBrainError(
        'DAW_HOST_OFFLINE',
        `Virtual MIDI loopback ports unavailable (${options.inPortName} / ${options.outPortName})`,
      );
    }
    if (this.#offline) {
      throw new DawBrainError('DAW_HOST_OFFLINE', 'FL Studio SysEx controller offline');
    }
    this.#open = true;
  }

  async close(): Promise<void> {
    this.#open = false;
  }

  async sendRawSysEx(frame: Uint8Array): Promise<void> {
    assertStrict7BitSysEx(frame);
    if (!this.isOpen()) {
      throw new DawBrainError('DAW_HOST_OFFLINE', 'Mock FL MIDI transport is closed');
    }
  }

  async request<T = unknown>(
    msgType: FlSysExMessageType,
    expectedReplyType: FlSysExMessageType,
    payload: unknown = {},
    timeoutMs = 2_500,
  ): Promise<T> {
    void timeoutMs;
    if (!this.isOpen()) {
      throw new DawBrainError('DAW_HOST_OFFLINE', 'Mock FL MIDI transport is closed');
    }

    const seq = this.#seq;
    this.#seq = (this.#seq + 1) & 0x3fff;

    // Exercise exact 7-bit wire encode -> decode path in tests!
    const requestFrames = encodeSysExMessage(msgType, seq, payload);
    let reqParsed: unknown = {};
    for (const f of requestFrames) {
      assertStrict7BitSysEx(f);
      const step = this.#rxAssembler.push(f);
      if (step.complete) reqParsed = step.json;
    }

    if (this.#latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.#latencyMs));
    }

    let replyType: FlSysExMessageType = expectedReplyType;
    let replyBody: unknown;
    if (msgType === 0x01) {
      replyBody = this.#hello;
    } else if (msgType === 0x03) {
      replyBody = { pong: true, echoTs: (reqParsed as Record<string, unknown>).ts ?? null, readOnly: true };
    } else if (msgType === 0x10) {
      replyBody = { ...this.#snapshot, observedAt: new Date().toISOString() };
    } else if (msgType === 0x12) {
      const p = reqParsed as { containerKind?: string; containerIndex?: number; slotIndex?: number; maxParams?: number };
      replyBody = {
        parameters: this.#parameters
          .filter(
            (item) =>
              (!p.containerKind || item.containerKind === p.containerKind) &&
              (p.containerIndex === undefined || item.containerIndex === p.containerIndex) &&
              (p.slotIndex === undefined || item.slotIndex === p.slotIndex),
          )
          .slice(0, p.maxParams ?? 32),
      };
    } else if (this.#allowControlledWrites && msgType === 0x30) {
      const p = reqParsed as { playing?: boolean; loopMode?: 'pattern' | 'song'; tempoBpm?: number };
      this.#snapshot = {
        ...this.#snapshot,
        playing: typeof p.playing === 'boolean' ? p.playing : this.#snapshot.playing,
        loopMode: p.loopMode ?? this.#snapshot.loopMode,
        tempoBpm: typeof p.tempoBpm === 'number' ? p.tempoBpm : this.#snapshot.tempoBpm,
        observedAt: new Date().toISOString(),
      };
      replyBody = {
        ok: true,
        playing: this.#snapshot.playing,
        loopMode: this.#snapshot.loopMode,
        tempoBpm: this.#snapshot.tempoBpm,
      };
    } else if (this.#allowControlledWrites && msgType === 0x32) {
      const p = reqParsed as {
        mixerIndex: number;
        volumeNormalized?: number;
        panNormalized?: number;
        muted?: boolean;
        soloed?: boolean;
      };
      let updatedTrack = this.#snapshot.mixerTracks.find((m) => m.index === p.mixerIndex);
      if (updatedTrack) {
        this.#snapshot = {
          ...this.#snapshot,
          observedAt: new Date().toISOString(),
          mixerTracks: this.#snapshot.mixerTracks.map((mt) => {
            if (mt.index !== p.mixerIndex) return mt;
            updatedTrack = {
              ...mt,
              volumeNormalized:
                typeof p.volumeNormalized === 'number' ? p.volumeNormalized : mt.volumeNormalized,
              panNormalized: typeof p.panNormalized === 'number' ? p.panNormalized : mt.panNormalized,
              muted: typeof p.muted === 'boolean' ? p.muted : mt.muted,
              soloed: typeof p.soloed === 'boolean' ? p.soloed : mt.soloed,
            };
            return updatedTrack;
          }),
        };
      }
      replyBody = { ok: Boolean(updatedTrack), track: updatedTrack ?? null };
    } else if (this.#allowControlledWrites && msgType === 0x34) {
      const p = reqParsed as { mixerIndex: number; slotIndex: number; bypassed: boolean };
      let found = false;
      this.#snapshot = {
        ...this.#snapshot,
        observedAt: new Date().toISOString(),
        mixerTracks: this.#snapshot.mixerTracks.map((mt) => {
          if (mt.index !== p.mixerIndex) return mt;
          return {
            ...mt,
            plugins: mt.plugins.map((pl) => {
              if (pl.slotIndex !== p.slotIndex) return pl;
              found = true;
              return { ...pl, bypassed: p.bypassed };
            }),
          };
        }),
      };
      replyBody = { ok: found, mixerIndex: p.mixerIndex, slotIndex: p.slotIndex, bypassed: p.bypassed };
    } else {
      replyType = 0x7e;
      replyBody = { error: 'DAW_CAPABILITY_UNSUPPORTED', reason: 'Read-only Phase 11 FL script rejects write opcode' };
    }

    const replyFrames = encodeSysExMessage(replyType, seq, replyBody);
    let assembled: unknown = null;
    for (let i = 0; i < replyFrames.length; i += 1) {
      const raw = replyFrames[i]!;
      let frameToDecode = raw;
      if (i === 0 && this.#corruptNextCrc) {
        this.#corruptNextCrc = false;
        const tampered = new Uint8Array(raw);
        tampered[12] = ((tampered[12] ?? 0) ^ 0x1f) & 0x7f;
        frameToDecode = tampered;
      }
      assertStrict7BitSysEx(frameToDecode);
      decodeSysExFrame(frameToDecode);
      const step = this.#txAssembler.push(frameToDecode);
      if (step.complete) {
        if (step.msgType === 0x7e) {
          throw new DawBrainError('DAW_CAPABILITY_UNSUPPORTED', JSON.stringify(step.json));
        }
        assembled = step.json;
      }
    }

    return assembled as T;
  }

  onPushMessage(listener: (msg: { readonly msgType: FlSysExMessageType; readonly json: unknown }) => void): () => void {
    this.#pushListeners.add(listener);
    return () => this.#pushListeners.delete(listener);
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }
}
