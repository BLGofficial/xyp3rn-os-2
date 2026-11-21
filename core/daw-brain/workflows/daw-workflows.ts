import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VaultEngine } from '../../vault-engine/vault-engine.ts';
import type { Os3WorkflowDefinition, Os3WorkflowEngine } from '../../workflow-engine/os3-workflow-engine.ts';

export type DawProductionWorkflowSpec = {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly domain: 'CORE' | 'TECH' | 'RECORDS';
  readonly description: string;
  readonly yaml: string;
};

/**
 * 10 canonical DAW Brain Production Workflows (`xyp3rn.workflow/v3`),
 * authored strictly against verified `DAW_AGENT_CATALOG` agents and `DAW_AGENT_TOOL_NAMES`
 * (read-only analysis/diagnostics by default, zero silent host mutations).
 */
export const DAW_PRODUCTION_WORKFLOWS: readonly DawProductionWorkflowSpec[] = [
  {
    id: 'wf-daw-session-audit',
    name: 'daw-session-audit',
    title: 'DAW Session Audit Workflow',
    domain: 'TECH',
    description: 'Comprehensive session audit: host compatibility, Session Intelligence structure/freshness, and context linking.',
    yaml: `id: wf-daw-session-audit
version: 1
name: daw-session-audit
description: Audits DAW host compatibility, live session structure, freshness, and linked Vault knowledge.
input:
  required: [sessionId]
  optional: [hostEdition, projectVaultPath]
steps:
  - id: host_audit
    agent: daw-compatibility-analyst
    tool: daw_host_compatibility_audit
    toolArgs:
      sessionId:
        $from: input.sessionId
  - id: session_intel
    agent: daw-session-analyst
    dependsOn: [host_audit]
    tool: daw_session_analyze
    toolArgs:
      sessionId:
        $from: input.sessionId
      edition:
        $from: input.hostEdition
      projectVaultPath:
        $from: input.projectVaultPath
  - id: context_link
    agent: daw-session-analyst
    dependsOn: [session_intel]
    tool: daw_context_retrieve
    toolArgs:
      query: "session structure arrangement drift checklist"
      sessionId:
        $from: input.sessionId
      projectVaultPath:
        $from: input.projectVaultPath
output:
  hostAudit:
    $from: steps.host_audit.output
  sessionReport:
    $from: steps.session_intel.output.report
  context:
    $from: steps.context_link.output.contextPackage
`,
  },
  {
    id: 'wf-daw-vocal-session-prep',
    name: 'daw-vocal-session-prep',
    title: 'DAW Vocal Session Preparation Workflow',
    domain: 'RECORDS',
    description: 'Prepares vocal session routing, tracks, Producer Edition chain compatibility, and vocal DNA context.',
    yaml: `id: wf-daw-vocal-session-prep
version: 1
name: daw-vocal-session-prep
description: Audits session vocal tracks, suggests Producer-safe vocal chain, and retrieves X3LIUS vocal DNA context.
input:
  required: [sessionId]
  optional: [hostKind, hostEdition, projectVaultPath]
steps:
  - id: session_check
    agent: daw-session-analyst
    tool: daw_session_analyze
    toolArgs:
      sessionId:
        $from: input.sessionId
      edition:
        $from: input.hostEdition
      projectVaultPath:
        $from: input.projectVaultPath
  - id: vocal_recipe
    agent: daw-vocal-engineer
    dependsOn: [session_check]
    tool: daw_plugin_brain_query
    toolArgs:
      operation: suggest_chain
      workflowKind: vocal_chain
      hostKind:
        $from: input.hostKind
      hostEdition:
        $from: input.hostEdition
  - id: vocal_context
    agent: daw-vocal-engineer
    dependsOn: [session_check]
    tool: daw_context_retrieve
    toolArgs:
      query: "X3LIUS baritone vocal chain tracking prep"
      sessionId:
        $from: input.sessionId
      projectVaultPath:
        $from: input.projectVaultPath
output:
  sessionReport:
    $from: steps.session_check.output.report
  suggestedVocalChain:
    $from: steps.vocal_recipe.output
  vocalContext:
    $from: steps.vocal_context.output.contextPackage
`,
  },
  {
    id: 'wf-daw-vocal-chain-analysis',
    name: 'daw-vocal-chain-analysis',
    title: 'DAW Vocal Chain Analysis Workflow',
    domain: 'RECORDS',
    description: 'Evaluates loaded vocal FX chains, Producer Edition compatibility, and optional bounced vocal audio metrics.',
    yaml: `id: wf-daw-vocal-chain-analysis
version: 1
name: daw-vocal-chain-analysis
description: Inspects live vocal FX chain role balance, edition restrictions, and optional WAV resonance checks.
input:
  required: [sessionId]
  optional: [hostKind, hostEdition, audioFilePath]
steps:
  - id: chain_eval
    agent: daw-vocal-engineer
    tool: daw_plugin_brain_query
    toolArgs:
      operation: analyze_actual_chains
      sessionId:
        $from: input.sessionId
      hostKind:
        $from: input.hostKind
      hostEdition:
        $from: input.hostEdition
  - id: session_roles
    agent: daw-session-analyst
    tool: daw_session_analyze
    toolArgs:
      sessionId:
        $from: input.sessionId
      edition:
        $from: input.hostEdition
  - id: audio_check
    agent: daw-vocal-engineer
    dependsOn: [chain_eval]
    when:
      $from: input.audioFilePath
      exists: true
    tool: daw_audio_brain_analyze
    toolArgs:
      filePath:
        $from: input.audioFilePath
      stage: mix
      sessionId:
        $from: input.sessionId
output:
  chainAnalysis:
    $from: steps.chain_eval.output
  sessionReport:
    $from: steps.session_roles.output.report
  audioReport:
    $from: steps.audio_check.output
`,
  },
  {
    id: 'wf-daw-mixing-prep',
    name: 'daw-mixing-prep',
    title: 'DAW Mixing Preparation Workflow',
    domain: 'RECORDS',
    description: 'Prepares mix session by verifying routing graph connectivity, gain staging inventory, and plugin compatibility.',
    yaml: `id: wf-daw-mixing-prep
version: 1
name: daw-mixing-prep
description: Verifies session inventory, signal routing completeness, and loaded FX compatibility prior to mixing.
input:
  required: [sessionId]
  optional: [hostKind, hostEdition]
steps:
  - id: routing_check
    agent: daw-routing-specialist
    tool: daw_session_analyze
    toolArgs:
      sessionId:
        $from: input.sessionId
      edition:
        $from: input.hostEdition
      queryHint: "routing bus send orphan check"
  - id: fx_audit
    agent: daw-mixing-engineer
    dependsOn: [routing_check]
    tool: daw_plugin_brain_query
    toolArgs:
      operation: analyze_actual_chains
      sessionId:
        $from: input.sessionId
      hostKind:
        $from: input.hostKind
      hostEdition:
        $from: input.hostEdition
output:
  sessionAndRouting:
    $from: steps.routing_check.output.report
  fxChains:
    $from: steps.fx_audit.output
`,
  },
  {
    id: 'wf-daw-mix-diagnostics',
    name: 'daw-mix-diagnostics',
    title: 'DAW Mix Diagnostics Workflow',
    domain: 'RECORDS',
    description: 'Diagnoses low-mid masking, headroom, stereo phase correlation, and loaded EQ/comp chains on a mix bounce.',
    yaml: `id: wf-daw-mix-diagnostics
version: 1
name: daw-mix-diagnostics
description: Runs mix-stage AudioBrain diagnostics paired with Session Intelligence and FX chain inspection.
input:
  required: [sessionId, audioFilePath]
  optional: [hostKind, hostEdition]
steps:
  - id: audio_diag
    agent: daw-dsp-engineer
    tool: daw_audio_brain_analyze
    toolArgs:
      filePath:
        $from: input.audioFilePath
      stage: mix
      sessionId:
        $from: input.sessionId
  - id: chain_check
    agent: daw-mixing-engineer
    dependsOn: [audio_diag]
    tool: daw_plugin_brain_query
    toolArgs:
      operation: analyze_actual_chains
      sessionId:
        $from: input.sessionId
      hostKind:
        $from: input.hostKind
      hostEdition:
        $from: input.hostEdition
  - id: critic_gate
    agent: daw-audio-quality-analyst
    dependsOn: [audio_diag, chain_check]
    tool: daw_session_analyze
    toolArgs:
      sessionId:
        $from: input.sessionId
      edition:
        $from: input.hostEdition
output:
  audioReport:
    $from: steps.audio_diag.output.report
  chainAnalysis:
    $from: steps.chain_check.output
  sessionReport:
    $from: steps.critic_gate.output.report
`,
  },
  {
    id: 'wf-daw-mastering-readiness',
    name: 'daw-mastering-readiness',
    title: 'DAW Mastering Readiness Workflow',
    domain: 'RECORDS',
    description: 'Evaluates master loudness (-9.5..-7.5 LUFS), true peak ceiling (-1.0 dBTP), Master FX chain order, and unsaved live changes.',
    yaml: `id: wf-daw-mastering-readiness
version: 1
name: daw-mastering-readiness
description: Audits master bounce acoustics, Master Bus limiter chain ordering, and unsaved live drift before mastering release.
input:
  required: [sessionId, audioFilePath]
  optional: [hostKind, hostEdition]
steps:
  - id: master_audio
    agent: daw-audio-quality-analyst
    tool: daw_audio_brain_analyze
    toolArgs:
      filePath:
        $from: input.audioFilePath
      stage: master
      sessionId:
        $from: input.sessionId
  - id: master_chain
    agent: daw-mastering-engineer
    dependsOn: [master_audio]
    tool: daw_plugin_brain_query
    toolArgs:
      operation: suggest_chain
      workflowKind: master_bus
      hostKind:
        $from: input.hostKind
      hostEdition:
        $from: input.hostEdition
  - id: drift_check
    agent: daw-compatibility-analyst
    dependsOn: [master_audio]
    tool: daw_session_analyze
    toolArgs:
      sessionId:
        $from: input.sessionId
      edition:
        $from: input.hostEdition
output:
  masterAudioReport:
    $from: steps.master_audio.output.report
  masterChainRecommendation:
    $from: steps.master_chain.output
  sessionConsistency:
    $from: steps.drift_check.output.report
`,
  },
  {
    id: 'wf-daw-plugin-chain-eval',
    name: 'daw-plugin-chain-eval',
    title: 'DAW Plugin Chain Evaluation Workflow',
    domain: 'TECH',
    description: 'Audits loaded plugin chains across all inserts/tracks against edition restrictions and signal ordering.',
    yaml: `id: wf-daw-plugin-chain-eval
version: 1
name: daw-plugin-chain-eval
description: Evaluates live loaded plugin chains, compatibility status, and host capabilities.
input:
  required: [sessionId]
  optional: [hostKind, hostEdition, pluginName]
steps:
  - id: host_caps
    agent: daw-plugin-specialist
    tool: daw_host_compatibility_audit
    toolArgs:
      sessionId:
        $from: input.sessionId
  - id: actual_chains
    agent: daw-plugin-specialist
    dependsOn: [host_caps]
    tool: daw_plugin_brain_query
    toolArgs:
      operation: analyze_actual_chains
      sessionId:
        $from: input.sessionId
      hostKind:
        $from: input.hostKind
      hostEdition:
        $from: input.hostEdition
  - id: target_compat
    agent: daw-plugin-specialist
    dependsOn: [host_caps]
    when:
      $from: input.pluginName
      exists: true
    tool: daw_plugin_brain_query
    toolArgs:
      operation: check_compat
      pluginA:
        $from: input.pluginName
      hostKind:
        $from: input.hostKind
      hostEdition:
        $from: input.hostEdition
output:
  hostCaps:
    $from: steps.host_caps.output
  chainEvaluation:
    $from: steps.actual_chains.output
  singlePluginCheck:
    $from: steps.target_compat.output
`,
  },
  {
    id: 'wf-daw-routing-audit',
    name: 'daw-routing-audit',
    title: 'DAW Routing Audit Workflow',
    domain: 'TECH',
    description: 'Builds and inspects the DAW routing graph for orphan inserts, disconnected sends, and cycles.',
    yaml: `id: wf-daw-routing-audit
version: 1
name: daw-routing-audit
description: Inspects live channel-to-mixer and bus send routing graphs cleanly.
input:
  required: [sessionId]
  optional: [hostEdition]
steps:
  - id: inspect_routing
    agent: daw-routing-specialist
    tool: daw_session_analyze
    toolArgs:
      sessionId:
        $from: input.sessionId
      edition:
        $from: input.hostEdition
      queryHint: "routing topology orphan disconnected bus"
  - id: routing_context
    agent: daw-routing-specialist
    dependsOn: [inspect_routing]
    tool: daw_context_retrieve
    toolArgs:
      query: "bus routing sidechain send architecture"
      sessionId:
        $from: input.sessionId
output:
  routingGraph:
    $from: steps.inspect_routing.output.report.routingGraph
  findings:
    $from: steps.inspect_routing.output.report.findings
  context:
    $from: steps.routing_context.output.contextPackage
`,
  },
  {
    id: 'wf-daw-audio-quality-report',
    name: 'daw-audio-quality-report',
    title: 'DAW Audio Quality Report Workflow',
    domain: 'TECH',
    description: 'Produces a full DSP + Critical Listening rubric report over an exported WAV bounce.',
    yaml: `id: wf-daw-audio-quality-report
version: 1
name: daw-audio-quality-report
description: Combines DSP measurements (LUFS, dBTP, spectrum, phase) with independent Critic verdict evaluation.
input:
  required: [audioFilePath]
  optional: [sessionId, stage]
steps:
  - id: dsp_extract
    agent: daw-dsp-engineer
    tool: daw_audio_brain_analyze
    toolArgs:
      filePath:
        $from: input.audioFilePath
      stage:
        $from: input.stage
      sessionId:
        $from: input.sessionId
  - id: critic_eval
    agent: daw-audio-quality-analyst
    dependsOn: [dsp_extract]
    tool: daw_audio_brain_analyze
    toolArgs:
      filePath:
        $from: input.audioFilePath
      stage:
        $from: input.stage
      sessionId:
        $from: input.sessionId
output:
  dspReport:
    $from: steps.dsp_extract.output.report
  criticReport:
    $from: steps.critic_eval.output.report
`,
  },
  {
    id: 'wf-daw-project-consistency-audit',
    name: 'daw-project-consistency-audit',
    title: 'DAW Project Consistency Audit Workflow',
    domain: 'CORE',
    description: 'Verifies live-vs-saved divergence, host version compatibility, naming discipline, and Vault consistency.',
    yaml: `id: wf-daw-project-consistency-audit
version: 1
name: daw-project-consistency-audit
description: Audits DAW host compatibility, live vs saved snapshot divergence, naming quality, and consistency checks.
input:
  required: [sessionId]
  optional: [hostEdition, projectVaultPath]
steps:
  - id: compat_gate
    agent: daw-compatibility-analyst
    tool: daw_host_compatibility_audit
    toolArgs:
      sessionId:
        $from: input.sessionId
  - id: consistency_check
    agent: daw-workflow-planner
    dependsOn: [compat_gate]
    tool: daw_session_analyze
    toolArgs:
      sessionId:
        $from: input.sessionId
      edition:
        $from: input.hostEdition
      projectVaultPath:
        $from: input.projectVaultPath
output:
  compatibility:
    $from: steps.compat_gate.output
  consistencyReport:
    $from: steps.consistency_check.output.report
`,
  },
];

