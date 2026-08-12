import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const serviceSource = read('lib/files-agent.ts');
const devicesRoute = read('app/api/files-agent/devices/route.ts');
const revokeRoute = read('app/api/files-agent/devices/[deviceId]/route.ts');
const ui = read('app/components/FilesAgentDownload.tsx');
const migration = read('migrations/002_files_agent.sql');

function loadService() {
  const javascript = ts.transpileModule(serviceSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === 'node:crypto') return crypto;
      if (specifier === './db') return { getPool: () => { throw new Error('database not available in schema unit test'); } };
      throw new Error(`unexpected import: ${specifier}`);
    },
    console,
    process,
    Buffer,
    Request,
    Date,
  });
  return module.exports;
}

const { normalizeFilesAgentEvents, FilesAgentError } = loadService();
const validEvent = {
  id: 7,
  run_id: 'run-1',
  agent: 'hermes',
  action: 'write',
  path: '/tmp/output.txt',
  bytes: 12,
  count: 1,
  occurred_at: new Date().toISOString(),
};

function rejects(body) {
  assert.throws(() => normalizeFilesAgentEvents(body), (error) => error instanceof FilesAgentError && error.status === 400);
}

test('files-agent ingest accepts only the exact metadata schema and constructs payload explicitly', () => {
  const [event] = normalizeFilesAgentEvents({ device_id: 'local-device-id', events: [validEvent] });
  assert.equal(event.eventId, '7');
  assert.deepEqual(JSON.parse(JSON.stringify(event.payload)), { run_id: 'run-1', agent: 'hermes', bytes: 12, count: 1 });
  assert.match(serviceSource, /const payload = \{ run_id: runId, agent, bytes, count \}/);
  assert.doesNotMatch(serviceSource, /\{\s*\.\.\.event|\{\s*\.\.\.body/);
});

test('files-agent ingest rejects unknown, nested, prohibited, and ambiguous fields', () => {
  rejects({ events: [validEvent], extra: true });
  rejects({ events: [{ ...validEvent, command: 'cat secret' }] });
  rejects({ events: [{ ...validEvent, payload: { secret: true } }] });
  rejects({ events: [{ ...validEvent, employee_email: 'other@example.com' }] });
  rejects({ events: [{ ...validEvent, event_id: 'duplicate-alias' }] });
  rejects({ events: [{ ...validEvent, captured_at: validEvent.occurred_at }] });
});

test('files-agent ingest enforces agent/action enums and bounded nonnegative integers', () => {
  for (const agent of ['hermes', 'codex', 'claude']) {
    assert.equal(normalizeFilesAgentEvents({ events: [{ ...validEvent, agent }] }).length, 1);
  }
  rejects({ events: [{ ...validEvent, agent: 'shell' }] });
  rejects({ events: [{ ...validEvent, action: 'read' }] });
  rejects({ events: [{ ...validEvent, bytes: -1 }] });
  rejects({ events: [{ ...validEvent, bytes: 1.5 }] });
  rejects({ events: [{ ...validEvent, bytes: Number.MAX_SAFE_INTEGER }] });
  rejects({ events: [{ ...validEvent, count: '1' }] });
  rejects({ events: [{ ...validEvent, count: { nested: true } }] });
});

test('device list and revoke operations are authenticated and tenant scoped', () => {
  assert.match(devicesRoute, /currentSession\(\)/);
  assert.match(devicesRoute, /listFilesAgentDevices\(session\)/);
  assert.match(serviceSource, /where d\.company_id=\$1 and \(\$2::boolean or d\.user_id=\$3\)/);
  assert.match(serviceSource, /user\.role === 'admin'/);
  assert.match(serviceSource, /d\.id=\$1 and d\.company_id=\$2/);
  assert.match(serviceSource, /\(\$3::boolean or d\.user_id=\$4\)/);
  assert.doesNotMatch(serviceSource, /from devices\b/);
});

test('device revocation has strict same-origin CSRF protection and immediately disables ingest credentials', () => {
  assert.match(revokeRoute, /req\.headers\.get\('origin'\) !== req\.nextUrl\.origin/);
  assert.match(revokeRoute, /revokeFilesAgentDevice\(session, deviceId\)/);
  assert.match(serviceSource, /set revoked_at=coalesce\(d\.revoked_at,now\(\)\)/);
  assert.match(serviceSource, /d\.revoked_at is null/);
  assert.match(serviceSource, /invalid or revoked device credential/);
});

test('files-agent UI visibly lists and revokes devices', () => {
  assert.match(ui, /Enrolled files-agent devices/);
  assert.match(ui, /\/api\/files-agent\/devices/);
  assert.match(ui, /method: 'DELETE'/);
  assert.match(ui, /Revoke device/);
  assert.match(ui, /Administrators can manage devices for their company/);
  assert.match(migration, /payload - 'run_id' - 'agent' - 'bytes' - 'count'/);
});
