import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    '/api/files-agent/package': [
      './files-agent/files_agent.py',
      './files-agent/README.md',
      './files-agent/manifest.json',
    ],
  },
};

export default nextConfig;
