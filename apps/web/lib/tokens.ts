import type { Domain } from '../../../core/contracts/taxonomy.ts';

/**
 * XYP3RN Mercury design tokens (AOS-04 design §14). The one source of the UI's colours: Tailwind
 * (tailwind.config.mjs) and the contrast test (tokens.test.ts) both read this module. Canonical domain hues
 * stay in core/contracts/taxonomy.ts; this adds only their brighter label variants for small text.
 */

export const SURFACE = {
  canvas: '#070B12',
  surface: '#0E1622',
  surfaceRaised: '#152233',
  surfaceHover: '#1B2D42',
} as const;

export const TEXT = {
  primary: '#F2F6FC',
  secondary: '#B4C3D6',
  // Timestamps and metadata; never faded further with opacity.
  muted: '#8FA4BC',
} as const;

export const BORDER = {
  // Decorative separators only: under 3:1, so never the sole boundary of a control.
  subtle: '#2B4058',
  control: '#607894',
} as const;

export const ACCENT = {
  mercury: '#D8E6F7',
  champagne: '#E7C98A',
  focus: '#A7D9FF',
} as const;

/** A separate channel from domain colour: always paired with a word (Records red never means failure). */
export const STATUS = {
  success: '#6EE7B7',
  warning: '#FCD34D',
  failure: '#FDA4AF',
  info: '#93C5FD',
  unknown: '#B4C3D6',
} as const;

/** Bright label/rim variants for small coloured text on dark surfaces; canonical hues are for rims and chips. */
export const DOMAIN_LABEL: Readonly<Record<Domain, string>> = {
  CORE: '#67E8F9',
  KNOWLEDGE: '#C4B5FD',
  RESEARCH_INTELLIGENCE: '#FCD34D',
  RECORDS: '#FDA4AF',
  TECH: '#6EE7B7',
  GOVERNANCE: '#CBD5E1',
};

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/**
 * WCAG 2.x contrast ratio of two opaque colours.
 * @param a - `#RRGGBB`
 * @param b - `#RRGGBB`
 * @returns the ratio, 1 to 21
 */
export const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
