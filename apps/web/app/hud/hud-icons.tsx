import type { HudIcon } from '../../lib/hud-theme';

// The HUD's inline SVG: the XYP3RN X-glyph (metallic gold, a specular band) and the domain medallion icons.

export const XGlyph = ({ size = 40, id = 'xg' }: { size?: number; id?: string }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-g`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#FFF1B8" /><stop offset="0.38" stopColor="#F7C948" /><stop offset="0.72" stopColor="#D4912A" /><stop offset="1" stopColor="#8A5A12" />
      </linearGradient>
      <linearGradient id={`${id}-s`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0.35" stopColor="#fff" stopOpacity="0" /><stop offset="0.5" stopColor="#fff" stopOpacity="0.55" /><stop offset="0.65" stopColor="#fff" stopOpacity="0" />
      </linearGradient>
    </defs>
    {/* Two angular blades crossing, cut with a notch at the centre. */}
    <path d="M4 4h11l9 13 9-13h11L29.5 24 44 44H33l-9-13-9 13H4l14.5-20z" fill={`url(#${id}-g)`} />
    <path d="M4 4h11l9 13 9-13h11L29.5 24 44 44H33l-9-13-9 13H4l14.5-20z" fill={`url(#${id}-s)`} className="hud-specular" />
  </svg>
);

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
