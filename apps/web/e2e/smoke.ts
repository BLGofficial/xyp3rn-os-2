import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright-core';
import { createAgentRegistry } from '../../../core/agent-registry/registry.ts';
import { databaseUrl } from '../../../core/db/client.ts';
import { createLlmRunner } from '../../../core/llm/runner.ts';
import { dispatch } from '../../../core/orchestrator/dispatch.ts';
import { HANDLERS } from '../../../core/runtime/handlers.ts';
import { LLM_PROGRAMS } from '../../../core/runtime/programs.ts';
import { createRuntimeTools } from '../../../core/runtime/tools.ts';
import { loadEmbedder } from '../../../knowledge/vector-retrieval/embedder.ts';
import { embedVault } from '../../../knowledge/vector-retrieval/pipeline.ts';
import { executeResearch, openResearch } from '../../../research-intelligence/entrypoint.ts';
import { createTestDb, REPO_ROOT } from '../../../tests/helpers/db.ts';
import { FAKE_KEYS, fakeModel } from '../../../tests/helpers/fake-llm.ts';

// AOS-01/AOS-02 proof: the UI end to end in a real browser, against `next start` (run `pnpm --filter
// @xyp3rn/web build` first) on a throwaway migrated database and a temporary Vault store.
//   node apps/web/e2e/smoke.ts [screenshot dir]
// AOS-01: log in → create a song → upload a lyric sheet to it → see the lineage → approve v1 → find
// the line through vault search. AOS-02: upload the song's master → register it on a new release
// from the song → splits, credit, ISRC, UPC, artwork → schedule → delivery → released → platform
// link → task → the dashboard shows it released with nothing blocking. AOS-03: a style recipe → approve
// → the default tag set → an edit with cues → approve → the song builds a Suno package → hand off →
// upload Suno's audio as the take → rate it → the export and /studio show it traced. AOS-04: a brief run
// to completion in this process (FAKE MODEL, stubbed page; the server has no key) and linked to the song →
// /research lists it → the run page shows the quote → accept → the library shows canonical: none → promote
// → pending → approve → promoted → the song's Research section → a brief with no specialist picked is refused
// → a brief no specialist matches runs in the background and ends success. AOS-04 Plan B: the Sofia clock
// synced to /api/time, the four metric cards, aria-current, reduced motion, the drawer at 1024 px, no sideways
// scroll at 390 px, and (with a screenshot dir) four viewports + 200% zoom. AOS-04 Plan C1: the boot scan indexed
// this checkout; /system shows its counts; search finds a file past the first page; the viewer opens it by opaque id
// and escapes markup; Why connected? names file and line; a workflow step, a retracted link, the research chain and
// a finding's inherited targets; the domain filter and the Creative lens. Prints one line per checked step;
// exits 1 on the first failure.

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'aos01-smoke-token-0123456789';
const shots = process.argv[2];

const check = (ok: boolean, what: string) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`ok  ${what}`);
};
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
};
/**
 * Submits a form that redirects back to the same page, then waits for the outcome itself: `until`
 * (a selector only the new state matches) or the refusal banner, which fails the run.
 */
