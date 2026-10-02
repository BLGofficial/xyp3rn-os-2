import type { HudIcon } from '../../lib/hud-theme';

// Domain medallions; application branding uses BrandLogo.

const PATHS: Record<HudIcon, string> = {
  star: 'M12 2l2.4 6.9H22l-6 4.5 2.3 7.1L12 16l-6.3 4.5L8 13.4 2 8.9h7.6z',
  brain: 'M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 1 5 3 3 0 0 0 4 4V3zm6 0a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-1 5 3 3 0 0 1-4 4V3z',
  book: 'M3 5c3-1.5 6-1.5 9 0v15c-3-1.5-6-1.5-9 0zm18 0c-3-1.5-6-1.5-9 0v15c3-1.5 6-1.5 9 0z',
  gear: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.5 4l2-1.6-2-3.5-2.4.9a7 7 0 0 0-1.9-1.1L15.8 4h-4l-.4 2.7a7 7 0 0 0-1.9 1.1l-2.4-.9-2 3.5 2 1.6a7 7 0 0 0 0 2.2l-2 1.6 2 3.5 2.4-.9a7 7 0 0 0 1.9 1.1l.4 2.7h4l.4-2.7a7 7 0 0 0 1.9-1.1l2.4.9 2-3.5-2-1.6a7 7 0 0 0 0-2.2z',
  note: 'M9 18a3 3 0 1 1-2-2.8V4l12-2v13a3 3 0 1 1-2-2.8V6.3L9 7.6z',
  shield: 'M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5z',
  dot: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
};

export const DomainIcon = ({ icon, color, size = 22 }: { icon: HudIcon; color: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path d={PATHS[icon]} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);
