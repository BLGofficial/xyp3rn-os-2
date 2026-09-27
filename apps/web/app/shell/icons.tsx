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
  // The six domains (§14.2): linked hexagon, book, lens, music note, circuit, shield; plus System and the graph.
  hexagon: 'M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9zM12 8v8M8.5 10l7 4M15.5 10l-7 4',
  book: 'M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h9',
  note: 'M9 18V5l10-2v13M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zm10-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3z',
  circuit: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
  shared: 'M8 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM10.5 10.5l3 3',
  system: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  graph: 'M6 6a2 2 0 1 0 0 .1M18 8a2 2 0 1 0 0 .1M12 18a2 2 0 1 0 0 .1M7.7 7l8.6 1M7 8l4 8.5M17 10l-4 6.5',
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
