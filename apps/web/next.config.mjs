/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Uploads arrive through a server action (/ingest): Next's 1 MB default would refuse a demo or a PDF.
  experimental: { serverActions: { bodySizeLimit: '256mb' } },
};
export default nextConfig;