const submit = async (page: Page, form: Locator, until: string) => {
  await form.locator('button').last().click();
  await page.waitForSelector(`${until}, p.error`);
  const refused = await page.$('p.error');
  if (refused) throw new Error(`FAILED: refused: ${await refused.textContent()}`);
};
/** A decide form has Approve and Reject: click Approve, then wait as `submit` does. */
const approveIn = async (page: Page, form: Locator, until: string) => {
  await form.locator('button[value=approve]').click();
  await page.waitForSelector(`${until}, p.error`);
  const refused = await page.$('p.error');
  if (refused) throw new Error(`FAILED: refused: ${await refused.textContent()}`);
};
/** One second of 8 kHz 16-bit mono; `fill` makes different recordings different bytes (the master is silence). */
const wav = (fill = 0): Buffer => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + 16000, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(16000, 40);
  return Buffer.concat([h, Buffer.alloc(16000, fill)]);
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
/** A fixture UPC-A: an 11-digit base in an unused range plus its GS1 check digit. */
const fixtureUpc = (base: string): string => {
  const sum = [...base].reverse().reduce((t, d, i) => t + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return `${base}${(10 - (sum % 10)) % 10}`;
};

const db = await createTestDb('aos01_web_smoke', { migrated: true });
const vaultDir = mkdtempSync(join(tmpdir(), 'aos01-smoke-vault-'));
const url = new URL(databaseUrl());
url.pathname = `/${db.name}`;
const server = spawn(join(REPO_ROOT, 'apps', 'web', 'node_modules', '.bin', 'next'), ['start', '-H', '127.0.0.1', '-p', String(PORT)], {
  cwd: join(REPO_ROOT, 'apps', 'web'),
  env: { ...process.env, XYP_DATABASE_URL: url.toString(), XYP_VAULT_DIR: vaultDir, XYP_WEB_TOKEN: TOKEN, XYP_OWNER: 'owner (smoke)' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const browser = await chromium.launch({ executablePath: process.env.XYP_CHROMIUM ?? '/opt/pw-browsers/chromium' });

try {
  for (let i = 0; ; i++) {
    try {
      await fetch(`${BASE}/login`);
      break;
    } catch {
      if (i > 60) throw new Error(`next start did not come up:\n${serverLog}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const page = await browser.newPage();

  await page.goto(`${BASE}/vault`);
  await page.waitForURL(`${BASE}/login?next=%2Fvault`);
  check(true, 'without a session, /vault answers 401 and sends the browser to /login on the same host');
  check((await fetch(`${BASE}/vault/files/00000000-0000-4000-8000-000000000000/raw`)).status === 401, 'the raw file route is guarded too (401)');
  await page.fill('input[name=token]', 'a-wrong-token-of-enough-length');
  await page.click('button[type=submit]');
  const refusal = await page.waitForSelector('p.error', { timeout: 10_000 }).then((e) => e.textContent()).catch(async (e) => `${String(e)} @ ${page.url()}: ${await page.textContent('body')}`);
  check(refusal?.includes('wrong token') === true, `a wrong token is refused (${refusal})`);
  await page.fill('input[name=token]', TOKEN);
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE}/vault`);
  check(true, 'the token opens a session and lands on /vault');
  await shot(page, '1-vault-empty');

  await page.goto(`${BASE}/songs`);
  await page.fill('input[name=title]', '[FIXTURE] Night City');
  await page.fill('input[name=language]', 'en');
  await page.click('form button[type=submit]');
  await page.waitForURL(/\/songs\/[0-9a-f-]{36}$/);
  const songId = page.url().split('/').pop()!;
  check((await page.textContent('h1')) === '[FIXTURE] Night City', 'a song is created (records-songs) and opens');

  await page.goto(`${BASE}/ingest`);
  await page.setInputFiles('input[name=files]', {
    name: 'night-city.txt', mimeType: 'text/plain',
    buffer: Buffer.from('[Verse 1]\nNeon bleeding on the glass\nSodium lamps and a midnight train\n\n[Chorus]\nWe run the city till the morning breaks\n'),
  });
  await page.selectOption('select[name=as]', 'lyric_sheet');
  await page.fill('input[name=language]', 'en');
  await page.selectOption('select[name=songId]', songId);
  await page.click('form button[type=submit]');
  await page.waitForURL(/\/vault\/lineages\/[0-9a-f-]{36}/);
  const lineageId = new URL(page.url()).pathname.split('/').pop()!;
  check((await page.textContent('pre'))?.includes('Neon bleeding on the glass') === true, 'the uploaded lyric sheet became a lineage (vault-curator → x3lius-lyric-editor) and opens');
  check((await page.textContent('table tbody tr'))?.includes('draft') === true, 'v1 is a draft until the owner decides');
  await shot(page, '2-lineage-draft');

  await page.fill('input[name=reason]', 'the first take is the one');
  await page.click('button[value=approve]');
  // Same URL before and after: wait for the outcome itself, a decision or a refusal.
  await page.waitForSelector('td .status-approved, p.error');
  const row = `${await page.textContent('table tbody tr')} ${(await page.$('p.error')) ? await page.textContent('p.error') : ''}`;
  check(row.includes('approved') && row.includes('◆') && row.includes('owner (smoke)'), `approve records the owner's decision; v1 is marked approved (${row.trim()})`);
  await shot(page, '3-lineage-approved');

  await page.goto(`${BASE}/songs/${songId}`);
  check((await page.textContent('body'))?.includes('night-city.txt') === true, 'the song shows its lyric sheet file and its lyrics');

  const stats = await embedVault(db.sql, await loadEmbedder());
  check(stats.artifact.embedded === 1 && stats.source.embedded === 1, `pnpm embed indexed the version and the file (${JSON.stringify(stats)})`);
  await page.goto(`${BASE}/vault?q=${encodeURIComponent('sodium lamps and a midnight train')}`);
  const hit = await page.locator(`a[href="/vault/lineages/${lineageId}"]`).first().textContent();
  check(hit !== null, 'vault search finds the lyrics by a line');
  await shot(page, '4-vault-search');

  // AOS-02: the Command Center, from the song's master to a released single.
  const today = new Date().toISOString().slice(0, 10);
  const UPC = fixtureUpc('07000026002');
  await page.goto(`${BASE}/ingest`);
  await page.setInputFiles('input[name=files]', { name: 'night-city-master.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.selectOption('select[name=songId]', songId);
  await page.click('form button[type=submit]');
  await page.waitForURL(/\/vault\/files\/[0-9a-f-]{36}$/);
  check((await page.textContent('body'))?.includes('[FIXTURE] Night City') === true, 'the master is in the Vault, linked to the song');

  await page.goto(`${BASE}/people`);
  await page.fill('input[name=name]', 'X3LIUS');
  await submit(page, page.locator('form:has(input[name=name])'), 'td:text-is("X3LIUS")');
  check(true, 'a person is added (records-catalog)');

  await page.goto(`${BASE}/songs/${songId}`);
  await page.selectOption('select[name=recording]', { label: 'night-city-master.wav' });
  await page.click('button:text("Register on a new release")');
  await page.waitForURL(/\/releases\/[0-9a-f-]{36}$/);
  const releaseId = page.url().split('/').pop()!;
  const draft = (await page.textContent('body')) ?? '';
  check(draft.includes('the release has no artwork') && draft.includes('the track has no rights split set'),
    'the song\'s master is registered on a new draft single (register-track) and its blockers show');
  await shot(page, '5-release-draft');

  await page.fill('textarea[name=splits]', 'X3LIUS 100');
  await submit(page, page.locator('form:has(textarea[name=splits])'), 'h4:text("Splits v1")');
  await page.fill('article input[name=person]', 'x3lius');
  await page.selectOption('article select[name=role]', 'producer');
  await submit(page, page.locator('article form:has(input[name=person])'), 'li:has-text("X3LIUS · producer")');
  await page.fill('input[aria-label=ISRC]', 'XZA262600003');
  await submit(page, page.locator('form:has(input[aria-label=ISRC])'), 'code:text-is("XZA262600003")');
  await page.fill('input[aria-label=UPC]', UPC);
  await submit(page, page.locator('form:has(input[aria-label=UPC])'), `code:text-is("${UPC}")`);
  await page.setInputFiles('input[name=image]', { name: 'night-city-cover.png', mimeType: 'image/png', buffer: PNG });
  await submit(page, page.locator('form:has(input[name=image])'), 'figure img');
  check((await page.textContent('body'))?.includes('no open checks') === true, 'splits, a credit by case-insensitive name, ISRC, UPC and artwork clear every check');

  await page.fill('input[name=releaseDate]', today);
  await submit(page, page.locator('form:has(input[name=releaseDate])'), 'h1 + p .status-scheduled');
  check((await page.textContent('body'))?.includes('scheduled, but no distributor delivery is recorded') === true, 'schedule runs the Rights check and the calendar; the missing delivery shows');
  await page.fill('input[name=distributor]', 'DistroKid');
  await submit(page, page.locator('form:has(input[name=distributor])'), 'td:text-is("DistroKid")');
  await submit(page, page.locator('form:has(button:text("Mark released"))'), 'h1 + p .status-released');
  check((await page.textContent('body'))?.includes('released, but no platform link is recorded') === true, 'marked released; the missing platform link shows');
  const spotify = 'https://open.spotify.com/album/FIXTURE0NightCity000000';
  await page.selectOption('form:has(input[name=url]):not(:has(input[name=trackId])) select[name=platform]', 'spotify');
  await page.fill('form:has(input[name=url]):not(:has(input[name=trackId])) input[name=url]', spotify);
  await submit(page, page.locator('form:has(input[name=url]):not(:has(input[name=trackId]))'), `a[href="${spotify}"]`);
  check((await page.textContent('body'))?.includes('no open checks') === true, 'the platform link clears the last check');

  await page.fill('form:has(input[name=dueDate]) input[name=title]', 'Send the master to the mastering engineer');
  await submit(page, page.locator('form:has(input[name=dueDate])'), 'td:text-is("Send the master to the mastering engineer")');
  await page.fill('form:has(input[name=taskId]) input[name=note]', 'sent');
  await submit(page, page.locator('form:has(input[name=taskId])'), '.status-done');
  check(true, 'a task on the release is added and moved to done (records-tasks)');
  await shot(page, '6-release-released');

  await page.goto(`${BASE}/`);
  const releaseRow = await page.locator(`tr:has(a[href="/releases/${releaseId}"])`).first().textContent();
  check(releaseRow?.includes('released') === true && releaseRow.includes(today), `the dashboard shows the release released on its date (${releaseRow})`);
  check((await page.textContent('body'))?.includes('as of') === true, 'the dashboard shows the time it was read');
  await shot(page, '7-dashboard');

  // AOS-03: Studio, from a style recipe and a tag set to a rated take of the song, every version approved.
  await page.goto(`${BASE}/studio`);
  const recipeForm = page.locator('form:has(textarea[name=style])');
  await recipeForm.locator('input[name=name]').fill('[FIXTURE] Night drive');
  await recipeForm.locator('textarea[name=style]').fill('dark melodic trap, 140 bpm, male baritone, sodium-lit synths');
  await recipeForm.locator('input[name=excludeStyles]').fill('country, acoustic');
  await recipeForm.locator('textarea[name=notes]').fill('140 bpm keeps the hook tight');
  await recipeForm.locator('button').click();
  await page.waitForURL(/\/studio\/recipes\/[0-9a-f-]{36}$/);
  check((await page.textContent('h1')) === '[FIXTURE] Night drive' && (await page.textContent('pre'))?.includes('sodium-lit synths') === true, 'a style recipe is written (x3lius-studio-editor) as v1, a draft');
  const recipeLineageId = page.url().split('/').pop()!;
  await page.fill('form:has(button[value=approve]) input[name=reason]', 'the house sound');
  await approveIn(page, page.locator('form:has(button[value=approve])'), 'td .status-approved');
  check(true, 'the owner approves the recipe v1');

  await page.goto(`${BASE}/studio`);
  await page.click('button:text("Create the default tag set")');
  await page.waitForURL(/\/studio\/tags\/[0-9a-f-]{36}$/);
  check((await page.textContent('body'))?.includes('[Verse 1]') === true, 'the default tag set is the code labels (S2): verses numbered');
  await page.fill('form:has(input[name="cues:chorus"]) input[name=name]', '[FIXTURE] X3LIUS live');
  await page.fill('input[name="cues:chorus"]', 'Anthemic, Full band');
  await submit(page, page.locator('form:has(input[name="cues:chorus"])'), 'td:text-is("v2")');
  await page.fill('tr:has(td:text-is("v2")) input[name=reason]', 'cues for the live chorus');
  await approveIn(page, page.locator('tr:has(td:text-is("v2")) form'), 'td:text-is("v2 ◆")');
  check((await page.textContent('body'))?.includes('[Chorus] [Anthemic] [Full band]') === true, 'an edit with cues is v2 of the tag set, and the owner approves it');
  await shot(page, '8-tag-set');

  await page.goto(`${BASE}/songs/${songId}`);
  await submit(page, page.locator('form:has(select[name=lyricsArtifactId])'), 'h1');
  await page.waitForURL(/\/studio\/packages\/[0-9a-f-]{36}$/);
  const packageId = page.url().split('/').pop()!;
  const lyricsField = (await page.textContent('pre[data-field="Lyrics"]')) ?? '';
  check(lyricsField.includes('[Chorus]\n[Anthemic]\n[Full band]\nWe run the city till the morning breaks') && lyricsField.startsWith('[Verse 1]\nNeon bleeding on the glass'),
    'the song builds a Suno package (build-suno-package): the approved lyrics rendered with the tag set');
  check((await page.textContent('body'))?.includes('ready') === true, 'every version it names is approved, so the package is ready to hand off');
  await submit(page, page.locator('form:has(button:text("Hand off (manual)"))'), '[data-attempt]');
  check(true, 'the handoff is recorded as a manual submission (suno-submitter)');
  await page.setInputFiles('input[name=audio]', { name: 'night-city-suno-take-1.wav', mimeType: 'audio/wav', buffer: wav(1) });
  await page.fill('form:has(input[name=audio]) input[name=title]', 'Night City (take 1)');
  await submit(page, page.locator('form:has(input[name=audio])'), 'audio');
  check(true, 'Suno\'s audio is uploaded into the Vault and recorded as the attempt\'s take');
  await page.selectOption('form:has(input[name=takeId]) select[name=rating]', '5');
  await page.fill('form:has(input[name=takeId]) input[name=keep]', 'the baritone');
  await submit(page, page.locator('form:has(input[name=takeId])'), '.status-approved:text-is("5/5")');
  check((await page.textContent('body'))?.includes('keep: the baritone') === true, 'the owner rates the take 5/5 with what to keep');
  await shot(page, '9-package');

  const exported = await (await page.request.get(`${BASE}/studio/packages/${packageId}/export`)).json() as { format: string; ready: boolean; sources: { status: string }[]; workflow: { name: string } };
  check(exported.format === 'xyp-suno-package/v1' && exported.ready && exported.sources.every((x) => x.status === 'approved') && exported.workflow.name === 'build-suno-package',
    'the package export names every approved version and the workflow that built it');
  await page.goto(`${BASE}/studio`);
  const attemptRow = await page.locator(`tr:has(a[href="/studio/packages/${packageId}"])`).first().textContent();
  check(attemptRow?.includes('yes') === true && attemptRow.includes('[FIXTURE] Night City'), `the attempt is listed on /studio, traced (${attemptRow})`);

  // AOS-04: Research. The seeded run is the specialists' part (FAKE MODEL here, never in the server).
  const PAGE = '<html><head><title>[FIXTURE] Suno style order</title></head><body><p>[FIXTURE] Put the vocal descriptor first.</p></body></html>';
  const model = fakeModel({
    override: (schema) => ('claims' in ((schema.properties ?? {}) as object)
      ? { claims: [{ passage: 1, quote: 'Put the vocal descriptor first.', claim: '[FAKE] the vocal descriptor goes first', claim_topic: 'suno.vocal-descriptor-position', claim_value: '"first"', model_tag: 'suno-v5', confidence: 0.6, confidence_inputs: { basis: '[FAKE] one page', directness: 'direct' } }], declined: [] }
      : undefined),
  });
  const seedDeps = {
    sql: db.sql, registry: createAgentRegistry({ dir: join(REPO_ROOT, 'agents') }), handlers: HANDLERS,
    tools: createRuntimeTools({ sql: db.sql, env: {}, fetch: async () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } }) }),
    llmRunner: createLlmRunner({ programs: LLM_PROGRAMS, env: FAKE_KEYS, fetch: model.fn }),
  };
  const QUESTION = '[FIXTURE] Where should the vocal descriptor go in a Suno style prompt?';
  const opened = await openResearch(seedDeps, {
    projectSlug: 'smoke', question: QUESTION, intendedUse: '[FIXTURE] the Night drive recipe order', urls: ['https://example.org/suno-style-order'],
    specialists: ['suno-researcher'], targets: [{ kind: 'decision', decisionKey: 'F41' }],
  }, { requireIntendedUse: true });
  const linked = await dispatch(seedDeps, 'records-songs', { link: { songId, researchQuestionId: opened.questionId, role: 'research' } });
  const seeded = await executeResearch(seedDeps, opened.researchRunId, { log: () => {} });
  check(linked.status === 'success' && seeded.status === 'success', 'a brief linked to the song runs to completion (suno-researcher, FAKE MODEL, stubbed page)');

  await page.goto(`${BASE}/research`);
  const briefRow = await page.locator(`tr:has(a[href="/research/runs/${opened.researchRunId}"])`).first().textContent();
  check(briefRow?.includes('song: [FIXTURE] Night City') === true && briefRow.includes('decision: F41') && briefRow.includes('success'), `/research lists the brief with its targets and run (${briefRow})`);
  await page.click(`a[href="/research/runs/${opened.researchRunId}"]`);
  await page.waitForURL(`${BASE}/research/runs/${opened.researchRunId}`);
  const runBody = (await page.textContent('body')) ?? '';
  check(runBody.includes('suno.vocal-descriptor-position') && runBody.includes('“Put the vocal descriptor first.”') && runBody.includes('1 of 1 specialists finished'),
    'the run page shows the finding by topic, with the verbatim quote and its source');
  await shot(page, '10-research-run');
  await page.fill('form:has(button[value=accept]) input[name=reason]', 'matches the studio notes');
  await page.click('form:has(button[value=accept]) button[value=accept]');
  await page.waitForSelector('.status-accepted, p.error');
  check(!(await page.$('p.error')) && (await page.textContent('body'))?.includes('by owner (smoke)') === true, 'the owner accepts the finding into the Findings Library');

  await page.goto(`${BASE}/research/library`);
  check((await page.locator('article .status-none').count()) === 1, 'the library lists it with canonical: none (accepted is not canonical)');
  const promote = page.locator('form:has(input[name=targetSlug])');
  await promote.locator('input[name=title]').fill('Lead the style prompt with the vocal descriptor');
  await promote.locator('textarea[name=body]').fill('Put the vocal descriptor first in a Suno style prompt.');
  await submit(page, promote, 'article .status-candidate');
  check(true, 'promoting it makes a candidate (the gate queues it for the owner)');
  await page.goto(`${BASE}/research/runs/${opened.researchRunId}`);
  check((await page.locator('article .status-pending_approval').count()) === 1, 'the run page shows the canonical approval pending on the finding');
  await page.fill('form:has(button[value=approve]) input[name=reason]', 'make it canonical');
  await approveIn(page, page.locator('form:has(button[value=approve])'), '.status-promoted');
  await page.goto(`${BASE}/research/library`);
  check((await page.locator('article .status-promoted').count()) === 1, 'the owner approves: the library shows canonical: promoted');
  await shot(page, '11-research-library');

  await page.goto(`${BASE}/songs/${songId}`);
  check((await page.locator(`a[href="/research/runs/${opened.researchRunId}"]`).count()) > 0, 'the song\'s Research section links the brief and its finding');

  await page.goto(`${BASE}/research`);
  const briefForm = page.locator('form:has(textarea[name=intendedUse])');
  await briefForm.locator('textarea[name=question]').fill('[FIXTURE] How loud should the master be?');
  await briefForm.locator('textarea[name=intendedUse]').fill('[FIXTURE] mastering target');
  await briefForm.locator('input[name=override]').check();
  await briefForm.locator('button[type=submit]').click();
  await page.waitForSelector('p.error');
  check((await page.textContent('p.error'))?.includes('specialists: pick at least one') === true, 'a brief with the override ticked and nobody picked is refused, naming the field');

  const emptyForm = page.locator('form:has(textarea[name=intendedUse])');
  await emptyForm.locator('textarea[name=question]').fill('[FIXTURE] What should we eat tonight?');
  await emptyForm.locator('textarea[name=intendedUse]').fill('[FIXTURE] dinner');
  // F39: the refused form keeps what was typed and ticked, the override included.
  await emptyForm.locator('input[name=override]').uncheck();
  await emptyForm.locator('button[type=submit]').click();
  await page.waitForURL(/\/research\/runs\/[0-9a-f-]{36}$/);
  for (let i = 0; !(await page.textContent('body'))?.includes('no specialist selected') || (await page.locator('.status-running').count()) > 0; i++) {
    if (i > 20) throw new Error(`FAILED: the empty brief's run never ended: ${await page.textContent('body')}`);
    await new Promise((r) => setTimeout(r, 500));
    await page.reload();
  }
  check((await page.locator('p.meta .status-success').count()) === 1, 'a brief no specialist matches opens, runs in the background of next start, and ends success with no specialist selected');
  await shot(page, '12-research-empty');

  // AOS-04 Plan B: the Mercury shell. The clock, the metric strip, navigation, the drawer, 390 px, reduced motion.
  await page.goto(`${BASE}/`);
  await page.waitForSelector('[data-sync="server-synced"]', { timeout: 15_000 });
  const clock = (await page.textContent('header')) ?? '';
  check(clock.includes('Sofia, BG') && /\d{2}:\d{2}:\d{2}/.test(clock) && clock.includes('Server-synced'), 'the top bar shows the Sofia clock, synced to the server (Server-synced)');
  const t = await page.request.get(`${BASE}/api/time`);
  const epoch = ((await t.json()) as { epochMs: number }).epochMs;
  check(t.status() === 200 && Math.abs(epoch - Date.now()) < 60_000 && (await fetch(`${BASE}/api/time`)).status === 401, '/api/time answers the session with the server clock, and nobody else (401)');
  const cards = page.locator('[data-metric]');
  check((await cards.count()) === 4, 'the metric strip has four cards');
  for (let i = 0; i < 4; i++) {
    const text = (await cards.nth(i).textContent()) ?? '';
    check(text.includes('source:') && (await cards.nth(i).locator('time').count()) > 0 && !/unavailable/.test(text), `metric card ${i + 1} names its source and as-of time (${text.slice(0, 40)}…)`);
  }
  const [active] = await db.sql<{ n: number }[]>`select count(*)::int as n from current_songs where status::text in ('idea', 'writing', 'producing', 'releasing')`;
  const shown = Number(((await page.textContent('[data-metric="activeSongs"] p.num')) ?? '').trim().split(/\s/)[0]);
  check(shown === active!.n, `Active songs shows what the database holds at that moment (${shown} = ${active!.n})`);
  check((await page.textContent('nav[aria-label="Primary"] a[aria-current="page"]'))?.trim() === 'Command', 'the rail marks the current page (aria-current)');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const duration = await page.$eval('nav[aria-label="Primary"] a', (a) => getComputedStyle(a).transitionDuration);
  check(duration === '0s', `with reduced motion, transitions are off (${duration})`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`${BASE}/research`);
  check(!(await page.isVisible('nav[aria-label="Primary"]')), 'at 1024 px the rail is folded away');
  await page.click('button[aria-label="Open navigation"]');
  await page.waitForSelector('dialog[open]');
  check((await page.locator('dialog[open] a[aria-current="page"]').textContent())?.trim() === 'Research', 'the drawer opens with the current page marked');
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog[open]', { state: 'detached' }).catch(() => undefined);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  check(!(await page.isVisible('dialog[open]')) && focused === 'Open navigation', 'Escape closes the drawer and focus returns to its button');

  // AOS-04 Plan C1: the file index and the graph. next start scanned this checkout into the smoke's database at
  // boot; the journey's songs, lineages and research are live rows of the same graph.
  await page.setViewportSize({ width: 1440, height: 900 });
  let bootScan: { id: string; status: string; counts: { eligible: number; indexed: number; failed: number } } | undefined;
  for (const until = Date.now() + 60_000; Date.now() < until; await new Promise((r) => setTimeout(r, 250))) {
    [bootScan] = await db.sql<{ id: string; status: string; counts: { eligible: number; indexed: number; failed: number } }[]>`
      select id, status, counts from index_scans where trigger = 'boot' and status <> 'running' order by started_at desc limit 1`;
    if (bootScan) break;
  }
  check(bootScan?.status === 'success', `next start scanned the checkout at boot (scan ${bootScan?.id ?? 'none'}: ${bootScan?.status ?? 'not finished'})`);
  const bc = bootScan!.counts;
  await page.goto(`${BASE}/system`);
  const scanLine = await page.textContent('[data-scan-counts]');
  check(scanLine?.includes(`eligible ${bc.eligible} · indexed ${bc.indexed} · failed ${bc.failed}`) === true, `/system shows the scan's counts as index_scans holds them (${scanLine})`);

  await page.goto(`${BASE}/search?q=instrumentation-node`);
  const hitItem = page.locator('[data-search-group=file] li', { hasText: 'apps/web/instrumentation-node.ts' }).first();
  check((await hitItem.count()) === 1, '/search finds apps/web/instrumentation-node.ts in the whole index');
  await hitItem.locator('a:text("Open")').click();
  await page.waitForURL(/\/index\/files\/[0-9a-f-]{36}$/);
  const viewed = await page.textContent('main');
  check(viewed?.includes('(verified on open)') === true && (await page.textContent('pre'))?.includes("from './lib/server'") === true, 'the viewer opens it by its opaque index id, checksum verified, with its contents');

  await page.goto(`${BASE}/?node=${encodeURIComponent('file:repo/apps/web/instrumentation-node.ts')}`);
  const importRow = page.locator('[data-inspector] li', { hasText: 'apps/web/lib/server.ts' }).first();
  await importRow.locator('summary').click();
  const why = await importRow.textContent();
  check(why?.includes('imports') === true && why.includes('Declared in apps/web/instrumentation-node.ts:1'), `the inspector's Why connected? names the import's file and line (${why?.replace(/\s+/g, ' ').trim()})`);

  await page.goto(`${BASE}/node?id=${encodeURIComponent('workflow_step:retrieve-and-summarize#summarize')}`);
  const step = (await page.textContent('[data-inspector]'))?.replace(/\s+/g, ' ') ?? '';
  check(step.includes('step uses agent') && step.includes('extractive-summarizer') && step.includes('depends on') && step.includes('retrieve-and-summarize · retrieve'),
    'a workflow step shows the agent it uses and the step it depends on');

  const recipeLink = await dispatch(seedDeps, 'records-songs', { link: { songId, artifactId: recipeLineageId, role: 'recipe' } });
  await dispatch(seedDeps, 'records-songs', { unlink: { linkId: (recipeLink.output as { linkId: string }).linkId, reason: '[FIXTURE] not this recipe' } });
  await page.goto(`${BASE}/node?id=${encodeURIComponent(`songs:${songId}`)}`);
  const lyricRow = await page.locator(`[data-inspector] tr:has(a[href="/vault/lineages/${lineageId}"])`).first().textContent();
  const songInspector = await page.textContent('[data-inspector]');
  check(lyricRow?.includes('linked to') === true && songInspector?.includes('[FIXTURE] not this recipe') === true
    && (await page.locator(`[data-inspector] tr:has(a[href="/vault/lineages/${recipeLineageId}"])`).count()) === 0,
  'the song is linked to its lyrics; the retracted recipe link is in history with its reason, not in its connections');

  const [ev] = await db.sql<{ evidence: string; finding: string }[]>`
    select e.id as evidence, f.id as finding from research_evidence e join research_findings f on f.research_run_id = e.research_run_id where e.research_run_id = ${opened.researchRunId}`;
  await page.goto(`${BASE}/node?id=${encodeURIComponent(`research_evidence:${ev!.evidence}`)}`);
  const quoteRow = page.locator('[data-inspector] tr', { hasText: 'quotes' }).first();
  await quoteRow.locator('summary').click();
  const runRow = await page.locator(`[data-inspector] tr:has(a[href="/research/runs/${opened.researchRunId}"])`).first().textContent();
  check((await quoteRow.textContent())?.includes('Put the vocal descriptor first.') === true && runRow?.includes('produced by') === true,
    'evidence → the research source it quotes (the quote as proof) and the run that produced it');
  await page.goto(`${BASE}/node?id=${encodeURIComponent(`research_findings:${ev!.finding}`)}`);
  const finding = (await page.textContent('[data-inspector]'))?.replace(/\s+/g, ' ') ?? '';
  check(finding.includes('Inherited from brief') && finding.includes('F41') && finding.includes('[FIXTURE] Night City') && finding.includes('supported by'),
    "a finding shows its evidence, and its targets (F41, the song) only as inherited from the brief");

  await page.goto(`${BASE}/?domain=RECORDS`);
  const rows = await page.locator('[aria-label="Graph entities"] tbody tr').allTextContents();
  check(rows.length > 0 && rows.every((r) => r.includes('Records') && !r.includes('Core')), `/?domain=RECORDS lists only Records-owned entities (${rows.length} on page 1)`);
  const songCount = (await db.sql<{ n: number }[]>`select count(*)::int as n from songs`)[0]!.n;
  await page.goto(`${BASE}/?lens=creative`);
  const songsGroup = (await page.textContent('[data-lens-group=songs]'))?.replace(/\s+/g, ' ') ?? '';
  check(new RegExp(`^\\s*Songs\\s*${songCount}(?!\\d)`).test(songsGroup), `the Creative lens's Songs group counts the journey's songs (${songsGroup.trim()} = ${songCount})`);

  const bad = await page.goto(`${BASE}/index/files/not-a-uuid`);
  check(bad?.status() === 404, '/index/files/not-a-uuid is 404: the viewer takes an index id, never a path');
  const [layout] = await db.sql<{ id: string }[]>`select id from indexed_files where root = 'repo' and path = 'apps/web/app/layout.tsx'`;
  await page.goto(`${BASE}/index/files/${layout!.id}`);
  check((await page.locator('pre script').count()) === 0 && (await page.textContent('pre'))?.includes('<script') === true, "layout.tsx's <script> renders as text in the viewer, never as an element");
  const raw = await page.request.get(`${BASE}/index/files/${layout!.id}/raw`);
  check(raw.headers()['content-type']?.startsWith('text/plain') === true && raw.headers()['content-security-policy']?.startsWith('sandbox') === true && raw.headers()['x-content-type-options'] === 'nosniff',
    'the raw route serves text/plain with nosniff and a sandbox CSP');

  const narrow = [`/`, `/research`, `/research/runs/${opened.researchRunId}`, `/research/library`, `/songs/${songId}`, `/studio/packages/${packageId}`, `/studio`, `/vault`, `/releases`,
    `/search?q=night`, '/system', `/node?id=${encodeURIComponent(`songs:${songId}`)}`, `/?node=${encodeURIComponent('file:repo/apps/web/instrumentation-node.ts')}`, `/index/files/${layout!.id}`, '/?lens=creative'];
  await page.setViewportSize({ width: 390, height: 844 });
  const wide: string[] = [];
  for (const path of narrow) {
    await page.goto(`${BASE}${path}`);
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    if (sw! > iw!) wide.push(`${path} (${sw} > ${iw})`);
  }
  check(wide.length === 0, `at 390 px no page scrolls sideways (${wide.join(', ') || narrow.length + ' pages'})`);

  if (shots) {
    const views = [[1920, 1080], [1440, 900], [1024, 768], [390, 844]] as const;
    const pages = [['command', '/'], ['research', '/research'], ['run', `/research/runs/${opened.researchRunId}`], ['library', '/research/library'],
      ['inspector', `/?node=${encodeURIComponent('file:repo/apps/web/instrumentation-node.ts')}`], ['search', '/search?q=night'], ['system', '/system']] as const;
    for (const [w, h] of views) {
      await page.setViewportSize({ width: w, height: h });
      for (const [name, path] of pages) {
        await page.goto(`${BASE}${path}`);
        await shot(page, `13-${name}-${w}x${h}`);
      }
    }
    // 200% zoom, approximated by a 960×540 CSS viewport at device scale 2 (the pixels of a 1920×1080 screen).
    const zoom = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2, storageState: await page.context().storageState() });
    const zp = await zoom.newPage();
    for (const [name, path] of pages) {
      await zp.goto(`${BASE}${path}`);
      await shot(zp, `13-${name}-200pct`);
    }
    await zoom.close();
  }
  console.log('smoke: all checks passed');
} catch (e) {
  console.error((e as Error).message);
  if (serverLog) console.error(`--- next start log ---\n${serverLog.slice(-4000)}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await db.drop();
  rmSync(vaultDir, { recursive: true, force: true });
}
