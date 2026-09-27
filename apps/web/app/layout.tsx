import './fonts.css';
import './globals.css';
import { logout } from './actions';
import { Icon, Mark } from './shell/icons';
import { NavLinks } from './shell/nav';
import { NavDrawer } from './shell/nav-drawer';
import { SofiaClock } from './shell/sofia-clock';

export const metadata = { title: 'XYP3RN Mercury · Artist OS' };

// The Mercury shell (AOS-04 design §13): top bar (mark, Vault search, Sofia clock, identity), the left rail
// (a drawer below 1280 px), and the page. A page adds its own right rail with <WithRail>. The inline script
// marks JS as available before first paint, so the rail only collapses into the drawer when the drawer works.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const owner = process.env.XYP_OWNER || 'owner';
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
      </head>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-raised focus:p-3">Skip to content</a>
        <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur-md">
          <div className="flex h-[72px] items-center gap-3 px-4 lg:gap-5 xl:px-5">
            <NavDrawer />
            <a href="/" className="flex shrink-0 items-center gap-2.5 no-underline" aria-label="XYP3RN Mercury, Command">
              <Mark />
              <span className="hidden flex-col leading-tight md:flex">
                <span className="font-display text-[15px] font-semibold tracking-[0.12em] text-ink-1">XYP3RN</span>
                <span className="text-[11px] uppercase tracking-[0.08em] text-ink-3">Mercury</span>
              </span>
            </a>
            <form action="/vault" method="get" role="search" className="mx-auto hidden w-full max-w-xl md:block">
              <label className="relative block">
                <span className="sr-only">Search the Vault</span>
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"><Icon name="search" className="h-4 w-4" /></span>
                <input name="q" type="search" placeholder="Search the Vault: lyrics, notes, findings…" title="Searches the Creative Vault. Search across every file arrives with the Plan C index." className="w-full pl-9" />
              </label>
            </form>
            <div className="ml-auto flex items-center gap-4">
              <SofiaClock initialEpochMs={Date.now()} />
              <div className="hidden items-center gap-2 text-sm text-ink-2 md:flex" title="Signed in (single owner, XYP_OWNER)">
                <Icon name="owner" className="h-5 w-5 text-ink-3" />
                <span>{owner}</span>
              </div>
              <form action={logout}><button className="btn-quiet">Log out</button></form>
            </div>
          </div>
        </header>
        <div className="grid gap-4 px-4 pb-10 pt-5 lg:grid-cols-[216px_minmax(0,1fr)] xl:grid-cols-[232px_minmax(0,1fr)] xl:gap-5 xl:px-5">
          <nav aria-label="Primary" className="lg:sticky lg:top-[92px] lg:self-start max-lg:[.js_&]:hidden">
            <NavLinks />
          </nav>
          <main id="main" className="min-w-0">{children}</main>
        </div>
      </body>
    </html>
  );
}
