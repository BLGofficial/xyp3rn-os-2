import { describe, expect, it } from 'vitest';
import { DOMAIN_META, DOMAINS } from '../../../core/contracts/taxonomy.ts';
import { ACCENT, BORDER, contrast, DOMAIN_LABEL, STATUS, SURFACE, TEXT } from './tokens.ts';

// AOS-04 Plan B, Task 1 (design §14): the Mercury tokens meet their contrast floors on every surface, so a
// page can't drop below them by picking a token. Measured on the flat token colours; glow never counts.

const surfaces = Object.entries(SURFACE);
const atLeast = (fg: Record<string, string>, floor: number) => {
  const failures: string[] = [];
  for (const [name, colour] of Object.entries(fg)) {
    for (const [s, bg] of surfaces) {
      const c = contrast(colour, bg);
      if (c < floor) failures.push(`${name} on ${s}: ${c.toFixed(2)}`);
    }
  }
  return failures;
};

describe('contrast', () => {
  it('is the WCAG 2.x ratio: 21 for white on black, symmetric, 1 for a colour on itself', () => {
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#607894', '#607894')).toBeCloseTo(1, 5);
  });
});

describe('the Mercury tokens (§14.1, §14.2)', () => {
  it('text, mercury, champagne, every status and every domain label read at 4.5:1 or more on every surface', () => {
    expect(atLeast({ ...TEXT, mercury: ACCENT.mercury, champagne: ACCENT.champagne, ...STATUS, ...DOMAIN_LABEL }, 4.5)).toEqual([]);
  });

  it('control borders, the focus ring and the canonical domain hues are 3:1 or more on every surface (UI boundaries, not text)', () => {
    const canonical = Object.fromEntries(DOMAINS.map((d) => [d, DOMAIN_META[d].color]));
    expect(atLeast({ control: BORDER.control, focus: ACCENT.focus, ...canonical }, 3)).toEqual([]);
  });

  it('the canonical Records red is not a text colour on the raised and hover surfaces (labels use the bright variant)', () => {
    expect(contrast(DOMAIN_META.RECORDS.color, SURFACE.surfaceHover)).toBeLessThan(4.5);
    expect(contrast(DOMAIN_LABEL.RECORDS, SURFACE.surfaceHover)).toBeGreaterThanOrEqual(4.5);
  });

  it('the subtle border is decorative only: below 3:1, so it is never the sole boundary of a control', () => {
    expect(contrast(BORDER.subtle, SURFACE.surface)).toBeLessThan(3);
  });

  it('has a label variant for exactly the six taxonomy domains, and never redefines a canonical hue', () => {
    expect(Object.keys(DOMAIN_LABEL).sort()).toEqual([...DOMAINS].sort());
    for (const d of DOMAINS) expect(DOMAIN_LABEL[d].toLowerCase()).not.toBe(DOMAIN_META[d].color.toLowerCase());
  });
});
