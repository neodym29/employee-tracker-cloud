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
  'application/x-xpinstall',
  'about:debugging#/runtime/this-firefox',
  'Load Temporary Add-on',
]) {
  assert.match(installer + manual, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Firefox add-on support should include ${expected}`);
}

assert.match(manual, /Firefox Release requires signed add-ons for permanent install/, 'manual must explain why Firefox cannot be silently/permanently installed like Chromium yet');
assert.match(manual, /Download Firefox add-on XPI/, 'manual should expose a Firefox-specific XPI download');

assert.match(db, /portalUsersSql/, 'dashboard query should define portal-approved user scope');
assert.match(db, /approval_status='approved'/, 'dashboard portal user scope should only include approved users');
assert.match(db, /enrollment_token is not null/, 'dashboard portal user scope should only include enrolled/portal-connected employees');
assert.match(db, /activity_events[\s\S]*join portal_users/, 'event feed should join portal users instead of showing stray telemetry identities');
assert.match(db, /devices[\s\S]*join portal_users/, 'device list should join portal users instead of showing stray telemetry identities');
assert.doesNotMatch(dashboard, /\.\.\.data\.users, \.\.\.data\.devices, \.\.\.data\.events/, 'user filter should not derive users from devices/events because that leaks stale telemetry identities');
assert.match(dashboard, /data\.users\.map\(rowUser\)/, 'user filter should derive choices from portal users only');
