import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { databaseUrl } from '../../../core/db/client.ts';
import { loadEmbedder } from '../../../knowledge/vector-retrieval/embedder.ts';
import { embedVault } from '../../../knowledge/vector-retrieval/pipeline.ts';
import { createTestDb, REPO_ROOT } from '../../../tests/helpers/db.ts';

// AOS-01 proof: the UI end to end in a real browser, against `next start` (run `pnpm --filter
// @xyp3rn/web build` first) on a throwaway migrated database and a temporary Vault store.
//   node apps/web/e2e/smoke.ts [screenshot dir]
// Log in → create a song → upload a lyric sheet to it → see the lineage → approve v1 → find the
// line through vault search. Prints one line per checked step; exits 1 on the first failure.

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
