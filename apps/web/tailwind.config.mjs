import { DOMAIN_META } from '../../core/contracts/taxonomy.ts';

/**
 * Modern brutalism (AOS-01 §9): mono type, hard rules, high contrast. Domain colors come from
 * core/contracts/taxonomy.ts, never redefined here; RECORDS red is the accent.
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0a0a0a',
        paper: '#f5f5f4',
        rule: '#3f3f46',
        records: DOMAIN_META.RECORDS.color,
        knowledge: DOMAIN_META.KNOWLEDGE.color,
        governance: DOMAIN_META.GOVERNANCE.color,
      },
      fontFamily: { mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'] },
    },
  },
  plugins: [],
};
