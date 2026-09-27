'use client';

import { usePathname } from 'next/navigation';
import { Icon, type IconName } from './icons';

// Product navigation (AOS-04 design §13.1): icon + full label, the current page marked for assistive tech.
// A client component only for usePathname; it is server-rendered, so the links work without JS.

type Item = { readonly href: string; readonly label: string; readonly icon: IconName };
export const PRIMARY: readonly Item[] = [
  { href: '/', label: 'Command', icon: 'command' },
  { href: '/studio', label: 'Studio', icon: 'studio' },
  { href: '/research', label: 'Research', icon: 'research' },
  { href: '/vault', label: 'Creative Vault', icon: 'vault' },
  { href: '/songs', label: 'Songs', icon: 'songs' },
  { href: '/releases', label: 'Releases', icon: 'releases' },
  { href: '/tasks', label: 'Tasks', icon: 'tasks' },
];
export const SECONDARY: readonly Item[] = [
  { href: '/people', label: 'People', icon: 'people' },
  { href: '/ingest', label: 'Ingest', icon: 'ingest' },
];

const current = (path: string, href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));

const Link = ({ item, path }: { item: Item; path: string }) => {
  const on = current(path, item.href);
  return (
    <a
      href={item.href}
      aria-current={on ? 'page' : undefined}
      className={`flex min-h-[44px] items-center gap-3 rounded-control px-3 text-[14.5px] no-underline transition-colors duration-150 ${on ? 'bg-hover text-ink-1 shadow-[inset_2px_0_0_theme(colors.mercury)]' : 'text-ink-2 hover:bg-hover hover:text-ink-1'}`}
    >
      <Icon name={item.icon} />
      <span>{item.label}</span>
    </a>
  );
};

export function NavLinks() {
  const path = usePathname() ?? '/';
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-1">{PRIMARY.map((i) => <li key={i.href}><Link item={i} path={path} /></li>)}</ul>
      <p className="mt-5 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">More</p>
      <ul className="flex flex-col gap-1">
        {SECONDARY.map((i) => <li key={i.href}><Link item={i} path={path} /></li>)}
        <li>
          <span aria-disabled="true" className="flex min-h-[44px] cursor-not-allowed items-center gap-3 px-3 text-[14.5px] text-ink-3">
            <Icon name="analytics" />
            <span>Analytics <span className="block text-[11.5px]">not built yet (AOS-06)</span></span>
          </span>
        </li>
      </ul>
    </div>
  );
}
