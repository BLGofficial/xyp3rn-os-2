import type { MetadataRoute } from 'next';
import logo from './brand/xyp3rn-logo.png';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'XYP3RN Mercury · Artist OS',
    short_name: 'XYP3RN',
    start_url: '/',
    display: 'standalone',
    background_color: '#12121d',
    theme_color: '#12121d',
    icons: [{ src: logo.src, sizes: '1216x1220', type: 'image/png' }],
  };
}
