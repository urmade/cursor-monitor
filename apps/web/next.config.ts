import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: [
    '@cursor-monitor/core',
    '@cursor-monitor/db',
    '@cursor-monitor/team-api',
  ],
  serverExternalPackages: ['postgres'],
};

export default config;