const extractWorkflowStepIds = (yamlBody: string): readonly string[] =>
  [...yamlBody.matchAll(/^\s*-\s*id:\s*([^\s#]+)/gm)].map((m) => m[1]!).filter(Boolean);

export const renderDawWorkflowMarkdown = (spec: DawProductionWorkflowSpec): string => {
  const stepIds = extractWorkflowStepIds(spec.yaml);
  return [
    '---',
    'schema: xyp3rn.workflow/v3',
    `id: ${spec.id}`,
    `name: ${spec.name}`,
    `title: "${spec.title}"`,
    `domain: ${spec.domain}`,
    'sector: 05_WORKFLOWS',
    'status: active',
    'version: 1',
    'steps:',
    ...stepIds.map((s) => `  - ${s}`),
    'tags:',
    '  - xyp3rn',
    '  - os3',
    '  - daw-brain',
    '  - workflow',
    '---',
    '',
    `# ${spec.title}`,
    '',
    spec.description,
    '',
    '```yaml',
    spec.yaml.trimEnd(),
    '```',
    '',
  ].join('\n');
};

export const writeDawWorkflowDefinitionsToDir = (targetDir: string): readonly string[] => {
  mkdirSync(targetDir, { recursive: true });
  const written: string[] = [];
  for (const spec of DAW_PRODUCTION_WORKFLOWS) {
    const filePath = join(targetDir, `${spec.name}.md`);
    writeFileSync(filePath, renderDawWorkflowMarkdown(spec), 'utf8');
    written.push(filePath);
  }
  return written;
};

export const loadDawWorkflowsFromVault = async (
  vault: VaultEngine,
  workflowEngine: Os3WorkflowEngine,
  vaultSubdir = '05_WORKFLOWS/DAW',
): Promise<readonly Os3WorkflowDefinition[]> => {
  const loaded: Os3WorkflowDefinition[] = [];
  for (const spec of DAW_PRODUCTION_WORKFLOWS) {
    const wf = await workflowEngine.loadFromVault(vault, `${vaultSubdir}/${spec.name}.md`);
    loaded.push(wf);
  }
  return loaded;
};
