'use client';

import type { OrbState } from '../lib/voice-orb-state';
import './VoiceOrb.css';

export type OrbMode = 'signal' | 'voice' | 'speaking';
export type { OrbState };

/**
 * A small status orb. Pure SVG and CSS from this repo: no remote script, no injected HTML. `voice` is a breathing
 * core, `signal` rippling rings, `speaking` equalizer bars. Decorative (aria-hidden): the command bar and the header
 * pill carry the state in text.
 */
export function VoiceOrb({ mode = 'voice', state = 'idle', size = 28 }: { readonly mode?: OrbMode; readonly state?: OrbState; readonly size?: number }) {
  return (
    <span className="voice-orb" data-mode={mode} data-state={state} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 40 40" width={size} height={size}>
        {mode === 'speaking' ? [8, 15, 22, 29].map((x, i) => <rect key={x} className="vo-bar" style={{ animationDelay: `${i * 0.12}s` }} x={x} y="10" width="4" height="20" rx="2" />)
          : mode === 'signal' ? <><circle className="vo-ripple" cx="20" cy="20" r="6" /><circle className="vo-ripple vo-ripple-2" cx="20" cy="20" r="6" /><circle className="vo-core" cx="20" cy="20" r="5" /></>
          : <><circle className="vo-ring" cx="20" cy="20" r="16" /><circle className="vo-core" cx="20" cy="20" r="9" /></>}
      </svg>
    </span>
  );
}

export default VoiceOrb;
