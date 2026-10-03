import { describe, expect, it } from 'vitest';
import { DOMAINS } from '../../../core/contracts/taxonomy.ts';
import { HUD_BEARING, HUD_DOMAIN, HUD_PANEL, HUD_STATUS, HUD_TEXT, levelAt, parseLens } from '../lib/hud-theme.ts';
import { DOMAIN_DIRECTION } from '../lib/sphere.ts';
import { contrast } from '../lib/tokens.ts';

describe('HUD theme', () => {
  it('every text tone reads at ≥ 4.5:1 on both the glass and the high-contrast panel', () => {
    const texts = [...Object.values(HUD_TEXT), ...Object.values(HUD_DOMAIN).map((d) => d.label), ...Object.values(HUD_STATUS).map((s) => s.color)];
    for (const bg of Object.values(HUD_PANEL)) for (const t of texts) expect(contrast(t, bg), `${t} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it("the orbit bearings point the same way as the sphere's sectors", () => {
    for (const d of DOMAINS) {
      const rad = (HUD_BEARING[d] * Math.PI) / 180;
      const v = DOMAIN_DIRECTION[d];
      // Bearing is clockwise from north: east is +x, north is +y on the sphere's front face.
      expect(Math.sign(Math.round(Math.sin(rad) * 100)), d).toBe(Math.sign(Math.round(v.x * 100)));
      expect(Math.sign(Math.round(Math.cos(rad) * 100)), d).toBe(Math.sign(Math.round(v.y * 100)));
    }
  });

  it('levels and lenses', () => {
    expect([0.5, 0.79, 0.8, 1.49, 1.5, 2.5, 4].map(levelAt)).toEqual(['Constellation', 'Constellation', 'System', 'System', 'Component', 'File', 'File']);
    expect(parseLens('RECORDS')).toBe('RECORDS');
    expect(parseLens('<script>')).toBe('GRAPH');
    expect(parseLens(undefined)).toBe('GRAPH');
  });
});
