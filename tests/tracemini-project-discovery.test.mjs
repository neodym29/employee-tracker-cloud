import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('discovery control plane has a final-state schema without path or secret leakage', () => {
  const migration = read('migrations/020_tracemini_project_discovery.sql');
  assert.match(migration, /tracemini_scan_requests/);
  assert.match(migration, /tracemini_repository_candidates/);
  assert.match(migration, /tracemini_repository_selections/);
  assert.match(migration, /tracemini_repository_fingerprints/);
  assert.match(migration, /tracemini_pending_pushes/);
  assert.match(migration, /desired_tracking/);
  assert.match(migration, /revision/);
  assert.doesNotMatch(migration, /remote_url\s+text/i);
  assert.doesNotMatch(migration, /credential-bearing/i);
});

test('browser discovery UI uses the explicit Detect projects flow and safe candidate fields', () => {
  const page = read('app/projects/page.tsx');
  const component = read('app/components/TraceMiniProjectDiscovery.tsx');
  assert.doesNotMatch(page, /<TraceMiniProjectDiscovery/);
  assert.match(read('app/projects/ProjectsClient.tsx'), /<TraceMiniProjectDiscovery/);
  assert.match(component, />Detect projects</);
  assert.match(component, /Track|Stop tracking/);
  assert.match(component, /matched|unmatched|ambiguous/i);
  assert.doesNotMatch(component, /absolute path|local path/i);
});

test('discovery APIs separate authenticated browser scans from device work', () => {
  for (const path of [
    'app/api/tracemini/repository-scans/route.ts',
    'app/api/files-agent/work/route.ts',
    'app/api/files-agent/repository-candidates/route.ts',
    'app/api/files-agent/repository-selections/[candidateId]/claim/route.ts',
    'app/api/files-agent/repository-selections/[candidateId]/complete/route.ts',
  ]) assert.match(read(path), /export async function (GET|POST|PUT)|export \{ POST \}/);
  assert.match(read('lib/tracemini-discovery.ts'), /company_id|companyId/);
  assert.match(read('lib/tracemini-discovery.ts'), /revision/);
});

test('installer and projects page advertise install-once discovery', () => {
  const installer = read('files-agent/install.sh.template');
  const page = read('app/projects/page.tsx');
  const component = read('app/components/TraceMiniProjectDiscovery.tsx');
  assert.match(installer, /systemd|service/i);
  assert.match(installer, /discovery root/i);
  assert.doesNotMatch(page, /<TraceMiniProjectDiscovery/);
  assert.match(read('app/projects/ProjectsClient.tsx'), /<TraceMiniProjectDiscovery/);
  assert.match(component, /Detect projects/);
});
