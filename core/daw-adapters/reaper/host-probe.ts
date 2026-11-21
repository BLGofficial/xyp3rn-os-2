import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ReaperBinaryInstallInfo,
  ReaperHostEnvironment,
  ReaperPluginInventoryEntry,
  ReaperRunningProcessInfo,
} from './types.ts';

const execFileAsync = promisify(execFile);

export interface ReaperHostProbe {
  probeHost(): Promise<ReaperHostEnvironment>;
  discoverProjects(limit?: number): readonly string[];
  scanInstalledPlugins(): readonly ReaperPluginInventoryEntry[];
}

export type DefaultReaperProbePaths = {
  readonly installDirs?: readonly { readonly label: string; readonly dir: string }[] | undefined;
  readonly appDataDir?: string | undefined;
  readonly projectSearchDirs?: readonly string[] | undefined;
  readonly vst3Dirs?: readonly string[] | undefined;
  readonly vst2Dirs?: readonly string[] | undefined;
};

const REAPER_WIN32_PROBE_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = @(Get-Process -Name '*reaper*' -ErrorAction SilentlyContinue | ForEach-Object {
  @{ pid = [int]$_.Id; processName = $_.ProcessName; executablePath = $_.Path }
})
$bins = @(
  'C:\\Program Files\\REAPER (x64)\\reaper.exe',
  'C:\\Program Files (x86)\\REAPER\\reaper.exe'
) | ForEach-Object {
  if (Test-Path $_) {
    $vi = (Get-Item $_).VersionInfo
    @{ path = $_; fileVersion = $vi.FileVersion; productVersion = $vi.ProductVersion }
  }
}
@{ processes = $procs; versions = $bins } | ConvertTo-Json -Depth 4 -Compress
`;

type RawWinReaperProbe = {
  readonly processes?: readonly { readonly pid: number; readonly processName: string; readonly executablePath?: string | null }[]
    | { readonly pid: number; readonly processName: string; readonly executablePath?: string | null };
  readonly versions?: readonly { readonly path: string; readonly fileVersion?: string | null; readonly productVersion?: string | null }[]
    | { readonly path: string; readonly fileVersion?: string | null; readonly productVersion?: string | null };
};

const toArray = <T>(v: T | readonly T[] | undefined): readonly T[] =>
  v === undefined ? [] : Array.isArray(v) ? (v as readonly T[]) : [v as T];

const parseIniPorts = (iniContent: string): { webRemotePort: number | null; oscPort: number | null } => {
  let webRemotePort: number | null = null;
  let oscPort: number | null = null;
  const webMatch = /www(?:_server)?_port\s*=\s*(\d+)/i.exec(iniContent);
  if (webMatch?.[1]) webRemotePort = Number.parseInt(webMatch[1], 10);
  const oscMatch = /csurf_\d+=OSC.*?(\d{4,5})/i.exec(iniContent);
  if (oscMatch?.[1]) oscPort = Number.parseInt(oscMatch[1], 10);
  return { webRemotePort, oscPort };
};

/**
 * Non-destructive Windows 11 host probe for REAPER installations, running processes,
 * `%APPDATA%\REAPER` configuration, Lua ReaScript bridge presence, `.rpp` files, and VST inventory.
 */
export class DefaultReaperHostProbe implements ReaperHostProbe {
  readonly #installDirs: readonly { readonly label: string; readonly dir: string }[];
  readonly #appDataDir: string;
  readonly #projectSearchDirs: readonly string[];
  readonly #vst3Dirs: readonly string[];
  readonly #vst2Dirs: readonly string[];

  constructor(paths: DefaultReaperProbePaths = {}) {
    const home = os.homedir();
    this.#installDirs = paths.installDirs ?? [
      { label: 'REAPER (x64)', dir: 'C:\\Program Files\\REAPER (x64)' },
      { label: 'REAPER (x86)', dir: 'C:\\Program Files (x86)\\REAPER' },
    ];
    this.#appDataDir =
      paths.appDataDir ?? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'REAPER');
    this.#projectSearchDirs = paths.projectSearchDirs ?? [
      path.join(home, 'Documents', 'REAPER Media'),
      path.join(home, 'Documents'),
    ];
    this.#vst3Dirs = paths.vst3Dirs ?? [
      'C:\\Program Files\\Common Files\\VST3',
      'C:\\Program Files (x86)\\Common Files\\VST3',
    ];
    this.#vst2Dirs = paths.vst2Dirs ?? [
      'C:\\Program Files\\VSTPlugins',
      'C:\\Program Files\\Common Files\\VST2',
    ];
  }

  async probeHost(): Promise<ReaperHostEnvironment> {
    const probedAt = new Date().toISOString();
    let win: RawWinReaperProbe = {};
    if (process.platform === 'win32') {
      try {
        const { stdout } = await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', REAPER_WIN32_PROBE_PS],
          { timeout: 6_000 },
        );
        if (stdout.trim()) win = JSON.parse(stdout) as RawWinReaperProbe;
      } catch {
        // Keep empty telemetry cleanly if PowerShell probe fails
      }
    }

    const versionByPath = new Map<string, { readonly fileVersion?: string | null; readonly productVersion?: string | null }>();
    for (const v of toArray(win.versions)) {
      if (v && typeof v.path === 'string') {
        versionByPath.set(v.path.toLowerCase(), v);
      }
    }

    const missingPrerequisites: string[] = [];
    const warnings: string[] = [];

    const installations: ReaperBinaryInstallInfo[] = this.#installDirs.map((cand) => {
      const exePath = path.join(cand.dir, 'reaper.exe');
      const exists = fs.existsSync(exePath);
      const dirExists = fs.existsSync(cand.dir);
      const leftoverAssetFilesCount =
        !exists && dirExists ? fs.readdirSync(cand.dir).filter((f) => f.endsWith('.png')).length : 0;
      const vi = versionByPath.get(exePath.toLowerCase());
      if (!exists && leftoverAssetFilesCount > 0) {
        warnings.push(
          `Found ${leftoverAssetFilesCount} UI icon PNGs in "${cand.dir}" but reaper.exe is absent (incomplete/uninstalled REAPER directory).`,
        );
      }
      return {
        label: cand.label,
        installDir: cand.dir,
        executablePath: exePath,
        exists,
        fileVersion: vi?.fileVersion ?? null,
        productVersion: vi?.productVersion ?? null,
        leftoverAssetFilesCount,
      };
    });

    if (!installations.some((i) => i.exists)) {
      missingPrerequisites.push('reaper.exe is not installed under C:\\Program Files\\REAPER (x64) or Program Files (x86)');
    }

    const runningProcesses: ReaperRunningProcessInfo[] = toArray(win.processes).map((p) => ({
      pid: p.pid,
      processName: p.processName,
      executablePath: p.executablePath ?? null,
    }));

    const appDataExists = fs.existsSync(this.#appDataDir);
    const reaperIniPath = path.join(this.#appDataDir, 'reaper.ini');
    const reaperIniExists = fs.existsSync(reaperIniPath);
    const luaBridgeScriptPath = path.join(this.#appDataDir, 'Scripts', 'xyp3rn_reaper_bridge.lua');
    const luaBridgeInstalled = fs.existsSync(luaBridgeScriptPath);

    let webRemoteConfiguredPort: number | null = null;
    let oscConfiguredPort: number | null = null;
    if (reaperIniExists) {
      try {
        const ini = fs.readFileSync(reaperIniPath, 'utf8');
        const ports = parseIniPorts(ini);
        webRemoteConfiguredPort = ports.webRemotePort;
        oscConfiguredPort = ports.oscPort;
      } catch {
        // Skip unreadable ini cleanly
      }
    } else {
      missingPrerequisites.push(`REAPER profile config directory missing (${this.#appDataDir})`);
    }

    if (!luaBridgeInstalled) {
      missingPrerequisites.push(`ReaScript bridge not installed at "${luaBridgeScriptPath}"`);
    }
    if (runningProcesses.length === 0) {
      missingPrerequisites.push('No running reaper.exe host process detected');
    }

    return {
      probedAt,
      installations,
      runningProcesses,
      appDataDir: this.#appDataDir,
      appDataExists,
      reaperIniPath,
      reaperIniExists,
      luaBridgeScriptPath,
      luaBridgeInstalled,
      webRemoteConfiguredPort,
      oscConfiguredPort,
      discoveredProjects: this.discoverProjects(20),
      missingPrerequisites,
      warnings,
    };
  }

  discoverProjects(limit = 20): readonly string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (out.length >= limit || depth > 2 || !fs.existsSync(dir)) return;
      try {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (out.length >= limit) break;
          const full = path.join(dir, ent.name);
          if (ent.isFile() && ent.name.toLowerCase().endsWith('.rpp')) {
            out.push(full);
          } else if (ent.isDirectory()) {
            walk(full, depth + 1);
          }
        }
      } catch {
        // Skip restricted directories
      }
    };
    for (const root of this.#projectSearchDirs) walk(root, 0);
    return out;
  }

  scanInstalledPlugins(): readonly ReaperPluginInventoryEntry[] {
    const out: ReaperPluginInventoryEntry[] = [];
    for (const dir of this.#vst3Dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (name.toLowerCase().endsWith('.vst3')) {
          out.push({
            name: name.replace(/\.vst3$/i, ''),
            format: 'VST3',
            path: path.join(dir, name),
            source: 'vst_filesystem',
          });
        }
      }
    }
    for (const dir of this.#vst2Dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (name.toLowerCase().endsWith('.dll')) {
          out.push({
            name: name.replace(/\.dll$/i, ''),
            format: 'VST2',
            path: path.join(dir, name),
            source: 'vst_filesystem',
          });
        }
      }
    }
    return out;
  }
}
