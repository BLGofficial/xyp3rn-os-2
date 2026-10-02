import Image from 'next/image';
import logo from './xyp3rn-logo.png';

/** Owner-approved artwork. Preserve the full image; provenance is in docs/BRAND.md. */
export function BrandLogo({ size = 48, priority = false }: { size?: number; priority?: boolean }) {
  return <Image src={logo} width={size} height={size} alt="" aria-hidden="true" priority={priority}
    className="shrink-0 object-contain" style={{ width: size, height: size }} />;
}

/** Full-size mark for loading, sign-in and dead-end screens: the same image, with a breathing gold aura behind it. */
export function BrandSplash({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <section className="brand-splash">
      <span className="brand-aura"><BrandLogo size={128} priority /></span>
      <h1>{title}</h1>
      {children}
    </section>
  );
}
