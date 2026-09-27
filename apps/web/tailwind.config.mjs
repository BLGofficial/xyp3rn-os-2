import { DOMAIN_META } from '../../core/contracts/taxonomy.ts';
import { ACCENT, BORDER, DOMAIN_LABEL, STATUS, SURFACE, TEXT } from './lib/tokens.ts';

/**
 * XYP3RN Mercury (AOS-04 design §14; decision M1 supersedes AOS-01's brutalism): graphite surfaces, mercury
 * accents, domain hues from core/contracts/taxonomy.ts (never redefined here), their label variants and the
 * status channel from lib/tokens.ts. The AOS-01 names (ink, paper, rule, records) map onto the new tokens
 * so every page restyles without edits.
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    // §13.3: 960 (single column below), 1280 (drawer below), 1600 (full three columns).
    screens: { md: '960px', lg: '1280px', xl: '1600px' },
    extend: {
      colors: {
        canvas: SURFACE.canvas,
        surface: SURFACE.surface,
        raised: SURFACE.surfaceRaised,
        hover: SURFACE.surfaceHover,
        line: BORDER.subtle,
        control: BORDER.control,
        'ink-1': TEXT.primary,
        'ink-2': TEXT.secondary,
        'ink-3': TEXT.muted,
        mercury: ACCENT.mercury,
        champagne: ACCENT.champagne,
        focus: ACCENT.focus,
        ok: STATUS.success,
        warn: STATUS.warning,
        fail: STATUS.failure,
        info: STATUS.info,
        unknown: STATUS.unknown,
        core: DOMAIN_META.CORE.color,
        knowledge: DOMAIN_META.KNOWLEDGE.color,
        research: DOMAIN_META.RESEARCH_INTELLIGENCE.color,
        records: DOMAIN_META.RECORDS.color,
        tech: DOMAIN_META.TECH.color,
        governance: DOMAIN_META.GOVERNANCE.color,
        'core-label': DOMAIN_LABEL.CORE,
        'knowledge-label': DOMAIN_LABEL.KNOWLEDGE,
        'research-label': DOMAIN_LABEL.RESEARCH_INTELLIGENCE,
        'records-label': DOMAIN_LABEL.RECORDS,
        'tech-label': DOMAIN_LABEL.TECH,
        'governance-label': DOMAIN_LABEL.GOVERNANCE,
        // AOS-01 names, kept so existing utility classes follow the new palette.
        ink: SURFACE.canvas,
        paper: TEXT.primary,
        rule: BORDER.subtle,
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', '"Segoe UI"', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk Variable"', '"Inter Variable"', 'Inter', '"Segoe UI"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'Consolas', 'ui-monospace', 'monospace'],
      },
      borderRadius: { panel: '14px', control: '10px' },
      boxShadow: { panel: '0 12px 40px #00000040, inset 0 1px 0 #D8E6F70F' },
    },
  },
  plugins: [],
};
