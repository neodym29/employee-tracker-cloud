import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    '/api/installers/collector-update': ['./build/tracemini/cli/index.js'],
    '/api/agents/*': ['./migrations/021_tracemini_node_install.sql'],
    '/api/agents/git/*': ['./migrations/021_tracemini_node_install.sql', './migrations/022_tracemini_node_git.sql', './migrations/023_tracemini_candidate_project_binding.sql', './migrations/027_tracemini_observer_receipts.sql', './migrations/030_codex_plugin_connections.sql', './migrations/031_codex_plugin_daily_summaries.sql', './migrations/032_codex_daily_summary_v2.sql', './migrations/033_codex_plugin_work_updates.sql', './migrations/034_codex_plugin_other_work.sql'],
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
