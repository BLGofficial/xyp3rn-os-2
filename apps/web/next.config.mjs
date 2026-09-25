import path from 'node:path';
export default {
  outputFileTracingRoot: path.resolve(import.meta.dirname, '../..'),
  serverExternalPackages: ['postgres', '@huggingface/transformers', '@anthropic-ai/sdk', 'onnxruntime-node'],
  devIndicators: false,
  poweredByHeader: false,
  async headers() { return [{ source: '/:path*', headers: [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'same-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ] }]; },
};
