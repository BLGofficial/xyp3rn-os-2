/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Uploads arrive through a server action (/ingest): Next's 1 MB default would refuse a demo or a PDF.
  // AOS-04: instrumentation.ts sweeps research runs a stopped server left running (Next 14.2 needs the flag).
  experimental: { serverActions: { bodySizeLimit: '256mb' }, instrumentationHook: true },
};
export default nextConfig;
