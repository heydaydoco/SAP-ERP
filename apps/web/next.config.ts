import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Transpile workspace packages consumed as TS source.
  transpilePackages: ['@erp/ui', '@erp/shared'],
  typescript: {
    // Types are enforced by `pnpm typecheck` in CI; keep build strict.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
