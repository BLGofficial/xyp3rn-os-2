export type VoiceReportEvent = { status: string; level: number };
export function clampLevel(n: unknown): number;
export function rmsLevel(samples: ArrayLike<number>, gain?: number): number;
export function createVoiceReporter(opts: {
  post: (ev: VoiceReportEvent) => unknown; now?: () => number; levelGapMs?: number; enabled?: boolean;
}): { report(status: string, level?: number): void };
export function postVoiceStatus(fetchImpl: typeof fetch): (ev: VoiceReportEvent) => Promise<void>;
export function createLevelMeter(opts: {
  audio: HTMLAudioElement; AudioContextCtor?: (new () => any) | undefined; onLevel: (level: number) => void; intervalMs?: number; gain?: number;
}): Promise<{ stop(): void }>;
