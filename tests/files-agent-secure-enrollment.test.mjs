import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const db = read('lib/db.ts');
const service = read('lib/files-agent.ts');
const packageService = read('lib/files-agent-package.ts');
const enrollRoute = read('app/api/files-agent/enroll/route.ts');
const exchangeRoute = read('app/api/files-agent/exchange/route.ts');
const ingestRoute = read('app/api/files-agent/ingest/route.ts');
const packageRoute = read('app/api/files-agent/package/route.ts');
const downloadUi = read('app/components/FilesAgentDownload.tsx');

function loadPackageService() {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const filename = new URL('../lib/files-agent-package.ts', import.meta.url).pathname;
  const javascript = ts.transpileModule(packageService, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'require', 'module', '__filename', '__dirname', javascript)(
    module.exports, require, module, filename, dirname(filename),
  );
  return module.exports;
}

function unzipStoredEntries(archive) {
  const entries = new Map();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const size = archive.readUInt32LE(offset + 18);
    const nameSize = archive.readUInt16LE(offset + 26);
    const extraSize = archive.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameSize + extraSize;
    const name = archive.subarray(offset + 30, offset + 30 + nameSize).toString();
    entries.set(name, archive.subarray(dataOffset, dataOffset + size));
    offset = dataOffset + size;
  }
  return entries;
}

const routePaths = [
  'app/api/files-agent/enroll/route.ts',
  'app/api/files-agent/exchange/route.ts',
  'app/api/files-agent/ingest/route.ts',
  'app/api/files-agent/package/route.ts',
];

test('files-agent enrollment creation and package download require a live session', () => {
  assert.match(enrollRoute, /currentSession\(\)/);
  assert.match(packageRoute, /currentSession\(\)/);
  assert.match(enrollRoute, /invalid origin/);
  assert.match(packageRoute, /invalid origin/);
  assert.doesNotMatch(packageRoute, /searchParams\.get\(['"]token/);
});

test('one-time enrollment tokens and device credentials are hash-only and revocable', () => {
  assert.match(db, /files_agent_enrollments[\s\S]*token_hash text not null unique/);
  assert.match(db, /files_agent_devices[\s\S]*credential_hash text not null unique/);
  assert.match(db, /revoked_at timestamptz/);
  assert.match(service, /e\.used_at is null and e\.expires_at > now\(\)/);
  assert.match(service, /for update of e/);
  assert.match(service, /update files_agent_enrollments set used_at=now\(\)/);
  assert.match(service, /crypto\.createHash\('sha256'\)/);
  assert.doesNotMatch(db, /files_agent_enrollments[\s\S]{0,300}\btoken text/);
});

test('device authentication derives tenant identity and rejects payload overrides', () => {
  assert.match(service, /select d\.id,d\.company_id,d\.user_id/);
  assert.match(service, /d\.revoked_at is null/);
  assert.match(service, /insert into files_agent_events\(company_id,user_id,device_id/);
  assert.match(service, /IDENTITY_FIELDS/);
  assert.match(service, /must not specify identity/);
  assert.doesNotMatch(ingestRoute, /body\.employee_email|body\.company_id|body\.user_id/);
});

test('file event batches are bounded and idempotent', () => {
  assert.match(service, /MAX_EVENTS = 250/);
  assert.match(db, /unique\(device_id, event_id\)/);
  assert.match(service, /on conflict\(device_id,event_id\) do nothing/);
  assert.match(ingestRoute, /Bearer device credential required/);
});

test('package response bundles runtime files-agent source and embeds no query-string secret', () => {
  for (const path of routePaths) assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} should exist`);
  assert.match(packageService, /FILES_AGENT_SOURCE_DIR/);
  assert.match(packageService, /sourceEntries\(root\)/);
  assert.match(packageService, /RUNTIME_ASSETS = \['files_agent\.py', 'README\.md', 'manifest\.json'\]/);
  assert.doesNotMatch(packageService, /readdirSync|files-agent\.env/);
  assert.match(packageService, /enrollment\.json/);
  assert.match(packageService, /enrollment_token: token/);
  assert.match(packageRoute, /application\/zip/);
  assert.match(packageRoute, /cache-control': 'no-store, private/);
  assert.match(packageRoute, /content-disposition.*neodym-ai-files-tracker\.zip/);
  assert.doesNotMatch(packageRoute, /\?token=/);
});

test('generated installer checks prerequisites and discovers canonical approved commands before exchange', () => {
  const pythonCheck = packageService.indexOf("command -v python3");
  const straceCheck = packageService.indexOf("command -v strace");
  const commandDiscovery = packageService.indexOf('shutil.which(name)');
  const noCommandsFailure = packageService.indexOf('if not agent_commands:');
  const exchange = packageService.indexOf('urllib.request.Request(exchange_url');
  assert.ok(pythonCheck >= 0 && straceCheck > pythonCheck);
  assert.ok(commandDiscovery > straceCheck && noCommandsFailure > commandDiscovery && exchange > noCommandsFailure);
  assert.match(packageService, /resolve\(strict=True\)/);
  assert.match(packageService, /'agents': list\(agent_commands\)/);
  assert.match(packageService, /'agent_commands': agent_commands/);
  assert.match(packageService, /APPROVED_AGENT_NAMES = \['hermes', 'codex', 'claude'\]/);
});

test('generated archive has an exact asset allowlist and hardened installer', () => {
  const root = mkdtempSync(join(tmpdir(), 'files-agent-package-'));
  try {
    for (const name of ['files_agent.py', 'README.md', 'manifest.json']) writeFileSync(join(root, name), name);
    for (const name of ['.env', 'private.key', 'debug.log']) writeFileSync(join(root, name), 'must-not-ship');
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'also-secret.env'), 'must-not-ship');

    const { buildFilesAgentPackage } = loadPackageService();
    const entries = unzipStoredEntries(buildFilesAgentPackage(
      root, 'https://tracker.example', 'one-time-secret', '2030-01-01T00:00:00Z',
    ));
    assert.deepEqual([...entries.keys()].sort(), [
      'files-agent/ENROLLMENT-README.txt',
      'files-agent/README.md',
      'files-agent/enrollment.json',
      'files-agent/files_agent.py',
      'files-agent/install.sh',
      'files-agent/manifest.json',
    ]);

    const installer = entries.get('files-agent/install.sh').toString();
    const exchangeRequest = installer.indexOf('urllib.request.Request(exchange_url');
    assert.ok(installer.indexOf('command -v strace') < exchangeRequest);
    assert.ok(installer.indexOf('if not agent_commands:') < exchangeRequest);
    assert.match(installer, /'agent_commands': agent_commands/);
    assert.doesNotMatch(installer, /\?token=/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authenticated portals expose a privacy-specific files-only download', () => {
  assert.match(downloadUi, /Download AI files tracker/);
  assert.match(downloadUi, /file-change metadata only/);
  assert.match(downloadUi, /does not collect file contents/);
  assert.match(downloadUi, /method: 'POST'/);
});

void exchangeRoute;
