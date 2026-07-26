import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: [
    '@nexus/contracts',
    '@nexus/core',
    '@nexus/cursor-client',
    '@nexus/db',
    '@nexus/jobs',
    '@nexus/mcp',
  ],
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
