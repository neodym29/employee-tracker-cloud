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

test('browser Node discovery uses explicit scans, selection and safe candidate fields', () => {
  const page = read('app/projects/page.tsx');
  const component = read('app/components/trace-node/RepositorySelection.tsx');
  assert.doesNotMatch(page, /<TraceMiniProjectDiscovery/);
  assert.match(read('app/trace-setup/page.tsx'), /<DesktopCliConnection/);
  assert.match(read('app/components/DesktopCliConnection.tsx'), /<Discovery\s*\/>/);
  assert.match(component, /Scan repositories on my devices/);
  assert.match(component, /role="switch"/);
  assert.match(component, /No unique authorized project match/);
  assert.match(component, /revision: candidate.revision/);
  assert.match(component, /Open existing project/);
  assert.doesNotMatch(component, /candidate\.(local_key|normalized_remote)|FilesAgentDownload|type="file"/);
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
  const installer = read('app/components/trace-node/Install.tsx');
  const page = read('app/projects/page.tsx');
  const component = read('app/components/trace-node/RepositorySelection.tsx');
  assert.match(installer, /automatically starts the namespaced background service/);
  assert.match(installer, /folders you approve/);
  assert.match(installer, /no ZIP upload is needed/);
  assert.match(installer, /explicit repository selection and device confirmation/);
  assert.doesNotMatch(page, /<TraceMiniProjectDiscovery/);
  assert.match(read('app/trace-setup/page.tsx'), /<DesktopCliConnection/);
  assert.match(component, /Scan repositories on my devices/);
  const route = read('app/api/agents/discovery/route.ts');
  for (const marker of ['requireApiSession', 'assertSameOrigin', 'boundedAgentJson', 'nodeBrowserDiscovery', 'nodeBrowserMutation']) assert.ok(route.includes(marker), marker);
});
