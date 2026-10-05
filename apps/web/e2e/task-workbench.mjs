import { chromium } from 'playwright-core';
import { loadEnvFile } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { issueSession } from '../lib/session.ts';

loadEnvFile('apps/web/.env.local');
const base = process.env.TASK_URL || 'http://127.0.0.1:3100';
const out = 'docs/proofs/2026-10-04-tasks';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.XYP_CHROMIUM || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
await context.addCookies([{ name: 'xyp_session', value: await issueSession(process.env.XYP_WEB_TOKEN, Date.now()), url: base }]);
const page = await context.newPage();
const errors = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
const check = (ok, name) => { assert.ok(ok, name); checks.push(name); };
try {
  await page.goto(`${base}/tasks`);
  await page.getByText('Loading music knowledge…').waitFor({ state: 'hidden' });
  const available = await page.locator('.task-knowledge-row').count();
  check(available > 0, 'Real indexed music knowledge loads');
  check(await page.getByRole('button', { name: 'Start workflow' }).isDisabled(), 'Empty brief cannot execute');
  await page.getByLabel('Your brief', { exact: true }).fill('A small chorus about starting over');
  const boxes = page.locator('.task-knowledge-row input');
  for (let i = 0; i < Math.min(6, available); i++) await boxes.nth(i).check();
  if (available > 6) check(await boxes.nth(6).isDisabled(), 'Knowledge combinations capped at six');
  await page.getByRole('searchbox', { name: 'Search music knowledge' }).fill('no-matching-knowledge-123');
  check(await page.getByText('No sources match this search.').isVisible(), 'Knowledge search has an honest empty state');
  check(await page.locator('.task-selected button').count() === Math.min(6, available), 'Selections survive knowledge filtering');
  await page.getByRole('searchbox', { name: 'Search music knowledge' }).fill('');
  await page.screenshot({ path: `${out}/tasks-desktop.png`, fullPage: true });
  // Exercise failed and successful UI responses without invoking providers.
  await page.route('**/api/tasks', async route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture: task refused.' }) });
    return route.continue();
  });
  await page.getByRole('button', { name: 'Start workflow' }).click();
  await page.getByRole('alert').filter({ hasText: 'Fixture: task refused.' }).waitFor();
  check(await page.getByLabel('Your brief', { exact: true }).inputValue() === 'A small chorus about starting over', 'Failed launch preserves brief and selections');
  await page.unroute('**/api/tasks');
  while (await page.locator('.task-selected button').count()) await page.locator('.task-selected button').first().click();
  await page.getByRole('button', { name: /Agent work/ }).click();
  // No scope keywords: actual endpoint and job store, clarification only; no model or tool calls.
  await page.getByLabel('Your brief', { exact: true }).fill('zzzz');
  await page.getByRole('button', { name: 'Start workflow' }).click();
  const receipt = page.getByRole('link', { name: 'Open result and run status →' });
  await receipt.waitFor();
  check((await receipt.getAttribute('href')).startsWith('/ask/'), 'Actual launch returns an existing result route');
  await receipt.click();
  await page.getByText(/no TECH component matched/).waitFor();
  check(true, 'Real task result explains clarification without pretending execution succeeded');
  await page.goto(`${base}/tasks?prepare=Saved%20task%20brief`);
  check(await page.getByLabel('Your brief', { exact: true }).inputValue() === 'Saved task brief', 'Saved tasks can prepare a reviewed executable brief');
  await page.locator('select').first().selectOption('wispr-flow');
  check(await page.getByText('Focus the brief, dictate with Wispr Flow, then review and start.').isVisible(), 'Wispr Flow uses focused editable input and explicit start');
  await page.locator('select').first().selectOption('microphone');
  await page.getByText('Checking microphone transcription…').waitFor({ state: 'hidden' });
  check(await page.getByRole('button', { name: 'Record command' }).count() === 1, 'Microphone control reflects existing transcription configuration');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/tasks-mobile.png`, fullPage: true });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px task workspace has no horizontal overflow');
  await page.getByRole('button', { name: /Write lyrics/ }).focus();
  check(await page.getByRole('button', { name: /Write lyrics/ }).evaluate(el => getComputedStyle(el).outlineStyle !== 'none'), 'Task choices have visible keyboard focus');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/hud`);
  check(await page.getByRole('link', { name: 'Task list ↗', exact: true }).isVisible(), 'HUD exposes a visible Task list button');
  await page.screenshot({ path: `${out}/hud-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/hud-mobile.png` });
  await page.goto('http://127.0.0.1:4700/?mute=1');
  check(await page.getByRole('link', { name: 'Task list ↗', exact: true }).getAttribute('href') === `${base}/tasks`, 'Galaxy links to the same authenticated task workspace');
  await page.screenshot({ path: `${out}/galaxy-mobile.png` });
  check(errors.length === 0, 'No browser runtime errors');
} finally {
  await writeFile(`${out}/browser-results.json`, JSON.stringify({ scope: 'Live local UI and read-only knowledge; one real in-memory clarification request, one intercepted error. No provider execution or real microphone capture.', checks, errors }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ checks: checks.length, errors }, null, 2));
