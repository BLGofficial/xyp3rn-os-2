'use client';
import { BrandSplash } from './brand/logo';

export default function RouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <BrandSplash title="Something went wrong">
      <p className="meta">This page failed to load. Nothing was changed.</p>
      <button type="button" onClick={reset}>Try again</button>
    </BrandSplash>
  );
}
