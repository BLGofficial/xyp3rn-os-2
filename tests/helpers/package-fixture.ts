import type postgres from 'postgres';
import type { Sql } from '../../core/db/client.ts';

// AOS-03 fixtures: a Suno prompt package (x3lius.suno-package/v1) and the versions it was built
// from, inserted directly. Since AOS-03 a submission must name a package whose lyric, style recipe
// and tag set versions are approved and which a workflow run built (the submission gate, S4), so
// every fixture that submits goes through here. Every text field is marked [FIXTURE].

type Exec = Sql | postgres.TransactionSql;
export type PackagePart = 'lyrics' | 'recipe' | 'tags';

export type PackageOptions = {
  /** Which source versions the owner approved (default: all three). */
  readonly approve?: readonly PackagePart[];
  /** The workflow run that built it: `success` (default), `error`, or `none` (built outside a workflow). */
  readonly workflow?: 'success' | 'error' | 'none';
  readonly title?: string;
};

export type FixturePackage = {
  readonly packageId: string;
  readonly lyricsId: string;
  readonly recipeId: string;
  readonly tagSetId: string;
  readonly workflowRunId: string | null;
  readonly sunoModel: string;
  /** What a submission of this package records: the package's own Suno fields. */
  readonly prompt: { readonly title: string; readonly style: string; readonly excludeStyles: readonly string[]; readonly lyrics: string };
};

export const FIXTURE_PACKAGE_TITLE = '[FIXTURE] Night City';

const run = async (x: Exec, agent: string, cls: string, workflowRunId: string | null = null, stepId: string | null = null): Promise<string> =>
  (await x<{ id: string }[]>`
    insert into agent_runs (agent_name, class, domain, input, workflow_run_id, step_id)
    values (${agent}, ${cls}, 'RECORDS', '{}', ${workflowRunId}, ${stepId}) returning id`)[0]!.id;

const artifact = async (x: Exec, schemaId: string, agent: string, runId: string, body: Record<string, unknown>): Promise<string> =>
  (await x<{ id: string }[]>`
    insert into creative_artifacts (schema_id, agent_name, agent_run_id, brief, body, context_refs, knowledge, model)
    values (${schemaId}, ${agent}, ${runId}, '[FIXTURE] brief', ${x.json(body as postgres.JSONValue)}, '[]', ${x.json({ authored: 'owner' })}, 'none')
    returning id`)[0]!.id;

const OWNER = { rulesApplied: [], ungroundedChoices: ['owner-authored'] };
const source = (role: string, artifactId: string, schemaId: string) => ({ role, artifactId, schemaId, version: 1 });

/**
 * The owner's decision on one version, as `pnpm vault approve` records it.
 * @param x - connection or transaction (superuser)
 * @param artifactId - the version
 * @param decision - approve or reject
 */
export const decideFixture = async (x: Exec, artifactId: string, decision: 'approve' | 'reject' = 'approve'): Promise<void> => {
  await x`select xyp_decide_artifact(${artifactId}, ${decision}, '[FIXTURE] owner', '[FIXTURE] decision')`;
};

/**
 * A lyric version, a style recipe and a tag set, then a package built from them in a
 * `build-suno-package` workflow run, inserted directly (superuser; triggers still run).
 * @param x - connection or transaction
 * @param o - which versions are approved, and how the package was built
 * @returns the package and its sources
 */
export const insertPackage = async (x: Exec, o: PackageOptions = {}): Promise<FixturePackage> => {
  const approve = o.approve ?? ['lyrics', 'recipe', 'tags'];
  const title = o.title ?? FIXTURE_PACKAGE_TITLE;
  const lyricsId = await artifact(x, 'x3lius.lyrics/v2', 'x3lius-lyric-editor', await run(x, 'x3lius-lyric-editor', 'Creative'), {
    sections: [{
      sectionId: 's1', kind: 'verse', label: 'Verse 1', rhymeScheme: 'A', devices: [], directions: [],
      bars: [{ n: 1, text: '[FIXTURE] neon on the wet street', language: 'en', rhymeTag: 'A' }],
    }],
    instrumental: [], sources: [], ...OWNER,
  });
  const recipeId = await artifact(x, 'x3lius.style-recipe/v1', 'x3lius-studio-editor', await run(x, 'x3lius-studio-editor', 'Creative'), {
    name: '[FIXTURE] recipe', style: '[FIXTURE] dark melodic trap, 140 bpm', excludeStyles: ['[FIXTURE] country'],
    mood: [], production: [], notes: [], sources: [], ...OWNER,
  });
  const tagSetId = await artifact(x, 'x3lius.meta-tag-set/v1', 'x3lius-studio-editor', await run(x, 'x3lius-studio-editor', 'Creative'), {
    name: '[FIXTURE] tags', sections: [{ kind: 'verse', label: 'Verse', numbered: true, cues: ['Whispered'] }], notes: [], sources: [], ...OWNER,
  });
  for (const [part, id] of [['lyrics', lyricsId], ['recipe', recipeId], ['tags', tagSetId]] as const) {
    if (approve.includes(part)) await decideFixture(x, id);
  }

  const workflow = o.workflow ?? 'success';
  let workflowRunId: string | null = null;
  if (workflow !== 'none') {
    workflowRunId = (await x<{ id: string }[]>`
      insert into workflow_runs (workflow_name, spec_sha256, spec, input)
      values ('build-suno-package', ${'a'.repeat(64)}, '{}', '{}') returning id`)[0]!.id;
  }
  const packageRun = await run(x, 'x3lius-suno-package', 'Creative', workflowRunId, workflowRunId ? 'package' : null);
  if (workflowRunId) {
    await x`
      update workflow_runs
      set status = ${workflow}::workflow_run_status, completed_at = clock_timestamp(),
          failed_step = ${workflow === 'error' ? 'link' : null}, error_detail = ${workflow === 'error' ? '[FIXTURE] link failed' : null}
      where id = ${workflowRunId}`;
  }
  const prompt = { title, style: '[FIXTURE] dark melodic trap, 140 bpm', excludeStyles: ['[FIXTURE] country'], lyrics: '[Verse 1]\n[Whispered]\n[FIXTURE] neon on the wet street' };
  const packageId = await artifact(x, 'x3lius.suno-package/v1', 'x3lius-suno-package', packageRun, {
    sunoModel: 'v5', ...prompt,
    sources: [source('lyrics', lyricsId, 'x3lius.lyrics/v2'), source('style-recipe', recipeId, 'x3lius.style-recipe/v1'), source('meta-tag-set', tagSetId, 'x3lius.meta-tag-set/v1')],
    limits: [], rulesApplied: [], ungroundedChoices: [],
  });
  return { packageId, lyricsId, recipeId, tagSetId, workflowRunId, sunoModel: 'v5', prompt };
};

/**
 * A manual submission of a package, as suno-submitter records it.
 * @param x - connection or transaction
 * @param p - the package
 * @param adapter - manual (default) or sunoapi
 * @param providerTaskId - required for sunoapi
 * @returns the submission id
 */
export const insertSubmission = async (x: Exec, p: FixturePackage, adapter = 'manual', providerTaskId: string | null = null): Promise<string> =>
  (await x<{ id: string }[]>`
    insert into suno_submissions (formula_artifact_id, agent_run_id, adapter, suno_model, prompt, provider_task_id)
    values (${p.packageId}, ${await run(x, 'suno-submitter', 'Execution')}, ${adapter}, ${p.sunoModel}, ${x.json(p.prompt as postgres.JSONValue)}, ${providerTaskId})
    returning id`)[0]!.id;
