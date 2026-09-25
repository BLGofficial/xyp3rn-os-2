import './globals.css';
import { logout } from './actions';

export const metadata = { title: 'XYP3RN Artist OS' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="mx-auto max-w-6xl px-4 py-6">
        <header className="mb-8 flex items-baseline justify-between border-b-4 border-records pb-2">
          <a href="/vault" className="text-lg font-bold uppercase tracking-widest no-underline">XYP3RN // Artist OS</a>
          <nav className="flex gap-6 text-sm uppercase tracking-widest">
            <a href="/vault">Vault</a>
            <a href="/songs">Songs</a>
            <a href="/ingest">Ingest</a>
            <form action={logout}><button className="px-2 py-0 text-xs">Out</button></form>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
