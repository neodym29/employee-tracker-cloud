import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const installer = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');
const manual = readFileSync(new URL('../app/components/InstallManual.tsx', import.meta.url), 'utf8');
const db = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../app/dashboard/DashboardClient.tsx', import.meta.url), 'utf8');

for (const expected of [
  'firefoxExtensionManifest',
  'manifest_version: 2',
  "browser_specific_settings",
  'data_collection_permissions',
  'browsingActivity',
  'websiteActivity',
  'neodym-browser-firefox.xpi',
  "format === 'firefox-extension'",
  "format === 'firefox-signed'",
  'neodym-browser-firefox-signed.xpi',
  'application/x-xpinstall',
  "format === 'firefox-temporary'",
  'neodym-firefox-temporary.zip',
  'neodym-firefox-temporary/manifest.json',
  'about:debugging#/runtime/this-firefox',
  'Load Temporary Add-on',
  'Mozilla Add-ons has tentatively approved version 1.0.1',
]) {
  assert.match(installer + manual, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Firefox add-on support should include ${expected}`);
}

assert.match(manual, /signed AMO XPI/, 'manual must explain that permanent Firefox install should use the signed AMO XPI');
assert.match(manual, /Download signed Firefox XPI/, 'manual should expose the signed Firefox XPI for permanent installs');
assert.match(manual, /Download Firefox temporary ZIP/, 'manual should expose a Firefox temporary unpacked ZIP download');
assert.match(manual, /select the extracted <code>manifest\.json<\/code>/, 'manual should tell users to load extracted manifest.json for temporary Firefox installs');

assert.match(db, /portalUsersSql/, 'dashboard query should define portal-approved user scope');
assert.match(db, /approval_status='approved'/, 'dashboard portal user scope should only include approved users');
assert.match(db, /enrollment_token is not null/, 'dashboard portal user scope should only include enrolled/portal-connected users');
assert.doesNotMatch(db, /portalUsersSql[\s\S]*role='employee'/, 'dashboard portal user scope should include approved admins with enrollment tokens, not only employee-role users');
assert.match(db, /activity_events[\s\S]*join portal_users/, 'event feed should join portal users instead of showing stray telemetry identities');
assert.match(db, /devices[\s\S]*join portal_users/, 'device list should join portal users instead of showing stray telemetry identities');
assert.doesNotMatch(dashboard, /\.\.\.data\.users, \.\.\.data\.devices, \.\.\.data\.events/, 'user filter should not derive users from devices/events because that leaks stale telemetry identities');
assert.match(dashboard, /data\.users\.map\(rowUser\)/, 'user filter should derive choices from portal users only');
