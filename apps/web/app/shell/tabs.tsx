// Tabs inside one navigation area (Jarvis Prompt 01, J2): plain links, so each tab keeps its own URL and works
// without JS; the current one is marked for assistive tech.
export const AreaTabs = ({ label, tabs, current }: { label: string; tabs: readonly { readonly href: string; readonly label: string }[]; current: string }) => (
  <nav aria-label={label} className="mb-2 flex gap-1 border-b border-line">
    {tabs.map((t) => (
      <a key={t.href} href={t.href} aria-current={t.href === current ? 'page' : undefined}
        className={`-mb-px flex min-h-[44px] items-center border-b-2 px-3 text-sm no-underline ${t.href === current ? 'border-mercury text-ink-1' : 'border-transparent text-ink-2 hover:text-ink-1'}`}>
        {t.label}
      </a>
    ))}
  </nav>
);

export const SONGS_RELEASES = [{ href: '/songs', label: 'Songs' }, { href: '/releases', label: 'Releases' }] as const;
