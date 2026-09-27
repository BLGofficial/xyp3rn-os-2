'use client';

import { useRef } from 'react';
import { Icon } from './icons';
import { NavLinks } from './nav';

// Below 1280 px the rail becomes this drawer (AOS-04 design §13.3). A modal <dialog>: showModal() traps
// focus, Escape closes it, and focus returns to the button that opened it. Progressive enhancement: the
// button and the rail's hiding both depend on the `js` class, so without JS the rail stays a plain nav.
export function NavDrawer() {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => dialog.current?.close();
  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => dialog.current?.showModal()}
        aria-label="Open navigation"
        aria-haspopup="dialog"
        className="btn-quiet hidden max-lg:[.js_&]:inline-flex"
      >
        <Icon name="menu" />
      </button>
      <dialog
        ref={dialog}
        aria-label="Navigation"
        onClose={() => trigger.current?.focus()}
        onClick={(e) => e.target === dialog.current && close()}
        className="m-0 h-full max-h-none w-[min(300px,85vw)] border-r border-line bg-surface p-4 text-ink-1 backdrop:bg-canvas/70"
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Navigation</span>
          <button type="button" onClick={close} aria-label="Close navigation" className="btn-quiet">
            <Icon name="close" />
          </button>
        </div>
        <nav aria-label="Primary (drawer)" onClick={(e) => (e.target as HTMLElement).closest('a') && close()}>
          <NavLinks />
        </nav>
      </dialog>
    </>
  );
}
