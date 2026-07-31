import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // @datung/shared ships raw .ts sources; Next must compile it.
  transpilePackages: ['@datung/shared'],
};

export default nextConfig;
