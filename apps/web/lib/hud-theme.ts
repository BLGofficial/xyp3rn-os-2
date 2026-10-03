import type { Domain } from '../../../core/contracts/taxonomy.ts';

/**
 * The Mercury HUD's own theme (/hud only; F52). The rest of the app keeps the shell's tokens (tokens.ts): a HUD
 * palette at the source would restyle every page. Each domain has three tones: base (rims, dots), glow (bloom,
 * edges) and label (text, ≥ 4.5:1 on the HUD's glass; hud-theme.test.ts). A domain colour never means a status.
 */

export type HudOwner = Domain | 'shared';
export type Tones = { readonly base: string; readonly glow: string; readonly label: string };

export const HUD_DOMAIN: Readonly<Record<HudOwner, Tones & { readonly title: string; readonly tagline: string; readonly icon: HudIcon }>> = {
  CORE: { base: '#FFB020', glow: '#FFD166', label: '#FFE3A3', title: 'Core', tagline: 'Orchestrate · Execute · Scale', icon: 'star' },
  RESEARCH_INTELLIGENCE: { base: '#00E5D4', glow: '#5CFFF0', label: '#A8FFF7', title: 'Research Intelligence', tagline: 'Discover · Verify · Advance', icon: 'brain' },
  KNOWLEDGE: { base: '#2F7BFF', glow: '#6FA8FF', label: '#B8D4FF', title: 'Knowledge Layer', tagline: 'Collect · Organize · Retrieve', icon: 'book' },
  TECH: { base: '#9D4DFF', glow: '#C08BFF', label: '#DEC7FF', title: 'XYP3RN Tech', tagline: 'Build · Innovate · Deploy', icon: 'gear' },
  RECORDS: { base: '#FF2E5B', glow: '#FF6B8A', label: '#FFB3C3', title: 'XYP3RN Records', tagline: 'Music · Culture · No limits', icon: 'note' },
  GOVERNANCE: { base: '#1FDB7A', glow: '#6BF0A8', label: '#B5F7D2', title: 'Governance', tagline: 'Trust · Control · Longevity', icon: 'shield' },
  shared: { base: '#7F93AD', glow: '#9AAFC7', label: '#C9D6E6', title: 'Shared', tagline: 'Unassigned', icon: 'dot' },
};

export type HudIcon = 'star' | 'brain' | 'book' | 'gear' | 'note' | 'shield' | 'dot';

/** Orbit bearings, clockwise from north (the sphere's §13.2 sectors; hud-theme.test.ts checks they agree). */
export const HUD_BEARING: Readonly<Record<Domain, number>> = {
  CORE: 0, KNOWLEDGE: 60, GOVERNANCE: 120, RECORDS: 180, TECH: 240, RESEARCH_INTELLIGENCE: 300,
};
export const ORBIT_ORDER: readonly Domain[] = ['CORE', 'KNOWLEDGE', 'GOVERNANCE', 'RECORDS', 'TECH', 'RESEARCH_INTELLIGENCE'];

/** Status is its own channel: always a word and a glyph. */
export const HUD_STATUS = {
  ok: { color: '#6EE7B7', glyph: '✓' },
  warning: { color: '#FCD34D', glyph: '!' },
  failure: { color: '#FF8FA3', glyph: '✕' },
  info: { color: '#93C5FD', glyph: '•' },
} as const;

export const HUD_TEXT = { primary: '#F4F8FF', secondary: '#C3D0E4', muted: '#8FA3BF' } as const;
/** The glass panel composited over the page background (what text actually sits on), and the high-contrast panel. */
export const HUD_PANEL = { glass: '#0A1529', opaque: '#0A1426' } as const;
export const HUD_GOLD = { hi: '#FFF1B8', mid: '#F7C948', low: '#D4912A', deep: '#8A5A12' } as const;

/** Lens tabs: the whole graph, three kinds, and the six domains (a domain tab turns the globe to its sector). */
export const LENSES = ['GRAPH', 'AGENTS', 'WORKFLOWS', 'KNOWLEDGE', 'RESEARCH', 'RECORDS', 'TECH', 'GOVERNANCE'] as const;
export type Lens = (typeof LENSES)[number];
export const LENS_DOMAIN: Partial<Record<Lens, Domain>> = { KNOWLEDGE: 'KNOWLEDGE', RESEARCH: 'RESEARCH_INTELLIGENCE', RECORDS: 'RECORDS', TECH: 'TECH', GOVERNANCE: 'GOVERNANCE' };
export const parseLens = (v: string | undefined): Lens => ((LENSES as readonly string[]).includes(v ?? '') ? (v as Lens) : 'GRAPH');

/** Semantic zoom levels (the thresholds are the lower bounds). */
export const ZOOM = { min: 0.5, max: 4, fit: 1 } as const;
export const LEVELS = [
  { name: 'Constellation', from: 0.5 },
  { name: 'System', from: 0.8 },
  { name: 'Component', from: 1.5 },
  { name: 'File', from: 2.5 },
] as const;
export const levelAt = (z: number) => [...LEVELS].reverse().find((l) => z >= l.from)?.name ?? 'Constellation';
