import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright-core';
import { databaseUrl } from '../../../core/db/client.ts';
import { loadEmbedder } from '../../../knowledge/vector-retrieval/embedder.ts';
import { embedVault } from '../../../knowledge/vector-retrieval/pipeline.ts';
import { createTestDb, REPO_ROOT } from '../../../tests/helpers/db.ts';

// AOS-01/AOS-02 proof: the UI end to end in a real browser, against `next start` (run `pnpm --filter
// @xyp3rn/web build` first) on a throwaway migrated database and a temporary Vault store.
//   node apps/web/e2e/smoke.ts [screenshot dir]
// AOS-01: log in → create a song → upload a lyric sheet to it → see the lineage → approve v1 → find
// the line through vault search. AOS-02: upload the song's master → register it on a new release
// from the song → splits, credit, ISRC, UPC, artwork → schedule → delivery → released → platform
// link → task → the dashboard shows it released with nothing blocking. AOS-03: a style recipe → approve
// → the default tag set → an edit with cues → approve → the song builds a Suno package → hand off →
// upload Suno's audio as the take → rate it → the export and /studio show it traced. Prints one line
// per checked step; exits 1 on the first failure.

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
