'use client';

import { usePathname } from 'next/navigation';
import { DOMAIN_FILTERS, DOMAIN_STYLE } from './domains';
import { Icon, type IconName } from './icons';

// Product navigation (AOS-04 design §13.1): icon + full label, the current page marked for assistive tech.
// A client component only for usePathname; it is server-rendered, so the links work without JS.

// Jarvis Prompt 01: the eight areas. Songs & Releases is one area (both routes, tabs on each page, J2).
type Item = { readonly href: string; readonly label: string; readonly icon: IconName; readonly also?: readonly string[] };
export const PRIMARY: readonly Item[] = [
  { href: '/', label: 'Command Center', icon: 'command' },
  { href: '/songs', label: 'Songs & Releases', icon: 'songs', also: ['/releases'] },
  { href: '/studio', label: 'Studio', icon: 'studio' },
  { href: '/tasks', label: 'Tasks & agents', icon: 'tasks' },
  { href: '/research', label: 'Research', icon: 'research' },
  { href: '/vault', label: 'Creative Vault', icon: 'vault' },
  { href: '/workflows', label: 'Workflow Builder', icon: 'workflow' },
  { href: '/analytics', label: 'Analytics', icon: 'analytics' },
  { href: '/system', label: 'System Admin', icon: 'system' },
];
export const SECONDARY: readonly Item[] = [
  { href: '/hud', label: 'Mercury HUD', icon: 'graph' },
  { href: '/search', label: 'Search everything', icon: 'search' },
  { href: '/people', label: 'People', icon: 'people' },
  { href: '/ingest', label: 'Ingest', icon: 'ingest' },
];

const under = (path: string, href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));
const current = (path: string, item: Item) => [item.href, ...(item.also ?? [])].some((h) => under(path, h));

const Link = ({ item, path }: { item: Item; path: string }) => {
  const on = current(path, item);
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
      <p className="mt-5 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">Domains</p>
      <ul className="flex flex-col gap-1" aria-label="Filter the graph by domain">
        {DOMAIN_FILTERS.map((d) => (
          <li key={d}>
            <a href={`/?domain=${d}`} className="flex min-h-[44px] items-center gap-3 rounded-control px-3 text-[14px] no-underline hover:bg-hover">
              <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full border ${DOMAIN_STYLE[d].cls}`}><Icon name={DOMAIN_STYLE[d].icon} className="h-3.5 w-3.5" /></span>
              <span className={DOMAIN_STYLE[d].cls.split(' ')[1]}>{DOMAIN_STYLE[d].label}</span>
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-5 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">More</p>
      <ul className="flex flex-col gap-1">
        {SECONDARY.map((i) => <li key={i.href}><Link item={i} path={path} /></li>)}
      </ul>
    </div>
  );
}
