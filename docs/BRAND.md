# XYP3RN identity

The owner selected this artwork on 2026-10-02 as the official OS logo. Preserve the complete gold-and-black image, its proportions and its lettering. Do not substitute a drawn glyph, crop it, recolor it or generate a replacement without an explicit owner request.

- Source: [82CB070F-2EDB-4086-B3F2-BC51A80CCDAF.png](https://github.com/BLGofficial/xyp3rn-os-2/blob/4d606592631a0ee9c8fb0bc72ba0e750389a9b30/82CB070F-2EDB-4086-B3F2-BC51A80CCDAF.png).
- Git blob: `ed9591298fa52f012bb7a107db04d9144a4b8a15`.
- SHA-256: `41ef0ec029185361aea9b2370f373bfdfa4ec4d6ede59005b99ee6190c92fce7`.
- Web source: `apps/web/app/brand/xyp3rn-logo.png`; shared renderer: `BrandLogo`.
- Galaxy copy: `galaxy/viewer/xyp3rn-logo.png`. Galaxy's static server only serves files in this directory.

The Mercury header, HUD header, HUD hub, Galaxy header, Galaxy startup and the Jarvis core at the centre of the Galaxy (a whole-image sprite whose gold halo follows the status) use this image. Both applications declare it as their browser icon. The web build fingerprints the original asset and produces size-appropriate image responses; it does not fetch GitHub at runtime. Adjacent text or the parent link names decorative images for assistive technology.

Run `pnpm exec vitest run apps/web/tests/brand.test.ts` to check both stored copies against the approved bytes. Updating the checksum requires an explicit owner-approved artwork change; a test failure is not permission to replace it.
