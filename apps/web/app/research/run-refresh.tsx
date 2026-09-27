'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Refreshes a running run's workbench without costing the owner what they typed (AOS-04 design §17): every
// few seconds, only while the tab is visible, no field has focus, and every field on the page is empty.
// Rendered only while the run is running; the server's next render drops it once the run is sealed.
export function RunRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      const a = document.activeElement;
      if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) return;
      const typed = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('main input:not([type=hidden]):not([type=checkbox]), main textarea')].some((f) => f.value !== '');
      if (!typed) router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return <p className="meta">Running: this page refreshes every {seconds} s, and pauses while you are typing.</p>;
}
