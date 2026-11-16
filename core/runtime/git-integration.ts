import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GitStatusReport = {
  readonly isGitRepo: boolean;
  readonly workingDir: string;
  readonly branch: string | null;
  readonly headCommit: string | null;
  readonly modifiedFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly clean: boolean;
};

export type GitCheckpointResult = {
  readonly ok: boolean;
  readonly committed: boolean;
  readonly commitHash: string | null;
  readonly message: string;
};

const runGit = async (cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string } | null> => {
  try {
    const res = await execFileAsync('git', [...args], {
      cwd: resolve(cwd),
      timeout: 8_000,
      windowsHide: true,
    });
    return { stdout: res.stdout.trim(), stderr: res.stderr.trim() };
  } catch {
    return null;
  }
};

/**
 * Inspects local Git status for a repository or Obsidian Vault directory.
 * Never throws if the directory is not a Git repository.
 */
export const inspectGitRepository = async (dirPath: string): Promise<GitStatusReport> => {
  const workingDir = resolve(dirPath);
  const inside = await runGit(workingDir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.stdout !== 'true') {
    return {
      isGitRepo: false,
      workingDir,
      branch: null,
      headCommit: null,
      modifiedFiles: [],
      untrackedFiles: [],
      clean: true,
    };
  }

  const branchRes = await runGit(workingDir, [' rev-parse'.trim(), '--abbrev-ref', 'HEAD']);
  const headRes = await runGit(workingDir, ['rev-parse', 'HEAD']);
  const statusRes = await runGit(workingDir, ['status', '--porcelain']);

  const modifiedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  for (const line of (statusRes?.stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (code === '??') {
      untrackedFiles.push(file);
    } else {
      modifiedFiles.push(file);
    }
  }

  return {
    isGitRepo: true,
    workingDir,
    branch: branchRes?.stdout || null,
    headCommit: headRes?.stdout || null,
    modifiedFiles,
    untrackedFiles,
    clean: modifiedFiles.length === 0 && untrackedFiles.length === 0,
  };
};

/**
 * Initializes a local Git repository if needed and creates a local commit checkpoint.
 */
export const createGitCheckpoint = async (
  dirPath: string,
  message: string,
): Promise<GitCheckpointResult> => {
  const workingDir = resolve(dirPath);
  const statusBefore = await inspectGitRepository(workingDir);
  if (!statusBefore.isGitRepo) {
    const initRes = await runGit(workingDir, ['init']);
    if (!initRes) {
      return { ok: false, committed: false, commitHash: null, message: 'git init failed or git unavailable' };
    }
    await runGit(workingDir, ['config', 'user.name', 'XYP3RN OS 3.0 Runtime']);
    await runGit(workingDir, ['config', 'user.email', 'runtime@xyp3rn.local']);
  }

  await runGit(workingDir, ['add', '-A']);
  const statusAfterAdd = await inspectGitRepository(workingDir);
  if (statusAfterAdd.clean) {
    return {
      ok: true,
      committed: false,
      commitHash: statusAfterAdd.headCommit,
      message: 'Working tree clean; no new commit required',
    };
  }

  const commitRes = await runGit(workingDir, ['commit', '-m', message.trim() || 'OS3 Vault checkpoint']);
  const headRes = await runGit(workingDir, ['rev-parse', 'HEAD']);

  return {
    ok: commitRes !== null,
    committed: commitRes !== null,
    commitHash: headRes?.stdout ?? null,
    message: commitRes ? message : 'git commit failed',
  };
};
