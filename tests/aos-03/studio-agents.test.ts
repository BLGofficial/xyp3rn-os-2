import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../../core/agent-registry/registry.ts';
import { dispatch, type DispatchDeps } from '../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../core/runtime/handlers.ts';
import { createRuntimeTools } from '../../core/runtime/tools.ts';
import { CLASS_CAPABILITIES } from '../../core/tool-registry/capabilities.ts';
import { loadWorkflow, runWorkflow } from '../../core/workflow-engine/engine.ts';
import { parseWorkflowSpec } from '../../core/workflow-engine/spec.ts';
import { decideArtifact } from '../../governance/approvals.ts';
import { addToVault } from '../../knowledge/ingestion/vault.ts';
import { createLocalVaultStore } from '../../knowledge/source-registry/vault-store.ts';
import { sectionLabels } from '../../records/x3lius/creative/lyrics.ts';
import { renderLyrics } from '../../records/x3lius/suno/formula.ts';
import { sunoLimits } from '../../records/x3lius/suno/package.ts';
import { defaultTagSet, renderWithTags } from '../../records/x3lius/studio/tags.ts';
import { parseLyricSheet } from '../../records/vault/lyric-sheet.ts';
import { addAndImport } from '../../records/vault/import.ts';
import { createTestDb, REPO_ROOT, type TestDb } from '../helpers/db.ts';
import { insertArtifact, insertTake } from '../helpers/records-fixture.ts';

// AOS-03 proof (part 2): Studio through the real agents. x3lius-studio-editor (Creative, new) writes
// the owner's style recipes and meta-tag sets; x3lius-suno-package (Creative, new) renders a Suno
// prompt package from a lyric, a recipe and a tag set, in build-suno-package; suno-submitter hands
// off packages only (S4), records takes from Vault audio (S3), and records the owner's ratings.
// No model: all deterministic. What is real: dispatch, every tool's DB role, the workflows, the
// DB gate. The one FAKE is the Suno reseller's HTTP API, to prove a draft never reaches it.

let db: TestDb;
let deps: DispatchDeps;
const files = mkdtempSync(join(tmpdir(), 'aos03-agents-files-'));
const vaultDir = mkdtempSync(join(tmpdir(), 'aos03-agents-vault-'));
const registry = createAgentRegistry({ dir: join(REPO_ROOT, 'agents') });
const BUILD_PACKAGE = join(REPO_ROOT, 'records', 'workflows', 'build-suno-package.workflow.yaml');
const REGISTER_TRACK = join(REPO_ROOT, 'records', 'workflows', 'register-track.workflow.yaml');
const SUNO_ENV = { SUNO_API_KEY: 'test-suno', SUNO_CALLBACK_URL: 'https://hooks.example.org/suno' };

/** A FAKE sunoapi.org: records each call and answers with the next canned reply. */
const fakeSuno = (responses: readonly unknown[]) => {
  const calls: { url: string; body: unknown }[] = [];
  let i = 0;
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(responses[Math.min(i++, responses.length - 1)]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn: fn as typeof fetch, calls };
};
const withSuno = (fetchFn: typeof fetch): DispatchDeps => ({
  ...deps, tools: createRuntimeTools({ sql: db.sql, env: SUNO_ENV, fetch: fetchFn, vault: createLocalVaultStore(vaultDir) }),
});

