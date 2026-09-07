import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    '/api/agents/*': ['./migrations/021_tracemini_node_install.sql'],
    '/api/agents/install/*': ['./migrations/021_tracemini_node_install.sql'],
    '/api/installers/linux/*': ['./build/tracemini/cli/*.js', './migrations/021_tracemini_node_install.sql'],
    '/api/files-agent/package': [
      './files-agent/files_agent.py',
      './files-agent/README.md',
      './files-agent/manifest.json',
    ],
  },
};

export default nextConfig;
