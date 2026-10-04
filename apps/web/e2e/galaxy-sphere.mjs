import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Static viewer acceptance only. No Galaxy backend, providers, scheduler or write endpoints.
const root = resolve('galaxy/viewer');
const out = resolve('docs/proofs/2026-10-03-sphere');
await mkdir(out, { recursive: true });
const files = { '/': ['index.html', 'text/html'], '/graph-data.js': ['graph-data.js', 'text/javascript'], '/xyp3rn-logo.png': ['xyp3rn-logo.png', 'image/png'] };
const server = createServer(async (req, res) => {
  const entry = files[req.url];
  if (req.method !== 'GET' || !entry) { res.writeHead(503); res.end(); return; }
  try { const body = await readFile(resolve(root, entry[0])); res.writeHead(200, { 'Content-Type': entry[1] }); res.end(body); }
  catch { res.writeHead(500); res.end(); }
});
await new Promise(r => server.listen(4799, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: process.env.XYP_CHROMIUM || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4799');
  await page.waitForFunction(() => window.galaxy?.scene().getObjectByName('XYP3RN logo surface'), { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#boot')?.classList.contains('done'), { timeout: 60000 });
  const geometry = await page.evaluate(() => {
    const object = window.galaxy.scene().getObjectByName('XYP3RN logo surface');
    return { type: object.type, geometry: object.geometry.type, vertices: object.geometry.attributes.position.count, texture: object.material.map.image?.naturalWidth, lights: window.galaxy.scene().children.filter(x => x.isLight).map(x => x.type) };
  });
  if (geometry.type !== 'Mesh' || geometry.geometry !== 'SphereGeometry' || !geometry.texture) throw Error('Sphere or texture missing');
  await page.evaluate(() => window.galaxy.cameraPosition({ x: 0, y: 0, z: 520 }, { x: 0, y: 0, z: 0 }, 0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/galaxy-sphere-front.png` });
  await page.evaluate(() => window.galaxy.cameraPosition({ x: 340, y: 150, z: 430 }, { x: 0, y: 0, z: 0 }, 0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/galaxy-sphere-side.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/galaxy-sphere-mobile.png` });
  const result = { scope: 'Static viewer with repository graph-data.js; backend intentionally unavailable', geometry, errors };
  await writeFile(`${out}/galaxy.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) throw Error('Browser errors');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
