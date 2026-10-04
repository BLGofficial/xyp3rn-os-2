import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Read-only local preview probe. Never prints credentials or writes product data.
process.loadEnvFile(resolve('apps/web/.env.local'));
const label = process.argv[2] || 'after';
const out = resolve('docs/proofs/2026-10-03-sphere');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.XYP_CHROMIUM || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.hudDraws = 0;
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.hasAttribute('data-globe-r')) window.hudDraws++;
      return clear.apply(this, args);
    };
  });
  await page.goto('http://127.0.0.1:3100/login');
  await page.locator('input[name=token]').fill(process.env.XYP_WEB_TOKEN);
  await Promise.all([page.waitForURL(u => u.pathname !== '/login'), page.locator('button[type=submit]').click()]);
  await page.goto('http://127.0.0.1:3100/hud');
  await page.locator('[data-hud-globe] canvas').first().waitFor();
  await page.waitForTimeout(2500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const read = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const results = { label, environment: 'local Chrome headless, Next dev, existing preview database, 1600x1000', modes: {}, errors };
  await page.locator('summary[aria-label^="Owner menu"]').click();
  for (const mode of ['cinematic', 'calm', 'off']) {
    const control = page.getByRole('radio', { name: mode, exact: true });
    if (label === 'before') await control.focus().then(() => control.press('Space'));
    else await control.check();
    await page.waitForTimeout(500);
    const before = await read();
    const draws = await page.evaluate(() => window.hudDraws);
    await page.waitForTimeout(3000);
    const after = await read();
    results.modes[mode] = { draws: await page.evaluate(() => window.hudDraws) - draws, taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000), scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000) };
  }
  await page.locator('summary[aria-label^="Owner menu"]').click();
  await page.screenshot({ path: `${out}/${label}-hud-desktop.png` });
  results.desktop = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: innerHeight, scrollHeight: document.documentElement.scrollHeight }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/${label}-hud-mobile.png`, fullPage: true });
  results.mobile = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  results.reducedMotion = await page.locator('[data-hud-root]').getAttribute('data-motion');
  await writeFile(`${out}/${label}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
