import { BrandSplash } from './brand/logo';

export default function NotFound() {
  return (
    <BrandSplash title="Not found">
      <p className="meta">Nothing lives at this address.</p>
      <a href="/">Back to Command</a>
    </BrandSplash>
  );
}
