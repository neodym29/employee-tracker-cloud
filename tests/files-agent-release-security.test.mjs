import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const screenshot = read('app/api/screenshot/route.ts');
const service = read('lib/files-agent.ts');
const ingest = read('app/api/files-agent/ingest/route.ts');
const packageRoute = read('app/api/files-agent/package/route.ts');
const db = read('lib/db.ts');
const migration = read('migrations/002_files_agent.sql');

test('legacy screenshot lookup is permanently retired without touching historical storage', () => {
  assert.match(screenshot, /status:\s*410/);
  assert.match(screenshot, /permanently retired/i);
  assert.doesNotMatch(screenshot, /requireAdminSession|getPool|activity_screenshots/);
});

test('files-agent ingest honors the global telemetry pause before accepting writes', () => {
  assert.match(ingest, /telemetryPaused/);
  assert.match(ingest, /telemetry temporarily paused for reset/);
});

test('setup wipe includes files-agent data in FK-safe event, device, enrollment order', () => {
  const eventDelete = db.indexOf("deleteBatch('files_agent_events'");
  const deviceDelete = db.indexOf("deleteBatch('files_agent_devices'");
  const enrollmentDelete = db.indexOf("deleteBatch('files_agent_enrollments'");
  assert.ok(eventDelete >= 0 && deviceDelete > eventDelete && enrollmentDelete > deviceDelete);
});

test('runtime files-agent schema enforces the same named event constraints as migration', () => {
  for (const constraint of [
    'files_agent_events_event_id_check',
    'files_agent_events_action_check',
    'files_agent_events_path_check',
    'files_agent_events_payload_check',
  ]) {
    assert.match(db, new RegExp(constraint));
    assert.match(migration, new RegExp(constraint));
  }
});

test('production package generation rejects non-HTTPS public enrollment URLs', () => {
  assert.match(packageRoute, /requireSecureFilesAgentOrigin/);
  assert.match(service, /protocol !== 'https:'/);
  assert.match(service, /localhost|127\.0\.0\.1|\[::1\]/);
});

test('files-agent applies timestamp skew, enrollment/device/ingest limits, and retention cleanup', () => {
  assert.match(service, /MAX_EVENT_AGE_MS/);
  assert.match(service, /MAX_EVENT_FUTURE_SKEW_MS/);
  assert.match(service, /captured_at is outside the allowed time window/);
  assert.match(service, /enrollment_rate/);
  assert.match(service, /device_limit/);
  assert.match(service, /ingest_rate/);
  assert.match(service, /export async function cleanupFilesAgentRetention/);
  assert.match(service, /FILES_AGENT_RETENTION_DAYS/);
});

test('nontransactional cleanup migration has exactly the three required legacy company FK indexes', () => {
  const indexes = read('migrations/003_files_agent_fk_indexes_nontransactional.sql');
  const statements = indexes
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);

  assert.doesNotMatch(indexes, /\bbegin\b|\bcommit\b/i);
  assert.deepEqual(statements, [
    'create index concurrently if not exists idx_activity_events_company_id on activity_events (company_id)',
    'create index concurrently if not exists idx_activity_screenshots_company_id on activity_screenshots (company_id)',
    'create index concurrently if not exists idx_devices_company_id on devices (company_id)',
  ]);
  assert.doesNotMatch(indexes, /idx_files_agent_|on\s+files_agent_/i);
});
