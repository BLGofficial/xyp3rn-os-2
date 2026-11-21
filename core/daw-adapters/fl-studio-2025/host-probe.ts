import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  FL_STUDIO_EXCLUDED_IN_PRODUCER,
  type FlBinaryInstallInfo,
  type FlHostEnvironment,
  type FlMidiPortInfo,
  type FlPluginInventoryEntry,
  type FlRunningProcessInfo,
} from './types.ts';

const execFileAsync = promisify(execFile);

export interface FlStudioHostProbe {
  probeHost(options?: {
    readonly inPortName?: string | undefined;
    readonly outPortName?: string | undefined;
  }): Promise<FlHostEnvironment>;
  discoverProjects(limit?: number): readonly string[];
  scanInstalledPlugins(): readonly FlPluginInventoryEntry[];
}

export type DefaultHostProbePaths = {
  readonly programFilesImageLine?: string | undefined;
  readonly userDocumentsFl?: string | undefined;
  readonly loopMidiBinaryPath?: string | undefined;
  readonly vst3Dirs?: readonly string[] | undefined;
  readonly vst2Dirs?: readonly string[] | undefined;
};

const COMPACT_WIN32_PROBE_PS = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Os3WinMmProbe {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MIDIINCAPS {
    public ushort wMid;
    public ushort wPid;
    public uint vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string szPname;
    public uint dwSupport;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MIDIOUTCAPS {
    public ushort wMid;
    public ushort wPid;
    public uint vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string szPname;
    public ushort wTechnology;
    public ushort wVoices;
    public ushort wNotes;
    public ushort wChannelMask;
    public uint dwSupport;
  }
  [DllImport("winmm.dll")] public static extern uint midiInGetNumDevs();
  [DllImport("winmm.dll", EntryPoint="midiInGetDevCapsW", CharSet = CharSet.Unicode)]
  public static extern uint midiInGetDevCaps(UIntPtr uDeviceID, ref MIDIINCAPS lpMidiInCaps, uint cbMidiInCaps);
  [DllImport("winmm.dll")] public static extern uint midiOutGetNumDevs();
  [DllImport("winmm.dll", EntryPoint="midiOutGetDevCapsW", CharSet = CharSet.Unicode)]
  public static extern uint midiOutGetDevCaps(UIntPtr uDeviceID, ref MIDIOUTCAPS lpMidiOutCaps, uint cbMidiOutCaps);
}
"@
$midiIn = @()
$inN = [Os3WinMmProbe]::midiInGetNumDevs()
for ($i = 0; $i -lt $inN; $i++) {
  $c = New-Object Os3WinMmProbe+MIDIINCAPS
  if ([Os3WinMmProbe]::midiInGetDevCaps([UIntPtr][uint32]$i, [ref]$c, [System.Runtime.InteropServices.Marshal]::SizeOf($c)) -eq 0) {
    $midiIn += @{ index = $i; direction = 'in'; name = $c.szPname }
  }
}
$midiOut = @()
$outN = [Os3WinMmProbe]::midiOutGetNumDevs()
for ($i = 0; $i -lt $outN; $i++) {
  $c = New-Object Os3WinMmProbe+MIDIOUTCAPS
  if ([Os3WinMmProbe]::midiOutGetDevCaps([UIntPtr][uint32]$i, [ref]$c, [System.Runtime.InteropServices.Marshal]::SizeOf($c)) -eq 0) {
    $midiOut += @{ index = $i; direction = 'out'; name = $c.szPname }
  }
}
$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^FL(64)?(\\s|\\(|$)' } | ForEach-Object {
  @{ pid = [int]$_.Id; processName = $_.ProcessName; executablePath = $_.Path }
})
$bins = @(
  'C:\\Program Files\\Image-Line\\FL Studio 2025\\FL64.exe',
  'C:\\Program Files\\Image-Line\\FL Studio 2026\\FL64.exe'
) | ForEach-Object {
  if (Test-Path $_) {
    $vi = (Get-Item $_).VersionInfo
    @{ path = $_; fileVersion = $vi.FileVersion; productVersion = $vi.ProductVersion }
  }
}
@{
  midiIn = $midiIn
  midiOut = $midiOut
  processes = $procs
  versions = $bins
} | ConvertTo-Json -Depth 4 -Compress
`;

type RawWin32Probe = {
  readonly midiIn?: readonly { readonly index: number; readonly name: string }[] | { readonly index: number; readonly name: string };
  readonly midiOut?: readonly { readonly index: number; readonly name: string }[] | { readonly index: number; readonly name: string };
  readonly processes?: readonly { readonly pid: number; readonly processName: string; readonly executablePath?: string | null }[];
  readonly versions?: readonly { readonly path: string; readonly fileVersion?: string | null; readonly productVersion?: string | null }[];
};

const toArray = <T>(v: T | readonly T[] | undefined): readonly T[] =>
  v === undefined ? [] : Array.isArray(v) ? (v as readonly T[]) : [v as T];

const classifyProducerPlugin = (name: string, format: FlPluginInventoryEntry['format']): FlPluginInventoryEntry['producerEditionStatus'] => {
  if (format === 'VST3' || format === 'VST2') return 'third_party_compatible';
  const lower = name.toLowerCase();
  for (const excluded of FL_STUDIO_EXCLUDED_IN_PRODUCER) {
    if (lower.includes(excluded)) return 'excluded_by_edition_unless_purchased';
  }
  return format === 'NATIVE' ? 'included_stock' : 'unknown';
};

/**
 * Non-destructive Windows 11 host probe for FL Studio binaries, running processes,
 * WinMM MIDI ports, `loopMIDI` prerequisites, `.flp` project files, and VST/native plugins.
 */
export class DefaultFlStudioHostProbe implements FlStudioHostProbe {
  readonly #ilRoot: string;
  readonly #docsFlRoot: string;
  readonly #loopMidiBinary: string;
  readonly #vst3Dirs: readonly string[];
  readonly #vst2Dirs: readonly string[];

  constructor(paths: DefaultHostProbePaths = {}) {
    const home = os.homedir();
    this.#ilRoot = paths.programFilesImageLine ?? 'C:\\Program Files\\Image-Line';
    this.#docsFlRoot = paths.userDocumentsFl ?? path.join(home, 'Documents', 'Image-Line', 'FL Studio');
    this.#loopMidiBinary = paths.loopMidiBinaryPath ?? 'C:\\Program Files (x86)\\Tobias Erichsen\\loopMIDI\\loopMIDI.exe';
    this.#vst3Dirs = paths.vst3Dirs ?? [
      'C:\\Program Files\\Common Files\\VST3',
      'C:\\Program Files (x86)\\Common Files\\VST3',
    ];
    this.#vst2Dirs = paths.vst2Dirs ?? [
      'C:\\Program Files\\VSTPlugins',
      'C:\\Program Files\\Common Files\\VST2',
    ];
  }

  async probeHost(options: {
    readonly inPortName?: string | undefined;
    readonly outPortName?: string | undefined;
  } = {}): Promise<FlHostEnvironment> {
    const inTarget = (options.inPortName ?? 'XYP3RN_IN').toLowerCase();
    const outTarget = (options.outPortName ?? 'XYP3RN_OUT').toLowerCase();
    const probedAt = new Date().toISOString();

    let win32: RawWin32Probe = {};
    if (process.platform === 'win32') {
      try {
        const { stdout } = await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', COMPACT_WIN32_PROBE_PS],
          { timeout: 6_000, windowsHide: true },
        );
        const trimmed = stdout.trim();
        if (trimmed) {
          win32 = JSON.parse(trimmed) as RawWin32Probe;
        }
      } catch {
        // Fall back to pure filesystem inspection without failing caller
      }
    }

    const versionByPath = new Map<string, { readonly fileVersion: string | null; readonly productVersion: string | null }>();
    for (const v of toArray(win32.versions)) {
      versionByPath.set(v.path.toLowerCase(), {
        fileVersion: v.fileVersion ?? null,
        productVersion: v.productVersion ?? null,
      });
    }

    const companionCheckDirs = ['Data', 'Plugins', 'Shared', 'System'];
    const installations: FlBinaryInstallInfo[] = ['FL Studio 2025', 'FL Studio 2026'].map((label) => {
      const versionDir = path.join(this.#ilRoot, label);
      const exePath = path.join(versionDir, 'FL64.exe');
      const exists = fs.existsSync(exePath);
      const missingCompanionDirs = companionCheckDirs.filter((d) => !fs.existsSync(path.join(versionDir, d)));
      const ver = versionByPath.get(exePath.toLowerCase());
      return {
        label,
        versionDir,
        executablePath: exePath,
        exists,
        fileVersion: ver?.fileVersion ?? null,
        productVersion: ver?.productVersion ?? null,
        hasCompanionDataDirs: exists && missingCompanionDirs.length === 0,
        missingCompanionDirs: exists ? missingCompanionDirs : companionCheckDirs,
      };
    });

    const runningProcesses: FlRunningProcessInfo[] = toArray(win32.processes).map((p) => ({
      pid: p.pid,
      processName: p.processName,
      executablePath: p.executablePath ?? null,
    }));

    const midiInPorts: FlMidiPortInfo[] = toArray(win32.midiIn).map((p) => ({
      index: p.index,
      direction: 'in' as const,
      name: p.name,
    }));
    const midiOutPorts: FlMidiPortInfo[] = toArray(win32.midiOut).map((p) => ({
      index: p.index,
      direction: 'out' as const,
      name: p.name,
    }));

    const loopMidiInstalled =
      fs.existsSync(this.#loopMidiBinary) ||
      midiInPorts.some((p) => p.name.toLowerCase().includes('xyp3rn') || p.name.toLowerCase().includes('loopmidi')) ||
      midiOutPorts.some((p) => p.name.toLowerCase().includes('xyp3rn') || p.name.toLowerCase().includes('loopmidi'));

    const configuredInPortFound = midiOutPorts.some((p) => p.name.toLowerCase().includes(inTarget));
    const configuredOutPortFound = midiInPorts.some((p) => p.name.toLowerCase().includes(outTarget));

    const controllerScriptPath = path.join(
      this.#docsFlRoot,
      'Settings',
      'Hardware',
      'XYP3RN_Brain',
      'device_XYP3RNBrain.py',
    );
    const controllerScriptInstalled = fs.existsSync(controllerScriptPath);
    const userProjectsRoot = path.join(this.#docsFlRoot, 'Projects');
    const pluginDatabaseRoot = path.join(this.#docsFlRoot, 'Presets', 'Plugin database');

    const missingPrerequisites: string[] = [];
    const warnings: string[] = [];

    if (!installations.some((i) => i.exists)) {
      missingPrerequisites.push(`FL Studio executable not found under "${this.#ilRoot}"`);
    }
    const fl2025 = installations.find((i) => i.label === 'FL Studio 2025');
    if (fl2025?.exists && !fl2025.hasCompanionDataDirs) {
      warnings.push(
        `FL Studio 2025 (${fl2025.fileVersion ?? 'unknown'}) lacks companion directories [${fl2025.missingCompanionDirs.join(', ')}] in "${fl2025.versionDir}"`,
      );
    }
    if (!loopMidiInstalled || !configuredInPortFound || !configuredOutPortFound) {
      missingPrerequisites.push(
        `Virtual MIDI loopback ports (${options.inPortName ?? 'XYP3RN_IN'} / ${options.outPortName ?? 'XYP3RN_OUT'}) not found on Windows WinMM — install loopMIDI and create loopback ports`,
      );
    }
    if (!controllerScriptInstalled) {
      missingPrerequisites.push(
        `Controller script not installed at "${controllerScriptPath}"`,
      );
    }
    if (runningProcesses.length === 0) {
      missingPrerequisites.push('No live FL64.exe process running');
    }

    return {
      probedAt,
      installations,
      runningProcesses,
      midiInPorts,
      midiOutPorts,
      loopMidiInstalled,
      configuredInPortFound,
      configuredOutPortFound,
      controllerScriptPath,
      controllerScriptInstalled,
      userProjectsRoot,
      pluginDatabaseRoot,
      missingPrerequisites,
      warnings,
    };
  }

  discoverProjects(limit = 32): readonly string[] {
    const projectsRoot = path.join(this.#docsFlRoot, 'Projects');
    if (!fs.existsSync(projectsRoot)) return [];
    const results: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 3 || results.length >= limit) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= limit) break;
        if (entry.name.toLowerCase() === 'backup') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.flp')) {
          results.push(full);
        }
      }
    };
    walk(projectsRoot, 0);
    return results;
  }

  scanInstalledPlugins(): readonly FlPluginInventoryEntry[] {
    const entries: FlPluginInventoryEntry[] = [];
    const seen = new Set<string>();

    const addEntry = (entry: FlPluginInventoryEntry): void => {
      const k = `${entry.format}:${entry.name.toLowerCase()}`;
      if (!seen.has(k)) {
        seen.add(k);
        entries.push(entry);
      }
    };

    for (const dir of this.#vst3Dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        for (const item of fs.readdirSync(dir)) {
          if (item.toLowerCase().endsWith('.vst3')) {
            const name = item.replace(/\.vst3$/i, '');
            addEntry({
              name,
              format: 'VST3',
              path: path.join(dir, item),
              source: 'vst_filesystem',
              producerEditionStatus: classifyProducerPlugin(name, 'VST3'),
            });
          }
        }
      } catch {
        // Skip unreadable directory safely
      }
    }

    for (const dir of this.#vst2Dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        for (const item of fs.readdirSync(dir)) {
          if (item.toLowerCase().endsWith('.dll')) {
            const name = item.replace(/\.dll$/i, '');
            addEntry({
              name,
              format: 'VST2',
              path: path.join(dir, item),
              source: 'vst_filesystem',
              producerEditionStatus: classifyProducerPlugin(name, 'VST2'),
            });
          }
        }
      } catch {
        // Skip unreadable directory safely
      }
    }

    const dbEffects = path.join(this.#docsFlRoot, 'Presets', 'Plugin database', 'Effects');
    const dbGens = path.join(this.#docsFlRoot, 'Presets', 'Plugin database', 'Generators');
    const scanDbDir = (root: string, depth: number): void => {
      if (depth > 3 || !fs.existsSync(root)) return;
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (item.name.toLowerCase() === 'installed') continue;
        const full = path.join(root, item.name);
        if (item.isDirectory()) {
          scanDbDir(full, depth + 1);
        } else if (item.isFile() && item.name.toLowerCase().endsWith('.fst')) {
          const name = item.name.replace(/\.fst$/i, '');
          addEntry({
            name,
            format: 'NATIVE',
            path: full,
            source: 'plugin_database',
            producerEditionStatus: classifyProducerPlugin(name, 'NATIVE'),
          });
        }
      }
    };
    scanDbDir(dbEffects, 0);
    scanDbDir(dbGens, 0);

    return entries;
  }
}
