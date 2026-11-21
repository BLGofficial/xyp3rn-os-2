import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Os3ContextEngine } from '../../core/context-engine/os3-context-engine.ts';
import {
  createLocalDeterministicEmbedder,
  Os3SemanticIndex,
} from '../../core/context-engine/semantic-index.ts';
import { Os3StructuralIndex } from '../../core/context-engine/structural-index.ts';
import { Os3KnowledgeEngine } from '../../core/knowledge-engine/index.ts';
import type { KnowledgeEntityKind } from '../../core/knowledge-engine/types.ts';
import { openRuntimeDb, type SqliteRuntimeDb } from '../../core/sqlite/client.ts';
import type { VaultEngineConfigInput } from '../../core/vault-engine/vault-config.ts';
import { VaultEngine } from '../../core/vault-engine/vault-engine.ts';

describe('Phase 6 — Knowledge Engine, 12-Domain Knowledge Graph, Context Retrieval & DAW Context', () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteRuntimeDb[] = [];

  afterEach(async () => {
    for (const db of openDbs.splice(0)) {
      db.close();
    }
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const createEnv = async (configInput: Omit<VaultEngineConfigInput, 'vaultRoot'> = {}) => {
    const dir = await mkdtemp(join(tmpdir(), 'xyp3rn-os3-p6-ke-'));
    tempDirs.push(dir);
    const vaultRoot = join(dir, 'vault');
    await mkdir(vaultRoot, { recursive: true });

    const db = openRuntimeDb(join(dir, 'runtime.sqlite'));
    openDbs.push(db);
    const vault = new VaultEngine({ ...configInput, vaultRoot, db });
    const structural = new Os3StructuralIndex({ vault, db });
    const semantic = new Os3SemanticIndex({
      vault,
      db,
      provider: createLocalDeterministicEmbedder(96),
    });
    const knowledge = new Os3KnowledgeEngine({ vault, db, structural, semantic });
    const context = new Os3ContextEngine({ vault, db, structural, semantic });

    const writeRawNote = async (vaultPath: string, content: string): Promise<void> => {
      const absPath = join(vaultRoot, vaultPath);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
    };

    const approveAndPromote = async (params: {
      readonly itemId: string;
      readonly targetVaultPath: string;
      readonly title: string;
      readonly body: string;
      readonly domain: string;
      readonly entityId: string;
      readonly schema: string;
      readonly sourceRefs?: readonly string[] | undefined;
      readonly evidenceIds?: readonly string[] | undefined;
      readonly tags?: readonly string[] | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
      readonly approver?: string | undefined;
    }) => {
      const approval = db.queueApproval({
        itemType: 'vault_promotion',
        itemId: params.itemId,
        request: { targetVaultPath: params.targetVaultPath },
        proposer: 'x3lius-curator',
      });
      db.decideApproval({
        approvalId: approval.id,
        decision: 'approved',
        approver: params.approver ?? 'blago-operator',
        reason: 'Verified against canonical evidence',
      });
      return knowledge.promoteCandidate({
        approvalId: approval.id,
        targetVaultPath: params.targetVaultPath,
        title: params.title,
        body: params.body,
        domain: params.domain,
        entityId: params.entityId,
        schema: params.schema,
        sourceRefs: params.sourceRefs ?? ['src-mastering-guide'],
        evidenceIds: params.evidenceIds,
        tags: params.tags,
        metadata: {
          version: 1,
          created_at: '2026-09-01T12:00:00Z',
          updated_at: '2026-09-01T12:00:00Z',
          ...(params.metadata ?? {}),
        },
        provenance: `test://approved/${params.itemId}`,
        reason: 'Phase 6 canonical fixture promotion',
      });
    };

    return { dir, vaultRoot, db, vault, structural, semantic, knowledge, context, writeRawNote, approveAndPromote };
  };

  it('1. builds a rebuildable Knowledge Graph covering all 12 OS3 + DAW entity kinds, typed relations & unresolved refs', async () => {
    const { knowledge, writeRawNote, approveAndPromote } = await createEnv();

    // 1. knowledge (promoted canonical source)
    await writeRawNote(
      '02_KNOWLEDGE/SOURCES/src-mastering-guide.md',
      `---
id: src-mastering-guide
schema: xyp3rn.source/v3
type: source
title: "LUFS Calibration Standard"
domain: KNOWLEDGE
sector: 02_KNOWLEDGE
status: active
version: 1
origin: "studio://standards/itu-bs1770"
created_at: "2026-08-01T10:00:00Z"
updated_at: "2026-08-01T10:00:00Z"
tags: [mastering, lufs]
---

Reference text for ITU-R BS.1770 true-peak and integrated loudness targets.
`,
    );

    // 2. research (finding backed by evidence)
    await writeRawNote(
      '03_RESEARCH_INTELLIGENCE/FINDINGS/ev-lufs-headroom.md',
      `---
id: ev-lufs-headroom
schema: xyp3rn.evidence/v3
type: evidence
title: "Streaming True-Peak Ceiling Observation"
domain: RESEARCH_INTELLIGENCE
sector: 03_RESEARCH_INTELLIGENCE
status: active
version: 1
source_ref: "src-mastering-guide"
verbatim_quote: "Keep streaming masters <= -1.0 dBTP to avoid AAC codec clipping."
confidence: 0.94
created_at: "2026-08-02T10:00:00Z"
updated_at: "2026-08-02T10:00:00Z"
tags: [evidence, clipping]
---

Supporting empirical measurement from encode trials.
`,
    );

    await writeRawNote(
      '03_RESEARCH_INTELLIGENCE/FINDINGS/finding-headroom.md',
      `---
id: finding-headroom
schema: xyp3rn.finding/v3
type: finding
title: "True-Peak Margin Prevents Codec Overs"
domain: RESEARCH_INTELLIGENCE
sector: 03_RESEARCH_INTELLIGENCE
status: approved
version: 1
confidence: 0.92
evidence_ids:
  - ev-lufs-headroom
created_at: "2026-08-03T10:00:00Z"
updated_at: "2026-08-03T10:00:00Z"
tags: [finding, mastering]
---

Confirmed by [[ev-lufs-headroom]].
`,
    );

    // 3. agent + 4. tool + 5. workflow
    await writeRawNote(
      '01_CORE/TOOLS/tool-truepeak-lim.md',
      `---
id: tool-truepeak-lim
schema: xyp3rn.tool/v3
type: tool
name: daw-limiter-inspect
title: "DAW Limiter Ceiling Inspector"
domain: TECH
sector: 01_CORE
status: active
version: 1
capability: "daw.inspect.limiter"
allowed_classes: [tech]
tags: [daw, tool]
---

Inspects true-peak limiter headroom read-only.
`,
    );

    await writeRawNote(
      '04_AGENTS/agent-mix-engineer.md',
      `---
id: agent-mix-engineer
schema: xyp3rn.agent/v3
type: agent
name: mix-engineer-agent
title: "Mix Engineer Agent"
class: tech
domain: TECH
sector: 04_AGENTS
status: active
version: 1
model: local-reasoning
capabilities: [daw.observe, audio.analyze]
tools:
  - tool-truepeak-lim
plugins:
  - plug-pro-l2
tags: [agent, mix]
---

Uses [[tool-truepeak-lim]] and evaluates [[plug-pro-l2]].
`,
    );

    await writeRawNote(
      '05_WORKFLOWS/wf-mastering-pass.md',
      `---
id: wf-mastering-pass
schema: xyp3rn.workflow/v3
type: workflow
name: mastering-pass
title: "Safe Mastering Inspection Workflow"
domain: TECH
sector: 05_WORKFLOWS
status: active
version: 1
target_daw: adapter-fl-studio-2025
steps:
  - id: inspect
    agent: agent-mix-engineer
tags: [workflow, mastering]
---

Executes non-destructive mastering review with [[nonexistent-unresolved-note]].
`,
    );

    // 6. song + 7. release
    await writeRawNote(
      '09_X3LIUS_MUSIC/SONGS/song-midnight-horizon.md',
      `---
id: song-midnight-horizon
schema: xyp3rn.song/v3
type: song
title: "Midnight Horizon"
artist: X3LIUS
language: en
isrc: US-XYP-26-00001
domain: RECORDS
sector: 09_X3LIUS_MUSIC
status: active
version: 1
release_id: rel-nocturne-ep
tags: [song, drill]
---

Lead single targeting [[rel-nocturne-ep]].
`,
    );

    await writeRawNote(
      '06_RECORDS/RELEASES/rel-nocturne-ep.md',
      `---
id: rel-nocturne-ep
schema: xyp3rn.release/v3
type: release
title: "Nocturne EP"
artist: X3LIUS
kind: EP
domain: RECORDS
sector: 06_RECORDS
status: released
version: 1
tracks:
  - song-midnight-horizon
tags: [release, x3lius]
---

Collection anchored by [[song-midnight-horizon]].
`,
    );

    // 8. production_session + 9. daw_adapter + 10. plugin + 11. audio_analysis + 12. dsp_concept
    await approveAndPromote({
      itemId: 'adapter-fl-studio-2025',
      targetVaultPath: '10_DAW_BRAIN/ADAPTERS/fl-studio-2025.md',
      title: 'FL Studio 2025 Producer Edition Adapter',
      body: 'Canonical adapter contract for FL Studio 2025 Python MIDI Controller Scripting.',
      domain: 'TECH',
      entityId: 'adapter-fl-studio-2025',
      schema: 'xyp3rn.daw-adapter/v3',
      tags: ['daw', 'fl-studio'],
      metadata: {
        type: 'daw_adapter',
        adapter_id: 'flstudio-2025-midi',
        host_name: 'FL Studio 2025',
        transport_protocol: 'midi_controller_python',
        supported_capabilities: ['transport.read', 'mixer.inspect'],
      },
    });

    await writeRawNote(
      '10_DAW_BRAIN/PLUGINS/plug-pro-l2.md',
      `---
id: plug-pro-l2
schema: xyp3rn.daw-plugin/v3
type: plugin
title: "FabFilter Pro-L 2"
plugin_format: VST3
vendor: FabFilter
category: limiter
edition_requirement: Producer Edition
domain: TECH
sector: 10_DAW_BRAIN
status: canonical
version: 1
dsp_concepts:
  - dsp-true-peak-limiting
tags: [plugin, limiter, vst3]
---

True-peak transparent mastering limiter referencing [[dsp-true-peak-limiting]].
`,
    );

    await writeRawNote(
      '10_DAW_BRAIN/DSP/dsp-true-peak-limiting.md',
      `---
id: dsp-true-peak-limiting
schema: xyp3rn.dsp-concept/v3
type: dsp_concept
title: "Oversampled True-Peak Limiting"
domain: TECH
sector: 10_DAW_BRAIN
category: dynamics
acoustic_principle: "Inter-sample peak reconstruction via 4x oversampling prevents DAC clipping."
status: canonical
version: 1
source_ref: "src-mastering-guide"
tags: [dsp, limiter, mastering]
---

Grounded in [[src-mastering-guide]].
`,
    );

    await writeRawNote(
      '10_DAW_BRAIN/SESSIONS/sess-midnight-mix-v2.md',
      `---
id: sess-midnight-mix-v2
schema: xyp3rn.production-session/v3
type: production_session
title: "Midnight Horizon Mix Session v2"
daw_host: "FL Studio 2025"
daw_edition: "Producer Edition"
project_path: "D:/Projects/MidnightHorizon_v2.flp"
state_tier: savedProject
domain: RECORDS
sector: 10_DAW_BRAIN
status: active
version: 2
song_id: song-midnight-horizon
adapter_id: adapter-fl-studio-2025
plugins:
  - plug-pro-l2
tags: [session, fl-studio]
---

Saved project session linked to [[song-midnight-horizon]] and [[plug-pro-l2]].
`,
    );

    await writeRawNote(
      '10_DAW_BRAIN/AUDIO_ANALYSES/ana-midnight-pass1.md',
      `---
id: ana-midnight-pass1
schema: xyp3rn.audio-analysis/v3
type: audio_analysis
title: "Midnight Horizon Bounce Pass 1 Loudness"
analysis_schema: "trace.loudness/v1"
source_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
integrated_lufs: -9.4
true_peak_dbtp: -0.9
session_id: sess-midnight-mix-v2
domain: TECH
sector: 10_DAW_BRAIN
status: active
version: 1
tags: [audio-analysis, trace]
---

Analyzes bounce from [[sess-midnight-mix-v2]].
`,
    );

    const rebuilt = await knowledge.rebuildIndexes({ rebuildSemantic: true });
    expect(rebuilt.structuralTotalIndexed).toBeGreaterThanOrEqual(13);
    expect(rebuilt.semanticIndexedCount).toBeGreaterThanOrEqual(13);

    const graph = knowledge.getGraph();
    const summary = graph.getSummary();

    const expectedKinds: readonly KnowledgeEntityKind[] = [
      'knowledge',
      'research',
      'agent',
      'tool',
      'workflow',
      'song',
      'release',
      'production_session',
      'daw_adapter',
      'plugin',
      'audio_analysis',
      'dsp_concept',
    ];
    for (const kind of expectedKinds) {
      expect(summary.byKind[kind], `Expected >=1 graph node for kind "${kind}"`).toBeGreaterThanOrEqual(1);
    }

    expect(summary.unresolvedEdgeCount).toBeGreaterThanOrEqual(1);
    expect(summary.byRelation.runs_agent).toBeGreaterThanOrEqual(1);
    expect(summary.byRelation.uses_tool).toBeGreaterThanOrEqual(1);
    expect(summary.byRelation.uses_plugin).toBeGreaterThanOrEqual(1);
    expect(summary.byRelation.references_dsp).toBeGreaterThanOrEqual(1);
    expect(summary.byRelation.analyzes_session).toBeGreaterThanOrEqual(1);
    expect(summary.byRelation.part_of_release).toBeGreaterThanOrEqual(1);
    expect(summary.byRelation.backed_by_evidence).toBeGreaterThanOrEqual(1);
    expect(summary.byRelation.cites_source).toBeGreaterThanOrEqual(1);

    // Check extracted relationships & unresolved tracking
    const wfRels = knowledge.extractRelationships('wf-mastering-pass');
    expect(wfRels.node?.kind).toBe('workflow');
    expect(wfRels.outgoing.some((e) => e.relation === 'runs_agent' && e.targetId === 'agent-mix-engineer')).toBe(true);
    expect(wfRels.unresolved.some((e) => e.targetId === 'unresolved:nonexistent-unresolved-note')).toBe(true);

    // Check neighborhood traversal
    const hood = graph.getNeighborhood('sess-midnight-mix-v2', { depth: 2, direction: 'both' });
    expect(hood.nodes.some((n) => n.id === 'ana-midnight-pass1')).toBe(true);
    expect(hood.nodes.some((n) => n.id === 'dsp-true-peak-limiting')).toBe(true);

    // Check backlinks
    const songBacklinks = knowledge.getBacklinks('09_X3LIUS_MUSIC/SONGS/song-midnight-horizon.md');
    expect(songBacklinks).toContain('06_RECORDS/RELEASES/rel-nocturne-ep.md');
    expect(songBacklinks).toContain('10_DAW_BRAIN/SESSIONS/sess-midnight-mix-v2.md');
  });

  it('2. resolves entities cleanly, detects ID/SHA/title duplicates, traces provenance & enforces lifecycle/Promotion Gate', async () => {
    const { knowledge, vault, approveAndPromote, writeRawNote } = await createEnv();

    await writeRawNote(
      '02_KNOWLEDGE/SOURCES/ev-eq-clean.md',
      `---
id: ev-eq-clean
schema: xyp3rn.evidence/v3
type: evidence
title: "Subtractive High-Pass Clearance"
domain: RESEARCH_INTELLIGENCE
sector: 03_RESEARCH_INTELLIGENCE
status: active
version: 1
source_ref: "Studio Handbook p.42"
verbatim_quote: "High-pass non-bass elements at 90Hz to clear sub energy."
confidence: 0.91
created_at: "2026-09-01T09:00:00Z"
updated_at: "2026-09-01T09:00:00Z"
---

Evidence body.
`,
    );

    // Direct write to canonical must fail outside Promotion Gate
    await expect(
      vault.writeNote({
        vaultPath: '02_KNOWLEDGE/CANONICAL/rule-sub-clearance.md',
        content: `---\nid: rule-sub-clearance\ntitle: "Sub Clearance"\ndomain: KNOWLEDGE\nstatus: canonical\n---\nBlocked direct write.\n`,
        actor: 'agent:researcher',
        reason: 'Attempt bypassing promotion gate',
      }),
    ).rejects.toThrow(/canonical sector|promote\(\)/i);

    // Promote properly via Promotion Gate
    await approveAndPromote({
      itemId: 'cand-sub-clearance',
      targetVaultPath: '02_KNOWLEDGE/CANONICAL/rule-sub-clearance.md',
      title: 'Sub-Bass High-Pass Clearance Rule',
      body: 'Apply 90 Hz high-pass filter on vocal and synth busses before bus compression.',
      domain: 'KNOWLEDGE',
      entityId: 'rule-sub-clearance',
      schema: 'xyp3rn.knowledge/v3',
      sourceRefs: ['Studio Handbook p.42'],
      evidenceIds: ['ev-eq-clean'],
      tags: ['canonical', 'eq', 'preference'],
      metadata: {
        aliases: ['hpf-90hz-rule'],
      },
    });

    // Duplicate testing: duplicate ID, exact content SHA duplicate, and title collision
    const identicalPayload = `---
id: dup-shared-id
schema: xyp3rn.knowledge/v3
type: knowledge
title: "Duplicate Vocal Chain Note"
domain: KNOWLEDGE
sector: 11_INBOX
status: draft
version: 1
---

Identical markdown body for SHA-256 deduplication test.
`;
    await writeRawNote('11_INBOX/dup-a.md', identicalPayload);
    await writeRawNote('11_INBOX/dup-b.md', identicalPayload);
    await writeRawNote(
      '11_INBOX/title-collision.md',
      `---
id: unique-title-collision-id
schema: xyp3rn.knowledge/v3
type: knowledge
title: "Duplicate Vocal Chain Note"
domain: KNOWLEDGE
sector: 11_INBOX
status: draft
version: 1
---

Different body sharing identical title and docType.
`,
    );

    await knowledge.rebuildIndexes({ rebuildSemantic: false });

    // Entity resolution by ID, path, alias, and ambiguous title
    expect(knowledge.resolveEntity('rule-sub-clearance').matchedBy).toBe('entity_id');
    expect(knowledge.resolveEntity('02_KNOWLEDGE/CANONICAL/rule-sub-clearance.md').matchedBy).toBe('vault_path');
    const byAlias = knowledge.resolveEntity('hpf-90hz-rule');
    expect(byAlias.matchedBy).toBe('alias');
    expect(byAlias.resolved?.id).toBe('rule-sub-clearance');

    const ambigTitle = knowledge.resolveEntity('Duplicate Vocal Chain Note');
    expect(ambigTitle.matchedBy).toBe('title');
    expect(ambigTitle.ambiguousMatches.length).toBe(3);

    // Duplicate detection report
    const dupReport = knowledge.detectDuplicates();
    expect(dupReport.duplicateEntityIds.some((d) => d.entityId === 'dup-shared-id' && d.paths.length === 2)).toBe(true);
    expect(dupReport.exactContentDuplicates.some((d) => d.paths.length === 2)).toBe(true);
    expect(
      dupReport.titleCollisions.some(
        (c) => c.normalizedTitle === 'duplicate vocal chain note' && c.paths.length === 3,
      ),
    ).toBe(true);

    // Provenance chain inspection
    const prov = knowledge.getProvenance('rule-sub-clearance');
    expect(prov).not.toBeNull();
    expect(prov!.approvedBy).toBe('blago-operator');
    expect(prov!.promotedVia).toBe('gate');
    expect(prov!.evidenceIds).toContain('ev-eq-clean');
    expect(prov!.upstreamNodes.some((n) => n.id === 'ev-eq-clean')).toBe(true);

    // Lifecycle governance & supersession
    expect(knowledge.validateLifecycleTransition('archived', 'active').valid).toBe(false);
    expect(knowledge.validateLifecycleTransition('draft', 'canonical').requiresPromotionGate).toBe(true);
    expect(knowledge.validateLifecycleTransition('canonical', 'superseded').requiresExplicitArchiveOrSupersede).toBe(true);

    const sup = await knowledge.supersedeDocument({
      priorVaultPath: '11_INBOX/title-collision.md',
      supersededByIdOrPath: 'rule-sub-clearance',
      reason: 'Superseded by canonical rule',
      actor: 'blago-operator',
    });
    expect(sup.archivedCopyPath.startsWith('12_ARCHIVE/SUPERSEDED/')).toBe(true);
    const reloaded = await vault.readNote('11_INBOX/title-collision.md');
    expect(reloaded.frontmatter.status).toBe('superseded');
    expect(reloaded.frontmatter.superseded_by).toBe('rule-sub-clearance');
  });

  it('3. performs body-only full-text retrieval across >100 notes and returns enriched context metadata with ACL enforcement', async () => {
    const { vault, knowledge, context, writeRawNote, approveAndPromote } = await createEnv({
      authorize: (ctx) => {
        if (ctx.actor === 'restricted-intern' && ctx.isCanonical) {
          return { allowed: false, reason: 'Canonical Vault records restricted for intern actor' };
        }
        return true;
      },
    });

    // Seed 115 notes so body-only match at index 114 proves full-corpus scanning without silent drop
    for (let i = 0; i < 115; i += 1) {
      const padded = String(i).padStart(3, '0');
      const bodyMarker =
        i === 114
          ? 'Calibration procedure references subharmonic-resonance-calibration factor 0.875 for low-end phase lock.'
          : `Routine filler log entry number ${padded} covering general workspace housekeeping.`;
      await writeRawNote(
        `11_INBOX/bulk/note-${padded}.md`,
        `---
id: bulk-note-${padded}
schema: xyp3rn.knowledge/v3
type: knowledge
title: "Studio Log ${padded}"
domain: KNOWLEDGE
sector: 11_INBOX
status: draft
version: 1
created_at: "2026-10-01T10:00:00Z"
updated_at: "2026-10-01T10:00:00Z"
tags: [bulk]
---

${bodyMarker}
`,
      );
    }

    await approveAndPromote({
      itemId: 'cand-canon-calibration',
      targetVaultPath: '02_KNOWLEDGE/CANONICAL/calibration-policy.md',
      title: 'Canonical Subharmonic Calibration Standard',
      body: 'Mandatory subharmonic-resonance-calibration baseline for X3LIUS sub-bass stems.',
      domain: 'KNOWLEDGE',
      entityId: 'canon-calibration',
      schema: 'xyp3rn.knowledge/v3',
      sourceRefs: ['bulk-note-114'],
      tags: ['canonical', 'calibration'],
    });

    await knowledge.rebuildIndexes({ rebuildSemantic: false });

    // Full-corpus search by body-only phrase for lead operator (sees canonical + working)
    const leadPkg = await context.retrieveContext('subharmonic-resonance-calibration', {
      actor: 'lead-engineer',
      maxItems: 10,
      expandRelationships: false,
    });
    expect(leadPkg.items.some((i) => i.entityId === 'bulk-note-114')).toBe(true);
    const canonItem = leadPkg.items.find((i) => i.entityId === 'canon-calibration');
    expect(canonItem).toBeDefined();
    expect(canonItem!.permissionStatus).toBe('allowed_canonical');
    expect(canonItem!.epistemologicalClass).toBe('canonical_knowledge');
    expect(canonItem!.relevanceReason.length).toBeGreaterThan(0);
    expect(canonItem!.version).toBe(1);
    expect(canonItem!.provenance.approvedBy).toBe('blago-operator');
    expect(canonItem!.checksum).toMatch(/^[a-f0-9]{64}$/);

    const workingItem = leadPkg.items.find((i) => i.entityId === 'bulk-note-114');
    expect(workingItem!.permissionStatus).toBe('allowed_working');
    expect(workingItem!.epistemologicalClass).toBe('working_draft');
    expect(workingItem!.relevanceReason).toContain('body:subharmonic-resonance-calibration');

    // Restricted actor must NOT receive ACL-restricted canonical item
    const internPkg = await context.retrieveContext('subharmonic-resonance-calibration', {
      actor: 'restricted-intern',
      maxItems: 10,
      expandRelationships: false,
    });
    expect(internPkg.items.some((i) => i.entityId === 'canon-calibration')).toBe(false);
    expect(internPkg.items.some((i) => i.entityId === 'bulk-note-114')).toBe(true);
    expect(vault.config.readOnly).toBe(false);
  });

  it('4. supports ISO time-window filtering and recency sorting across Context Engine & Knowledge Graph', async () => {
    const { knowledge, context, writeRawNote } = await createEnv();

    const fixtures = [
      { id: 't-jan', updated: '2026-01-15T12:00:00Z', title: 'January Acoustic Note' },
      { id: 't-jun', updated: '2026-06-15T12:00:00Z', title: 'June Acoustic Note' },
      { id: 't-nov', updated: '2026-11-10T12:00:00Z', title: 'November Acoustic Note' },
    ];
    for (const f of fixtures) {
      await writeRawNote(
        `07_TECH/LOGS/${f.id}.md`,
        `---
id: ${f.id}
schema: xyp3rn.knowledge/v3
type: knowledge
title: "${f.title}"
domain: TECH
sector: 07_TECH
status: active
version: 1
created_at: "${f.updated}"
updated_at: "${f.updated}"
tags: [acoustic]
---

Room resonance acoustic treatment sweep measurement.
`,
      );
    }

    await knowledge.rebuildIndexes({ rebuildSemantic: false });

    const graphFiltered = knowledge.getGraph().queryNodes({
      updatedAfter: '2026-05-01T00:00:00Z',
      updatedBefore: '2026-10-01T00:00:00Z',
    });
    expect(graphFiltered.map((n) => n.id)).toEqual(['t-jun']);

    const recentPkg = await context.retrieveContext('acoustic', {
      updatedAfter: '2026-02-01T00:00:00Z',
      sortBy: 'recency',
      expandRelationships: false,
      bypassCache: true,
    });
    expect(recentPkg.items.map((i) => i.entityId)).toEqual(['t-nov', 't-jun']);
  });

  it('5. builds DAW Brain Context combining live vs cached telemetry, plugins, DSP, approved-only preferences & history cleanly', async () => {
    const { db, knowledge, context, writeRawNote, approveAndPromote } = await createEnv();

    // Runtime DAW session in SQLite + command journal + audio analysis
    db.upsertDawSession({
      id: 'daw-sess-fl25',
      adapterId: 'flstudio-2025-midi',
      hostVersion: '2025.2.0',
      projectPath: 'D:/X3LIUS/ObsidianEcho_v3.flp',
      savedSha256: 'deadbeef00000000000000000000000000000000000000000000000000000001',
      cachedSnapshot: {
        transportState: 'stopped',
        tempoBpm: 140,
        activeTrack: 'Master Bus',
        activePlugins: ['FabFilter Pro-Q 3'],
      },
      status: 'connected',
    });
    db.appendDawCommand({
      sessionId: 'daw-sess-fl25',
      capabilityId: 'mixer.track.inspect',
      targetRef: 'mixer:insert:4',
      command: { action: 'readMeters', insert: 4 },
      status: 'executed',
    });
    db.recordDawAudioAnalysis({
      sessionId: 'daw-sess-fl25',
      sourceKind: 'trace_vst',
      sourceSha256: 'cafebabe00000000000000000000000000000000000000000000000000000002',
      traceAnalysis: { integratedLufs: -9.8, truePeakDbtp: -1.1 },
      traceReport: { verdict: 'compliant' },
    });

    // Vault docs: plugin, DSP concept, session note, historical audio note, canonical preference vs UNAPPROVED draft preference
    await writeRawNote(
      '10_DAW_BRAIN/PLUGINS/pro-q3.md',
      `---
id: plug-pro-q3
schema: xyp3rn.daw-plugin/v3
type: plugin
title: "FabFilter Pro-Q 3 Dynamic EQ"
plugin_format: VST3
vendor: FabFilter
category: equalizer
edition_requirement: Producer Edition
domain: TECH
sector: 10_DAW_BRAIN
status: canonical
version: 1
tags: [plugin, eq, vocal]
---

Linear-phase and dynamic EQ surgical resonance control on vocal bus.
`,
    );

    await writeRawNote(
      '10_DAW_BRAIN/DSP/mud-cut.md',
      `---
id: dsp-mud-cut
schema: xyp3rn.dsp-concept/v3
type: dsp_concept
title: "280Hz Boxiness Dynamic Attenuation"
domain: TECH
sector: 10_DAW_BRAIN
category: spectral
acoustic_principle: "Dynamic notch in 240-320Hz preserves vocal weight without continuous thinness."
status: canonical
version: 1
tags: [dsp, eq, vocal]
---

Apply dynamic dip around 280Hz on lead vocal when harsh harmonics spike.
`,
    );

    await writeRawNote(
      '10_DAW_BRAIN/SESSIONS/obsidian-echo.md',
      `---
id: sess-obsidian-echo
schema: xyp3rn.production-session/v3
type: production_session
title: "ObsidianEcho FL Studio Project Note"
daw_host: "FL Studio 2025"
daw_edition: "Producer Edition"
project_path: "D:/X3LIUS/ObsidianEcho_v3.flp"
state_tier: savedProject
domain: RECORDS
sector: 10_DAW_BRAIN
status: active
version: 3
created_at: "2026-11-15T18:00:00Z"
updated_at: "2026-11-15T18:00:00Z"
tags: [session, obsidian-echo]
---

Vocal bus routes through Insert 4 into Pro-Q 3.
`,
    );

    // Approved canonical preference
    await approveAndPromote({
      itemId: 'pref-x3lius-drill-master',
      targetVaultPath: '10_DAW_BRAIN/MIX_MASTER_REFS/x3lius-vocal-pref.md',
      title: 'X3LIUS Approved Vocal Headroom Preference',
      body: 'User-approved preference: keep lead vocal Pro-Q 3 crest above -1.0 dBTP headroom target.',
      domain: 'RECORDS',
      entityId: 'pref-x3lius-drill-master',
      schema: 'xyp3rn.mix-reference/v3',
      sourceRefs: ['studio-approval-log'],
      tags: ['preference', 'house-style', 'vocal'],
      metadata: {
        type: 'mix_reference',
        stage: 'mix',
        target_lufs_min: -11,
        target_lufs_max: -8.5,
        max_true_peak_dbtp: -1.0,
      },
    });

    // Unapproved DRAFT preference that MUST NEVER appear in userApprovedPreferences
    await writeRawNote(
      '11_INBOX/unapproved-vocal-pref.md',
      `---
id: draft-unapproved-pref
schema: xyp3rn.mix-reference/v3
type: mix_reference
title: "Experimental Unapproved Vocal Clipping Preference"
stage: mix
target_lufs_min: -5
target_lufs_max: -3
max_true_peak_dbtp: 0.2
domain: RECORDS
sector: 11_INBOX
status: draft
version: 1
tags: [preference, house-style, vocal]
---

Unvetted experimental loudness preference.
`,
    );

    await knowledge.rebuildIndexes({ rebuildSemantic: true });

    const livePkg = await context.retrieveDawContext({
      query: 'vocal bus Pro-Q 3 EQ headroom',
      sessionId: 'daw-sess-fl25',
      projectVaultPath: '10_DAW_BRAIN/SESSIONS/obsidian-echo.md',
      liveObservation: {
        transportState: 'playing',
        tempoBpm: 144,
        activeTrack: 'Vocal Lead Insert 4',
        activePlugins: ['FabFilter Pro-Q 3'],
        matchesSavedProject: false,
      },
      tokenBudget: 3_000,
    });

    // Strict epistemic boundary assertions for LIVE observation
    expect(livePkg.liveObservation.sourceTier).toBe('liveObserved');
    expect(livePkg.liveObservation.isLiveEphemeral).toBe(true);
    expect(livePkg.liveObservation.authoritativeForKnowledge).toBe(false);
    expect(livePkg.liveObservation.persistedInVault).toBe(false);
    expect(livePkg.liveObservation.summary).toContain('EPHEMERAL LIVE OBSERVATION');

    // Project metadata shows saved SHA while clearly marking live divergence
    expect(livePkg.projectMetadata.savedSha256).toContain('deadbeef');
    expect(livePkg.projectMetadata.matchesLiveState).toBe(false);
    expect(livePkg.projectMetadata.projectNotes.some((n) => n.filePath === '10_DAW_BRAIN/SESSIONS/obsidian-echo.md')).toBe(true);

    // Stored sections populated cleanly
    expect(livePkg.pluginDocumentation.some((p) => p.entityId === 'plug-pro-q3')).toBe(true);
    expect(livePkg.productionKnowledge.some((k) => k.entityId === 'dsp-mud-cut')).toBe(true);
    expect(livePkg.userApprovedPreferences.some((p) => p.entityId === 'pref-x3lius-drill-master')).toBe(true);
    expect(livePkg.userApprovedPreferences.some((p) => p.entityId === 'draft-unapproved-pref')).toBe(false);
    expect(livePkg.historicalRecords.recentCommands).toHaveLength(1);
    expect(livePkg.historicalRecords.recentAudioAnalyses).toHaveLength(1);

    // Offline / cached fallback marks snapshot explicitly stale and still non-authoritative
    const cachedPkg = await context.retrieveDawContext({
      query: 'vocal bus Pro-Q 3 EQ headroom',
      sessionId: 'daw-sess-fl25',
      bypassCache: true,
    });
    expect(cachedPkg.liveObservation.sourceTier).toBe('cached_stale');
    expect(cachedPkg.liveObservation.isLiveEphemeral).toBe(true);
    expect(cachedPkg.liveObservation.authoritativeForKnowledge).toBe(false);
    expect(cachedPkg.liveObservation.summary).toContain('STALE CACHED');

    // Tight token budget caps total tokens cleanly
    const tightPkg = await context.retrieveDawContext({
      query: 'vocal bus Pro-Q 3 EQ headroom',
      sessionId: 'daw-sess-fl25',
      tokenBudget: 250,
      bypassCache: true,
    });
    expect(tightPkg.totalTokens).toBeLessThanOrEqual(250);
    expect(tightPkg.truncatedByBudget).toBe(true);
  });
});
