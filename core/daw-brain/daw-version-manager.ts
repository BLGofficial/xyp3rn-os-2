import { DawBrainError } from './types.ts';

export type VersionCompatibilityVerdict = {
  readonly status: 'compatible' | 'degraded_read_only' | 'incompatible';
  readonly hostVersion: string;
  readonly minSupportedVersion: string;
  readonly maxTestedVersion: string;
  readonly allowMutations: boolean;
  readonly reason: string;
};

export type VersionTuple = readonly [number, number, number];

export const parseSemverTuple = (rawVersion: string): VersionTuple | null => {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(rawVersion.trim());
  if (!m?.[1]) return null;
  return [
    Number.parseInt(m[1], 10),
    Number.parseInt(m[2] ?? '0', 10),
    Number.parseInt(m[3] ?? '0', 10),
  ];
};

export const compareVersions = (a: VersionTuple, b: VersionTuple): number => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! > b[i]!) return 1;
    if (a[i]! < b[i]!) return -1;
  }
  return 0;
};

/**
 * Validates DAW binary/API version compatibility against an adapter's declared bounds.
 * Untested newer host versions degrade safely to read-only observation; below-minimum
 * versions are blocked as `incompatible`.
 */
export class DawVersionManager {
  evaluateCompatibility(options: {
    readonly hostVersion: string;
    readonly minSupportedVersion: string;
    readonly maxTestedVersion: string;
    readonly minApiVersion?: number | undefined;
    readonly actualApiVersion?: number | undefined;
  }): VersionCompatibilityVerdict {
    const actual = parseSemverTuple(options.hostVersion);
    const minVer = parseSemverTuple(options.minSupportedVersion);
    const maxVer = parseSemverTuple(options.maxTestedVersion);

    if (!actual || !minVer || !maxVer) {
      return {
        status: 'degraded_read_only',
        hostVersion: options.hostVersion,
        minSupportedVersion: options.minSupportedVersion,
        maxTestedVersion: options.maxTestedVersion,
        allowMutations: false,
        reason: `Unparseable host/adapter version "${options.hostVersion}"; restricting session to read-only observe mode`,
      };
    }

    if (
      options.minApiVersion !== undefined &&
      options.actualApiVersion !== undefined &&
      options.actualApiVersion < options.minApiVersion
    ) {
      return {
        status: 'incompatible',
        hostVersion: options.hostVersion,
        minSupportedVersion: options.minSupportedVersion,
        maxTestedVersion: options.maxTestedVersion,
        allowMutations: false,
        reason: `Host scripting API version (${options.actualApiVersion}) below required minimum (${options.minApiVersion})`,
      };
    }

    if (compareVersions(actual, minVer) < 0) {
      return {
        status: 'incompatible',
        hostVersion: options.hostVersion,
        minSupportedVersion: options.minSupportedVersion,
        maxTestedVersion: options.maxTestedVersion,
        allowMutations: false,
        reason: `Host version "${options.hostVersion}" is older than minimum supported "${options.minSupportedVersion}"`,
      };
    }

    if (compareVersions(actual, maxVer) > 0) {
      return {
        status: 'degraded_read_only',
        hostVersion: options.hostVersion,
        minSupportedVersion: options.minSupportedVersion,
        maxTestedVersion: options.maxTestedVersion,
        allowMutations: false,
        reason: `Host version "${options.hostVersion}" exceeds max tested "${options.maxTestedVersion}"; mutating leases disabled (observe-only)`,
      };
    }

    return {
      status: 'compatible',
      hostVersion: options.hostVersion,
      minSupportedVersion: options.minSupportedVersion,
      maxTestedVersion: options.maxTestedVersion,
      allowMutations: true,
      reason: `Host version "${options.hostVersion}" verified within [${options.minSupportedVersion} .. ${options.maxTestedVersion}]`,
    };
  }

  assertConnectable(verdict: VersionCompatibilityVerdict): void {
    if (verdict.status === 'incompatible') {
      throw new DawBrainError('DAW_UNSUPPORTED_HOST_VERSION', verdict.reason, { verdict });
    }
  }
}
