import Image from 'next/image';
import logo from './xyp3rn-logo.png';

/** The approved artwork set inside a shaded orb. CSS depth, no WebGL context or frame loop. */
export function BrandLogo({ size = 48, priority = false }: { size?: number; priority?: boolean }) {
  return (
    <span className="brand-sphere" style={{ width: size, height: size }} aria-hidden="true">
      <Image src={logo} width={size} height={size} alt="" priority={priority} className="brand-sphere-art" />
      <span className="brand-sphere-glass" />
    </span>
  );
}

/** Full-size mark for loading, sign-in and dead-end screens: the same image, with a breathing gold aura behind it. */
export function BrandSplash({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <section className="brand-splash">
      <span className="brand-aura"><BrandLogo size={176} priority /></span>
      <h1>{title}</h1>
      {children}
    </section>
  );
}
