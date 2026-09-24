import type { NextConfig } from 'next';

const config: NextConfig = {
  // @adpay/shared ships TypeScript source; Next compiles it with the app.
  transpilePackages: ['@adpay/shared'],
  reactStrictMode: true,
};

export default config;
