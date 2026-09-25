import type { NextConfig } from 'next';

const config: NextConfig = {
  // @adpay/shared ships TypeScript source; Next compiles it with the app.
  transpilePackages: ['@adpay/shared'],
  reactStrictMode: true,
  // `npm run share` serves the dev server through a Cloudflare quick tunnel (*.trycloudflare.com);
  // Next 16 blocks dev assets requested from any other hostname unless it is listed here.
  allowedDevOrigins: ['*.trycloudflare.com'],
};

export default config;