beforeAll(async () => {
  db = await createTestDb('aos03_studio_agents', { migrated: true });
  deps = { sql: db.sql, registry, tools: createRuntimeTools({ sql: db.sql, env: {}, vault: createLocalVaultStore(vaultDir) }), handlers: HANDLERS };
});
afterAll(async () => {
  await db?.drop();
  rmSync(files, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

let seq = 0;
/** 0.1 s of 16-bit mono silence at 8 kHz, made unique per call: a complete, playable WAV. */
const wav = (): Buffer => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + 1600, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(1600, 40);
  const body = Buffer.alloc(1600);
  body.writeUInt16LE(++seq, 0);
  return Buffer.concat([h, body]);
};
const file = (name: string, content: Buffer | string): string => {
  const p = join(files, `${++seq}-${name}`);
  writeFileSync(p, content);
  return p;
};
const ok = async (agent: string, input: unknown, d = deps) => {
  const r = await dispatch(d, agent, input);
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
  return r.output as Record<string, any>;
};
const refused = async (agent: string, input: unknown, reason: RegExp, d = deps) => {
  const r = await dispatch(d, agent, input);
  expect(r.status, JSON.stringify(input)).toBe('error');
  expect(r.error).toMatch(reason);
  return r;
};
const approve = (artifactId: string) => decideArtifact(db.sql, artifactId, { decision: 'approve', approver: '[FIXTURE] owner', reason: '[FIXTURE] approved' });
const body = async (id: string) => (await db.sql<{ body: Record<string, any>; agent_name: string; version: number; lineage_id: string }[]>`
  select body, agent_name, version, lineage_id from creative_artifacts where id = ${id}`)[0]!;
const status = async (id: string) => (await db.sql<{ status: string }[]>`select status from artifact_approvals where id = ${id}`)[0]!.status;

const SHEET = '[Verse 1]\n[FIXTURE] neon on the wet street\n[FIXTURE] nobody sleeps in this city\n[Chorus]\n[FIXTURE] we run tonight\n[Verse 2]\n[FIXTURE] sirens sing the second verse\n[Chorus]\n[FIXTURE] we run tonight\n';
/**
 * The owner's lyrics: a lyric sheet in the Vault, imported by the lyric editor (AOS-01). The closing
 * direction (never sung) makes each sheet's bytes unique, so each call is a new lyric version.
 */
const lyrics = async (text = SHEET): Promise<string> => {
  const r = await addAndImport(deps, { path: file('sheet.txt', `${text}[FIXTURE sheet ${++seq}]\n`), as: 'lyric_sheet', language: 'en' });
  return (r.lyrics as { artifactId: string }).artifactId;
};
const recipe = async (over: Record<string, unknown> = {}) =>
  ok('x3lius-studio-editor', { recipe: { name: '[FIXTURE] Night drive', style: '[FIXTURE] dark melodic trap, 140 bpm, male baritone', excludeStyles: ['[FIXTURE] country'], ...over } });
const tags = async () => ok('x3lius-studio-editor', { defaultTagSet: {} });
const song = async () => (await ok('records-songs', { create: { title: '[FIXTURE] Night City', artist: 'X3LIUS' } })).songId as string;
const build = (input: Record<string, unknown>) => runWorkflow(deps, loadWorkflow(BUILD_PACKAGE, registry), input);

describe('agents and capabilities', () => {
  it('the studio editor and the package builder are deterministic Creative agents; the submitter gains rate_take (feedback.write)', () => {
    expect(registry.validateAll()).toEqual([]);
    const tools = (name: string) => [...registry.get(name)!.tools].sort();
    expect(registry.get('x3lius-studio-editor')).toMatchObject({ class: 'Creative', domain: 'RECORDS', model: 'none' });
    expect(tools('x3lius-studio-editor')).toEqual(['log_message', 'read_artifact', 'write_artifact']);
    expect(registry.get('x3lius-suno-package')).toMatchObject({ class: 'Creative', domain: 'RECORDS', model: 'none' });
    expect(tools('x3lius-suno-package')).toEqual(['log_message', 'read_artifact', 'retrieve_claims', 'write_artifact']);
    expect(tools('suno-submitter')).toEqual(['capture_suno_takes', 'log_message', 'rate_take', 'submit_suno']);
    expect(CLASS_CAPABILITIES['feedback.write']).toEqual(['Execution']);
    expect(deps.tools.get('rate_take')?.capability).toBe('feedback.write');
    expect(deps.tools.authorize('Creative', 'rate_take').allow).toBe(false);
    for (const a of ['x3lius-studio-editor', 'x3lius-suno-package']) expect(HANDLERS[a]).toBeTypeOf('function');
  });
});

describe('tag sets (S2): the code labels are the default set’s first version', () => {
  it('the default set renders exactly what the Phase 9 formula renders, for both lyric writers', () => {
    const set = defaultTagSet();
    expect(set.sections.map((s) => s.kind)).toEqual(['intro', 'verse', 'pre-chorus', 'chorus', 'post-chorus', 'hook', 'bridge', 'breakdown', 'outro']);
    expect(set.sections.filter((s) => s.numbered).map((s) => s.kind)).toEqual(['verse']);
    expect(set.sections.every((s) => s.cues.length === 0)).toBe(true);
    // The lyric editor's parse of a sheet.
    const sheet = parseLyricSheet(`${SHEET}[Bridge]\n[FIXTURE] the bridge\n[Outro]\n[FIXTURE] fade\n`, 'en');
    expect(renderWithTags(sheet.sections, set)).toBe(renderLyrics([{ schemaId: 'x3lius.lyrics/v2', body: sheet }]));
    // The Lyrics agent's shape: labels from sectionLabels, one per kind in song order.
    const kinds = ['intro', 'verse', 'pre-chorus', 'chorus', 'verse', 'pre-chorus', 'chorus', 'post-chorus', 'hook', 'bridge', 'breakdown', 'chorus', 'outro'];
    const labels = sectionLabels(kinds);
    const sections = kinds.map((kind, i) => ({ sectionId: `s${i}`, kind, label: labels[i]!, bars: [{ n: 1, text: `[FIXTURE] line ${i}`, language: 'en', rhymeTag: 'A' }] }));
    expect(renderWithTags(sections, set)).toBe(renderLyrics([{ schemaId: 'x3lius.lyrics/v2', body: { sections } }]));
  });

  it('owner cues render as tags after the label; numbering follows the set, per kind, in song order', () => {
    const set = {
      name: '[FIXTURE] live', notes: [],
      sections: [
        { kind: 'verse', label: 'Verse', numbered: true, cues: ['Whispered', 'Sparse drums'] },
        { kind: 'chorus', label: 'Chorus', numbered: true, cues: ['Anthemic'] },
      ],
    };
    const sheet = parseLyricSheet(SHEET, 'en');
    expect(renderWithTags(sheet.sections, set)).toBe([
      '[Verse 1]\n[Whispered]\n[Sparse drums]\n[FIXTURE] neon on the wet street\n[FIXTURE] nobody sleeps in this city',
      '[Chorus 1]\n[Anthemic]\n[FIXTURE] we run tonight',
      '[Verse 2]\n[Whispered]\n[Sparse drums]\n[FIXTURE] sirens sing the second verse',
      '[Chorus 2]\n[Anthemic]\n[FIXTURE] we run tonight',
    ].join('\n\n'));
  });

  it('a section kind the set has no tag for is refused, naming it', () => {
    const set = { name: '[FIXTURE] verses only', notes: [], sections: [{ kind: 'verse', label: 'Verse', numbered: true, cues: [] }] };
    expect(() => renderWithTags(parseLyricSheet(SHEET, 'en').sections, set)).toThrow(/tag set "\[FIXTURE\] verses only" has no tag for chorus/);
  });
});

describe('x3lius-studio-editor: the owner’s style recipes and tag sets', () => {
  it('writes the default tag set as a new lineage, a draft; an edit with cues is its next version', async () => {
    const d = await tags();
    expect(d).toMatchObject({ version: 1, schemaId: 'x3lius.meta-tag-set/v1', warnings: [] });
    const v1 = await body(d.artifactId);
    expect(v1.agent_name).toBe('x3lius-studio-editor');
    expect(v1.body).toMatchObject({ ...defaultTagSet(), rulesApplied: [] });
    expect(await status(d.artifactId)).toBe('draft');
    const sections = defaultTagSet().sections.map((s) => (s.kind === 'chorus' ? { ...s, cues: ['Anthemic', 'Full band'] } : s));
    const e = await ok('x3lius-studio-editor', { tagSet: { name: '[FIXTURE] X3LIUS live', sections, parentId: d.artifactId } });
    expect(e).toMatchObject({ lineageId: d.lineageId, version: 2 });
    expect((await body(e.artifactId)).body.sections.find((s: { kind: string }) => s.kind === 'chorus')).toEqual({ kind: 'chorus', label: 'Chorus', numbered: false, cues: ['Anthemic', 'Full band'] });
  });

  it('refuses a tag set Suno could not read: a repeated kind, a blank label, a bracket in a cue, a mixed-script cue', async () => {
    const base = { name: '[FIXTURE] bad' };
    await refused('x3lius-studio-editor', { tagSet: { ...base, sections: [{ kind: 'verse', label: 'Verse' }, { kind: 'verse', label: 'Strophe' }] } }, /verse is tagged twice/);
    await refused('x3lius-studio-editor', { tagSet: { ...base, sections: [{ kind: 'verse', label: ' ' }] } }, /the verse label is blank/);
    await refused('x3lius-studio-editor', { tagSet: { ...base, sections: [{ kind: 'verse', label: 'Verse', cues: ['[Whispered]'] }] } }, /can't contain \[ or \]/);
    await refused('x3lius-studio-editor', { tagSet: { ...base, sections: [{ kind: 'verse', label: 'Verse', cues: ['Шepot'] }] } }, /mixed-script word "Шepot"/);
    await refused('x3lius-studio-editor', { tagSet: { ...base, sections: [{ kind: 'interlude', label: 'Interlude' }] } }, /write_artifact rejected/);
  });

  it('writes a recipe and its next version; only style and exclusions face Suno (F22)', async () => {
    const r = await recipe();
    expect(r).toMatchObject({ version: 1, schemaId: 'x3lius.style-recipe/v1' });
    expect((await body(r.artifactId)).body).toEqual({
      name: '[FIXTURE] Night drive', style: '[FIXTURE] dark melodic trap, 140 bpm, male baritone', excludeStyles: ['[FIXTURE] country'],
      mood: [], production: [], notes: [], sources: [], rulesApplied: [], ungroundedChoices: ['owner-authored'],
    });
    const v2 = await ok('x3lius-studio-editor', { recipe: {
      name: '[FIXTURE] Night drive', style: '[FIXTURE] dark melodic trap, 138 bpm', excludeStyles: [], mood: ['[FIXTURE] cold'],
      production: ['[FIXTURE] sidechain the pads'], notes: ['[FIXTURE] 140 bpm rushed the hook; phonк drums never land'], parentId: r.artifactId,
    } });
    expect(v2).toMatchObject({ lineageId: r.lineageId, version: 2 });
    expect(v2.warnings).toEqual([expect.stringMatching(/mixed-script word "phonк" at \$\.notes\[0\]/)]);
    await refused('x3lius-studio-editor', { recipe: { name: '[FIXTURE] x', style: 'dark phonк trap' } }, /mixed-script word "phonк" at \$\.style/);
    await refused('x3lius-studio-editor', { recipe: { name: '[FIXTURE] x', style: '  ' } }, /style is blank/);
    await refused('x3lius-studio-editor', { recipe: { name: '[FIXTURE] x', style: 'x', parentId: (await tags()).artifactId } }, /edits x3lius\.style-recipe\/v1 only/);
  });

  it('seeds a recipe from a model’s Suno formula, citing it; the words are the model’s, and it says so', async () => {
    const formula = await insertArtifact(db.sql, 'x3lius.suno-prompt/v1', {
      sunoModel: 'v5', title: '[FIXTURE] Night City', style: '[FIXTURE] baritone over dark trap, 140 bpm', excludeStyles: ['[FIXTURE] acoustic'],
      lyrics: '[Verse 1]\n[FIXTURE] x', sources: [], limits: [], rulesApplied: [], ungroundedChoices: [],
    });
    const r = await ok('x3lius-studio-editor', { recipeFrom: { artifactId: formula } });
    const b = (await body(r.artifactId)).body;
    expect(b).toMatchObject({
      name: '[FIXTURE] Night City', style: '[FIXTURE] baritone over dark trap, 140 bpm', excludeStyles: ['[FIXTURE] acoustic'],
      sources: [{ role: 'suno-prompt', artifactId: formula, schemaId: 'x3lius.suno-prompt/v1', version: 1 }],
    });
    expect(b.ungroundedChoices).toEqual([`copied from the model-written formula ${formula} v1`]);
    await refused('x3lius-studio-editor', { recipeFrom: { artifactId: await lyrics() } }, /expected x3lius\.suno-prompt\/v1/);
  });

  it('takes exactly one operation', async () => {
    await refused('x3lius-studio-editor', {}, /exactly one of recipe, recipeFrom, tagSet, defaultTagSet/);
    await refused('x3lius-studio-editor', { recipe: {}, defaultTagSet: {} }, /exactly one of recipe, recipeFrom, tagSet, defaultTagSet/);
  });
});

describe('x3lius-suno-package: a package from a lyric, a recipe and a tag set', () => {
  it('renders the lyrics with the tag set and copies the recipe’s Suno fields; it names every version; drafts build a preview', async () => {
    const l = await lyrics();
    const r = await recipe();
    const set = await ok('x3lius-studio-editor', { tagSet: { name: '[FIXTURE] live', sections: [
      { kind: 'verse', label: 'Verse', numbered: true, cues: ['Whispered'] }, { kind: 'chorus', label: 'Chorus', cues: ['Anthemic'] },
    ] } });
    const p = await ok('x3lius-suno-package', { lyricsArtifactId: l, styleRecipeArtifactId: r.artifactId, tagSetArtifactId: set.artifactId, title: '[FIXTURE] Night City', sunoModel: 'V5' });
    const row = await body(p.artifactId);
    expect(row.agent_name).toBe('x3lius-suno-package');
    expect(row.body).toEqual({
      sunoModel: 'v5', title: '[FIXTURE] Night City', style: '[FIXTURE] dark melodic trap, 140 bpm, male baritone', excludeStyles: ['[FIXTURE] country'],
      lyrics: '[Verse 1]\n[Whispered]\n[FIXTURE] neon on the wet street\n[FIXTURE] nobody sleeps in this city\n\n[Chorus]\n[Anthemic]\n[FIXTURE] we run tonight\n\n'
        + '[Verse 2]\n[Whispered]\n[FIXTURE] sirens sing the second verse\n\n[Chorus]\n[Anthemic]\n[FIXTURE] we run tonight',
      sources: [
        { role: 'lyrics', artifactId: l, schemaId: 'x3lius.lyrics/v2', version: 1 },
        { role: 'style-recipe', artifactId: r.artifactId, schemaId: 'x3lius.style-recipe/v1', version: 1 },
        { role: 'meta-tag-set', artifactId: set.artifactId, schemaId: 'x3lius.meta-tag-set/v1', version: 1 },
      ],
      limits: [], rulesApplied: [], ungroundedChoices: [],
    });
    expect(p).toMatchObject({ version: 1, lineageId: p.artifactId });
  });

  it('refuses: a wrong kind of artifact, a kind the tag set lacks, a bad model or title, a mixed-script title', async () => {
    const [l, r, t] = [await lyrics(), (await recipe()).artifactId, (await tags()).artifactId];
    const input = { lyricsArtifactId: l, styleRecipeArtifactId: r, tagSetArtifactId: t, title: '[FIXTURE] Night City', sunoModel: 'v5' };
    await refused('x3lius-suno-package', { ...input, lyricsArtifactId: r }, /expected x3lius\.lyrics\/v2/);
    await refused('x3lius-suno-package', { ...input, styleRecipeArtifactId: t }, /expected x3lius\.style-recipe\/v1/);
    await refused('x3lius-suno-package', { ...input, tagSetArtifactId: r }, /expected x3lius\.meta-tag-set\/v1/);
    const versesOnly = await ok('x3lius-studio-editor', { tagSet: { name: '[FIXTURE] verses', sections: [{ kind: 'verse', label: 'Verse', numbered: true }] } });
    await refused('x3lius-suno-package', { ...input, tagSetArtifactId: versesOnly.artifactId }, /has no tag for chorus/);
    await refused('x3lius-suno-package', { ...input, sunoModel: 'five' }, /sunoModel/);
    await refused('x3lius-suno-package', { ...input, title: ' ' }, /title/);
    await refused('x3lius-suno-package', { ...input, title: 'Пeak' }, /mixed-script word "Пeak" at \$\.title/);
  });

  it('limits come from canonical claims for that Suno model only; over a limit is refused', () => {
    const claim = (topic: string, value: number, modelScope: string) => ({ ref: { table: 'canonical_prompts' as const, id: '11111111-1111-4111-8111-111111111111' }, slug: 'fixture', version: 1, title: '[FIXTURE]', module: 'x3lius-suno', topic, value, modelScope, source: null });
    const measured = { title: 20, style: 50, 'exclude-styles': 0, lyrics: 400 };
    const r = sunoLimits([claim('suno.limit.lyrics-chars', 3000, 'suno-v5'), claim('suno.limit.style-chars', 40, 'model-agnostic'), claim('suno.limit.title-chars', 5, 'suno-v4.5'), claim('suno.other', 1, 'suno-v5')], measured, 'v5');
    expect(r.limits).toEqual([
      { field: 'lyrics', max: 3000, actual: 400, ref: 'canonical_prompts:11111111-1111-4111-8111-111111111111#suno.limit.lyrics-chars' },
      { field: 'style', max: 40, actual: 50, ref: 'canonical_prompts:11111111-1111-4111-8111-111111111111#suno.limit.style-chars' },
    ]);
    expect(r.violations).toEqual(['style is 50 chars; canonical limit 40 (canonical_prompts:11111111-1111-4111-8111-111111111111#suno.limit.style-chars)']);
  });
});

describe('build-suno-package: the package, linked to its song, built in a workflow', () => {
  it('links the package to the song; the run is the package’s workflow version; readiness lists the drafts', async () => {
    const songId = await song();
    const [l, r, t] = [await lyrics(), (await recipe()).artifactId, (await tags()).artifactId];
    const run = await build({ songId, lyricsArtifactId: l, styleRecipeArtifactId: r, tagSetArtifactId: t, title: '[FIXTURE] Night City', sunoModel: 'v5' });
    expect(run, JSON.stringify(run)).toMatchObject({ status: 'success' });
    const out = run.output as { packageId: string; linkId: string };
    const [link] = await db.sql`select song_id, role, artifact_lineage_id from song_links where id = ${out.linkId}`;
    expect(link).toEqual({ song_id: songId, role: 'suno-package', artifact_lineage_id: out.packageId });
    const [w] = await db.sql`select w.workflow_name, w.status from agent_runs a join workflow_runs w on w.id = a.workflow_run_id
      where a.id = (select agent_run_id from creative_artifacts where id = ${out.packageId})`;
    expect(w).toEqual({ workflow_name: 'build-suno-package', status: 'success' });
    const [ready] = await db.sql<{ reasons: string[] }[]>`select xyp_suno_package_ready(${out.packageId}) as reasons`;
    expect(ready!.reasons.map((x) => x.split(' ')[0])).toEqual(['lyrics', 'style-recipe', 'meta-tag-set']);
  });
});

describe('suno-submitter: packages only (S4), takes from the Vault (S3), the owner’s ratings', () => {
  /** A package built in the workflow, with each source approved unless listed in `draft`. */
  const packaged = async (draft: readonly string[] = []) => {
    const songId = await song();
    const src = { lyrics: await lyrics(), recipe: (await recipe()).artifactId, tags: (await tags()).artifactId };
    for (const [k, id] of Object.entries(src)) if (!draft.includes(k)) await approve(id);
    const run = await build({ songId, lyricsArtifactId: src.lyrics, styleRecipeArtifactId: src.recipe, tagSetArtifactId: src.tags, title: '[FIXTURE] Night City', sunoModel: 'v5' });
    expect(run.status).toBe('success');
    return (run.output as { packageId: string }).packageId;
  };

  it('a draft never reaches an adapter: the sunoapi reseller is not called, and nothing is recorded', async () => {
    const packageId = await packaged(['recipe']);
    const suno = fakeSuno([{ code: 200, msg: 'success', data: { taskId: 'task-never' } }]);
    await refused('suno-submitter', { submit: { packageId, adapter: 'sunoapi' } }, /not ready to hand off: style-recipe .* v1 is draft/, withSuno(suno.fn));
    expect(suno.calls).toHaveLength(0);
    expect(await db.sql`select 1 from suno_submissions where formula_artifact_id = ${packageId}`).toHaveLength(0);
  });

  it('an approved package is handed off: the recorded prompt is the package’s own', async () => {
    const packageId = await packaged();
    const s = await ok('suno-submitter', { submit: { packageId, adapter: 'manual' } });
    expect(s).toMatchObject({ adapter: 'manual', sunoModel: 'v5', status: 'awaiting-takes' });
    const b = (await body(packageId)).body;
    const [row] = await db.sql`select prompt, suno_model from suno_submissions where id = ${s.submissionId}`;
    expect(row).toEqual({ prompt: { title: b.title, style: b.style, excludeStyles: b.excludeStyles, lyrics: b.lyrics }, suno_model: 'v5' });
  });

  it('refuses a Phase 9 formula and the Phase 9 input key, pointing at packages', async () => {
    const formula = await insertArtifact(db.sql, 'x3lius.suno-prompt/v1', { title: '[FIXTURE] t', style: 's', excludeStyles: [], lyrics: 'l', sunoModel: 'v5' });
    await refused('suno-submitter', { submit: { packageId: formula, adapter: 'manual' } }, /expects a x3lius\.suno-package\/v1 .*build-suno-package/);
    await refused('suno-submitter', { submit: { formulaArtifactId: formula, adapter: 'manual' } }, /takes packageId since AOS-03/);
  });

  it('manual capture records a Vault audio file as a take; a file that is not audio, or a take naming both, is refused', async () => {
    const s = await ok('suno-submitter', { submit: { packageId: await packaged(), adapter: 'manual' } });
    const audio = (await addToVault(deps, { path: file('take.wav', wav()) })).sourceId;
    const c = await ok('suno-submitter', { capture: { submissionId: s.submissionId, takes: [{ sourceId: audio, title: '[FIXTURE] take 1' }] } });
    expect(c).toMatchObject({ status: 'captured', inserted: 1, takes: [{ sourceId: audio, audioUrl: null }] });
    const [t] = await db.sql`select source_id, audio_url, title from suno_takes where id = ${c.takes[0].id}`;
    expect(t).toEqual({ source_id: audio, audio_url: null, title: '[FIXTURE] take 1' });
    expect(await ok('suno-submitter', { capture: { submissionId: s.submissionId, takes: [{ sourceId: audio }] } })).toMatchObject({ inserted: 0, alreadyCaptured: 1 });
    const doc = (await addToVault(deps, { path: file('notes.txt', `[FIXTURE] notes ${seq}`) })).sourceId;
    await refused('suno-submitter', { capture: { submissionId: s.submissionId, takes: [{ sourceId: doc }] } }, /is not a Vault audio file/);
    await refused('suno-submitter', { capture: { submissionId: s.submissionId, takes: [{ sourceId: audio, audioUrl: 'https://cdn1.suno.ai/x.mp3' }] } }, /exactly one of audioUrl, sourceId/);
  });

  it('rate: the owner’s rating of a take, with what to keep and what to change; the latest is current', async () => {
    const { takeId } = await insertTake(db.sql);
    const r = await ok('suno-submitter', { rate: { takeId, rating: 2, change: '[FIXTURE] the hook comes in late' } });
    expect(r).toMatchObject({ takeId, rating: 2 });
    await ok('suno-submitter', { rate: { takeId, rating: 4, keep: '[FIXTURE] the vocal chain' } });
    expect((await db.sql`select rating, keep, change from current_take_ratings where take_id = ${takeId}`)[0]).toEqual({ rating: 4, keep: '[FIXTURE] the vocal chain', change: null });
    await refused('suno-submitter', { rate: { takeId, rating: 7 } }, /rating must be an integer from 1 to 5/);
    await refused('suno-submitter', { rate: { takeId, rating: 3 }, capture: { submissionId: 'x' } }, /exactly one of submit, capture, rate/);
  });
});

describe('optional workflow inputs (G11, part)', () => {
  const AGENTS = new Set(['health-check']);
  const spec = (input: string) => `name: optional-demo\ndescription: x\ninput:\n${input}\nsteps:\n  - id: ping\n    agent: health-check\n    input:\n      ping: { $from: input.ping }\n      note: { $from: input.note }\n`;

  it('a spec declares optional inputs; a name in both lists, or an undeclared one, is refused', () => {
    const good = parseWorkflowSpec(spec('  required: [ping]\n  optional: [note]'), AGENTS);
    expect(good.ok && good.spec.optionalInput).toEqual(['note']);
    const both = parseWorkflowSpec(spec('  required: [ping, note]\n  optional: [note]'), AGENTS);
    expect(both.ok ? [] : both.errors).toContainEqual('input note is both required and optional');
    const undeclared = parseWorkflowSpec(spec('  required: [ping]'), AGENTS);
    expect(undeclared.ok ? [] : undeclared.errors).toContainEqual('step ping: $from input.note is not a declared input (required: ping)');
  });

  it('register-track runs with only the recording it has: the absent inputs bind as null', async () => {
    const { takeId } = await insertTake(db.sql);
    const r = await runWorkflow(deps, loadWorkflow(REGISTER_TRACK, registry), { takeId, release: { title: '[FIXTURE] New Era', artist: 'X3LIUS', kind: 'single' }, position: 1 });
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'success' });
    const [lookup] = await db.sql<{ input: Record<string, unknown> }[]>`select input from agent_runs where workflow_run_id = ${r.workflowRunId} and step_id = 'lookup'`;
    expect(lookup!.input).toMatchObject({ takeId, sourceId: null, title: null, mixReportArtifactId: null });
  });
});
