import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('projects onboarding visibly offers the installable desktop CLI', () => {
  const page = read('app/projects/page.tsx');
  const component = read('app/components/DesktopCliConnection.tsx');

  assert.doesNotMatch(page, /<DesktopCliConnection/);
  assert.match(read('app/projects/ProjectsClient.tsx'), /href="\/trace-setup"/);
  assert.match(read('app/trace-setup/page.tsx'), /<DesktopCliConnection\s*\/>/);
  assert.match(component, /<TraceNodeInstall\s*\/>/);
  assert.match(component, /<Discovery\s*\/>/);
  assert.doesNotMatch(component, /FilesAgentDownload|TraceMiniProjectDiscovery/);
  const install = read('app/components/trace-node/Install.tsx');
  assert.match(install, /\/agents\/installations/);
  assert.match(install, /employee-trace\.service/);
  assert.match(install, /folders you approve/);
  assert.match(install, /explicit repository selection/);
});

test('project workspace creates a server-derived one-time folder binding', () => {
  const workspace = read('app/projects/[projectId]/WorkspaceClient.tsx');
  const component = read('app/components/FilesAgentDownload.tsx');
  const service = read('lib/embedded-tracemini-ingest.ts');

  assert.match(workspace, /<DesktopCliConnection\s+projectId=\{projectId\}/);
  assert.match(component, /\/api\/projects\/\$\{projectId\}\/tracemini\/roots/);
  assert.match(component, /root_label:\s*rootLabel/);
  assert.doesNotMatch(component, /user_id:/);
  assert.match(component, /files-agent bind --code/);
  assert.match(component, /--root \/absolute\/path\/to\/project/);

  assert.match(service, /new Set\(\['device_id','root_label'\]\)/);
  assert.doesNotMatch(service, /text\(input\.user_id/);
  assert.match(service, /d\.user_id=\$\d/);
  assert.match(service, /session\.id/);
});