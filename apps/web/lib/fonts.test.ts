import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../tailwind.config.mjs';

// AOS-04 Plan B, Task 2 (design §14.3, decision M2): the three families are locally hosted from pinned OFL
// packages, with font-display swap, Latin + Cyrillic where the family has it, a verified fallback where it
// doesn't, license notices, and no remote URL anywhere in the font CSS.

const WEB = join(import.meta.dirname, '..');
const FONTS = [
  { pkg: '@fontsource-variable/inter', css: ['index.css'], cyrillic: true },
  { pkg: '@fontsource-variable/space-grotesk', css: ['index.css'], cyrillic: false },
  { pkg: '@fontsource/ibm-plex-mono', css: ['400.css', '500.css'], cyrillic: true },
] as const;
const pkgDir = (pkg: string) => join(WEB, 'node_modules', pkg);
const read = (p: string) => readFileSync(p, 'utf8');

describe('the font packages (M2)', () => {
  it.each(FONTS)('$pkg is pinned at 5.3.0 and OFL-1.1', ({ pkg }) => {
    const deps = (JSON.parse(read(join(WEB, 'package.json'))) as { dependencies: Record<string, string> }).dependencies;
    expect(deps[pkg]).toBe('5.3.0');
    const meta = JSON.parse(read(join(pkgDir(pkg), 'package.json'))) as { version: string; license: string };
    expect(meta).toMatchObject({ version: '5.3.0', license: 'OFL-1.1' });
  });

  it.each(FONTS)('$pkg ships Latin, and Cyrillic exactly when the family has it', ({ pkg, cyrillic }) => {
    const files = readdirSync(join(pkgDir(pkg), 'files')).filter((f) => f.endsWith('.woff2'));
    expect(files.some((f) => /-latin-/.test(f))).toBe(true);
    expect(files.some((f) => /-cyrillic-/.test(f))).toBe(cyrillic);
  });

  it.each(FONTS)('$pkg: every @font-face it declares swaps, and none loads from a remote URL', ({ pkg, css }) => {
    for (const f of css) {
      const text = read(join(pkgDir(pkg), f));
      const faces = text.match(/@font-face\s*{[^}]*}/g) ?? [];
      expect(faces.length).toBeGreaterThan(0);
      for (const face of faces) expect(face).toMatch(/font-display:\s*swap/);
      expect(text).not.toMatch(/https?:\/\//);
    }
  });
});

describe('the app wiring', () => {
  it('fonts.css imports exactly the package stylesheets, and no remote URL', () => {
    const css = read(join(WEB, 'app', 'fonts.css'));
    const imports = [...css.matchAll(/@import\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(FONTS.flatMap((f) => f.css.map((c) => `${f.pkg}/${c}`)));
    expect(css).not.toMatch(/https?:\/\//);
  });

  it('the stacks are Inter for UI, Space Grotesk then Inter for headings (the Cyrillic fallback), Plex Mono for figures', () => {
    const ff = (config as { theme: { extend: { fontFamily: Record<string, string[]> } } }).theme.extend.fontFamily;
    expect(ff.sans![0]).toBe('"Inter Variable"');
    expect(ff.display!.slice(0, 2)).toEqual(['"Space Grotesk Variable"', '"Inter Variable"']);
    expect(ff.mono![0]).toBe('"IBM Plex Mono"');
  });

  it('FONT-NOTICES.md carries each package\'s copyright line and names the license', () => {
    const notices = read(join(WEB, 'FONT-NOTICES.md'));
    for (const { pkg } of FONTS) {
      const copyright = read(join(pkgDir(pkg), 'LICENSE')).split('\n').find((l) => /^Copyright/.test(l.trim()));
      expect(copyright, `${pkg} LICENSE has a copyright line`).toBeDefined();
      expect(notices).toContain(copyright!.trim());
      expect(notices).toContain(pkg);
    }
    expect(notices).toContain('SIL Open Font License, Version 1.1');
    expect(existsSync(join(WEB, 'app', 'fonts.css'))).toBe(true);
  });
});
