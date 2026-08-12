import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

test('files-agent package build traces only its explicit runtime assets', () => {
  const root = new URL('..', import.meta.url);
  rmSync(new URL('../.next', import.meta.url), { recursive: true, force: true });
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FILES_AGENT_SOURCE_DIR: '' },
  });
  const output = `${build.stdout}\n${build.stderr}`;
  assert.equal(build.status, 0, output);
  assert.doesNotMatch(output, /whole project was traced unintentionally|Encountered unexpected file in NFT list/);

  const trace = JSON.parse(readFileSync(new URL(
    '../.next/server/app/api/files-agent/package/route.js.nft.json', import.meta.url,
  ), 'utf8'));
  const projectFiles = trace.files
    .map((name) => name.replaceAll('\\\\', '/'))
    .filter((name) => name.startsWith('../../../../../../'))
    .map((name) => name.slice('../../../../../../'.length))
    .filter((name) => name.startsWith('files-agent/'));
  assert.deepEqual(projectFiles.sort(), [
    'files-agent/README.md',
    'files-agent/files_agent.py',
    'files-agent/manifest.json',
  ]);
});