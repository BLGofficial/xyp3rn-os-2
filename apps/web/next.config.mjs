import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  // Uploads arrive through a server action (/ingest): Next's 1 MB default would refuse a demo or a PDF.
  // instrumentation.ts is stable in Next 15 and sweeps abandoned research runs at boot.
  // middleware.ts sees every request, and Next buffers at most middlewareClientMaxBodySize (10 MB by default) of a
  // body for it: a larger upload reached the route cut short. Match the action limit; routes cap per file.
  experimental: { serverActions: { bodySizeLimit: '256mb' }, middlewareClientMaxBodySize: '256mb' },
};
export default nextConfig;
