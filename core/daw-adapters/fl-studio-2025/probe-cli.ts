import { FlStudio2025Adapter } from './fl-studio-adapter.ts';
import type { FlpParsedProject } from './types.ts';

/**
 * Non-destructive Phase 11 FL Studio 2025 diagnostic runner.
 * Probes host binaries, running FL processes, WinMM MIDI ports, installed plugins,
 * and saved `.flp` headers strictly read-only.
 */
async function main(): Promise<void> {
  const adapter = new FlStudio2025Adapter();
  const hostEnv = await adapter.probeHostEnvironment();
  const discovered = await adapter.discover();
  const projects = adapter.discoverProjects(10);
  const parsedProjects: FlpParsedProject[] = [];

  for (const projPath of projects) {
    try {
      parsedProjects.push(adapter.inspectSavedProject(projPath));
    } catch {
      // Skip unreadable or non-standard `.flp` safely while preserving log trace
    }
  }

  const plugins = adapter.discoverInstalledPlugins();
  const vst3Count = plugins.filter((p) => p.format === 'VST3').length;
  const vst2Count = plugins.filter((p) => p.format === 'VST2').length;
  const nativeCount = plugins.filter((p) => p.format === 'NATIVE').length;
  const excludedCount = plugins.filter((p) => p.producerEditionStatus === 'excluded_by_edition_unless_purchased').length;

  console.log(
    JSON.stringify(
      {
        adapterId: adapter.manifest.adapterId,
        hostEnv,
        discoveredInstances: discovered,
        projectsDiscovered: projects,
        projectsParsedSummary: parsedProjects.map((p) => ({
          projectName: p.projectName,
          flVersion: p.flVersion,
          flBuild: p.flBuild,
          ppq: p.ppq,
          tempoBpm: p.tempoBpm,
          timeSignature: p.timeSignature,
          channelNames: p.channelNames,
          mixerTrackNames: p.mixerTrackNames,
          pluginNames: p.pluginNames,
          sha256: p.sha256BeforeRead,
          hashUnchangedAfterRead: p.sha256BeforeRead === p.sha256AfterRead,
        })),
        pluginInventorySummary: {
          total: plugins.length,
          vst3Count,
          vst2Count,
          nativeCount,
          producerExcludedWarnings: excludedCount,
        },
        integrationLogs: adapter.getIntegrationLogs(),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
