// Inline icons for the Mercury shell (AOS-04 design §13.1): drawn here, 24×24, stroke = currentColor,
// decorative (aria-hidden); every one sits beside a visible label.

const paths = {
  command: 'M4 13h6v7H4zM14 4h6v16h-6zM4 4h6v5H4z',
  studio: 'M9 18V6l10-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zm10-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3z',
  research: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4-4',
  vault: 'M4 7h16v13H4zM4 7l2-3h12l2 3M10 12h4',
  songs: 'M4 6h12M4 11h12M4 16h7M17 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm2-2V9',
  releases: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  tasks: 'M5 12l3 3 6-6M4 4h16v16H4z',
  people: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-6 9a6 6 0 0 1 12 0M17 11a3 3 0 1 0-2-5.2M21 20a5 5 0 0 0-4-4.9',
  ingest: 'M12 3v12m0 0-4-4m4 4 4-4M4 17v3h16v-3',
  analytics: 'M4 20V10m6 10V4m6 16v-8m4 8H2',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6 6 18',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4-4',
  owner: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0',
} as const;

export type IconName = keyof typeof paths;

export const Icon = ({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" focusable="false">
    <path d={paths[name]} />
  </svg>
);

/** The XYP3RN mark: a mercury double ring around the hub (the application identity, §13.2). */
export const Mark = () => (
  <svg viewBox="0 0 32 32" className="h-8 w-8" aria-hidden="true" focusable="false">
    <circle cx="16" cy="16" r="14" fill="none" stroke="#D8E6F7" strokeWidth="1.5" />
    <circle cx="16" cy="16" r="10.5" fill="none" stroke="#D8E6F7" strokeOpacity="0.45" strokeWidth="1" />
    <circle cx="16" cy="16" r="3.2" fill="#D8E6F7" />
  </svg>
);
